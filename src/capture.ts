import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CapturedState, GitState, RecencyWindow, RecentFile } from "./types.js";

const execFileAsync = promisify(execFile);

export const DIFF_LIMIT = 8000;
/** Only used when there is no previous pause to anchor to. */
export const FALLBACK_WINDOW_MS = 2 * 60 * 60 * 1000;
export const RECENT_FILE_LIMIT = 40;
export const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git"]);

/** A cluster this dense in this little time was not typed by a person. */
export const BURST_MIN_FILES = 15;
export const BURST_WINDOW_MS = 120_000;

/** Keeps a pathological monorepo walk from eating the 5s budget. */
const MAX_ENTRIES_SCANNED = 40_000;

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 4000,
      // `git status` and `git diff` refresh the index, which takes
      // .git/index.lock. A capture running alongside the user's own git
      // command then makes *their* command fail with "Unable to create
      // index.lock". Observed with the post-checkout hook: the detached
      // capture from one checkout collided with the next one.
      //
      // Reading state must never be able to break a write. This tells git to
      // skip anything needing that lock, at the cost of a possibly stale index
      // — which does not matter for output we only read.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout.trimEnd();
  } catch {
    // Not a repo, no commits yet, git missing — all degrade to "no data".
    return "";
  }
}

export function truncate(text: string, limit = DIFF_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n… [truncated at ${limit} chars]`,
    truncated: true,
  };
}

export async function findRepoRoot(cwd: string): Promise<string | null> {
  const root = await git(["rev-parse", "--show-toplevel"], cwd);
  return root ? path.resolve(root) : null;
}

/**
 * The `.git` directory itself, which is where hooks live. Not always
 * `<root>/.git` — worktrees and submodules put it elsewhere.
 */
export async function findGitDir(cwd: string): Promise<string | null> {
  const dir = await git(["rev-parse", "--absolute-git-dir"], cwd);
  return dir ? path.resolve(dir) : null;
}

export async function captureGit(root: string): Promise<GitState> {
  // Concurrent — this is the bulk of pause's latency budget.
  const [branch, rawDiff, rawStaged, log, status] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    git(["diff"], root),
    git(["diff", "--staged"], root),
    git(["log", "--oneline", "-10"], root),
    git(["status", "--short"], root),
  ]);

  const diff = truncate(rawDiff);
  const stagedDiff = truncate(rawStaged);

  return {
    isRepo: true,
    branch: branch || "(detached)",
    diff: diff.text,
    stagedDiff: stagedDiff.text,
    log,
    status,
    diffTruncated: diff.truncated,
    stagedDiffTruncated: stagedDiff.truncated,
  };
}

export function emptyGitState(): GitState {
  return {
    isRepo: false,
    branch: "",
    diff: "",
    stagedDiff: "",
    log: "",
    status: "",
    diffTruncated: false,
    stagedDiffTruncated: false,
  };
}

/**
 * Parses a `--since` value: `30m`, `2h`, `1d`, `45s`, or an ISO timestamp.
 * Returns the absolute instant to scan from, or null if unparseable.
 */
export function parseSince(value: string, now = Date.now()): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const relative = trimmed.match(/^(\d+(?:\.\d+)?)\s*([smhdw])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const ms: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    const scale = ms[unit];
    if (!scale || !Number.isFinite(amount)) return null;
    return new Date(now - amount * scale);
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** Paths git reports as changed, from `git status --short`. */
export function pathsFromStatus(status: string): Set<string> {
  const paths = new Set<string>();
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    // "XY path" or "XY old -> new" for renames; the destination is what exists.
    let rest = line.slice(3).trim();
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) rest = rest.slice(arrow + 4).trim();
    const unquoted = rest.replace(/^"(.*)"$/, "$1");
    if (unquoted) paths.add(unquoted);
  }
  return paths;
}

/**
 * Tags clusters of files sharing near-identical mtimes. An agent rewriting 60
 * files in eight seconds is indistinguishable from focused human attention by
 * mtime alone; this marks the cluster so the model can weight it down. Bulk
 * edits are real context, so they are tagged rather than dropped.
 */
export function markBursts(
  files: { mtimeMs: number; bulk?: boolean }[],
  opts: { minFiles?: number; windowMs?: number } = {},
): number {
  const minFiles = opts.minFiles ?? BURST_MIN_FILES;
  const windowMs = opts.windowMs ?? BURST_WINDOW_MS;
  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);

  let tagged = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end]!.mtimeMs - sorted[start]!.mtimeMs > windowMs) start++;
    if (end - start + 1 >= minFiles) {
      for (let i = start; i <= end; i++) {
        if (!sorted[i]!.bulk) {
          sorted[i]!.bulk = true;
          tagged++;
        }
      }
    }
  }
  return tagged;
}

export async function findRecentFiles(
  root: string,
  opts: {
    now?: number;
    since?: Date;
    limit?: number;
    /** paths git already reports as changed — these sort first */
    gitPaths?: Set<string>;
  } = {},
): Promise<RecentFile[]> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? RECENT_FILE_LIMIT;
  const cutoff = opts.since ? opts.since.getTime() : now - FALLBACK_WINDOW_MS;
  const gitPaths = opts.gitPaths ?? new Set<string>();

  const found: { path: string; mtimeMs: number }[] = [];
  let scanned = 0;

  async function walk(dir: string): Promise<void> {
    if (scanned > MAX_ENTRIES_SCANNED) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (scanned > MAX_ENTRIES_SCANNED) return;
      scanned++;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        subdirs.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const s = await stat(full);
        if (s.mtimeMs >= cutoff && s.mtimeMs <= now) {
          found.push({ path: full, mtimeMs: s.mtimeMs });
        }
      } catch {
        // vanished mid-walk
      }
    }

    for (const sub of subdirs) await walk(sub);
  }

  await walk(root);

  const entries = found.map((f) => {
    const rel = path.relative(root, f.path).split(path.sep).join("/");
    return { path: rel, mtimeMs: f.mtimeMs, inGit: gitPaths.has(rel), bulk: false };
  });

  // Tag bursts across everything seen, before the cap discards anything.
  markBursts(entries);

  // git-changed first: it is the time-independent signal and survives a long
  // window. Within each group, newest first.
  entries.sort((a, b) => {
    if (a.inGit !== b.inGit) return a.inGit ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });

  return entries.slice(0, limit).map((e) => ({
    path: e.path,
    mtime: new Date(e.mtimeMs).toISOString(),
    inGit: e.inGit,
    bulk: e.bulk,
  }));
}

export interface CaptureOptions {
  cwd: string;
  note?: string | null;
  input?: string | null;
  now?: number;
  /** scan files modified after this instant; defaults to a 2h fallback */
  since?: Date | null;
  sinceSource?: RecencyWindow["source"];
}

export async function captureState(opts: CaptureOptions): Promise<CapturedState> {
  const cwd = path.resolve(opts.cwd);
  const root = await findRepoRoot(cwd);
  const base = root ?? cwd;
  const now = opts.now ?? Date.now();

  const since = opts.since ?? new Date(now - FALLBACK_WINDOW_MS);
  const source: RecencyWindow["source"] = opts.since
    ? (opts.sinceSource ?? "explicit")
    : "fallback";

  // git first: its paths decide the sort order of the mtime scan.
  const git = root ? await captureGit(root) : emptyGitState();
  const gitPaths = pathsFromStatus(git.status);

  const recentFiles = await findRecentFiles(base, { now, since, gitPaths });

  return {
    repoPath: base,
    git,
    recentFiles,
    window: {
      from: since.toISOString(),
      source,
      bulkCount: recentFiles.filter((f) => f.bulk).length,
    },
    note: opts.note?.trim() ? opts.note.trim() : null,
    input: opts.input?.trim() ? opts.input : null,
  };
}
