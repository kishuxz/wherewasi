import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CapturedState, GitState, RecentFile } from "./types.js";

const execFileAsync = promisify(execFile);

export const DIFF_LIMIT = 8000;
export const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;
export const RECENT_FILE_LIMIT = 15;
export const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Keeps a pathological monorepo walk from eating the 5s budget. */
const MAX_ENTRIES_SCANNED = 40_000;

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 4000,
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

export async function findRecentFiles(
  root: string,
  opts: { now?: number; windowMs?: number; limit?: number } = {},
): Promise<RecentFile[]> {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? RECENT_WINDOW_MS;
  const limit = opts.limit ?? RECENT_FILE_LIMIT;
  const cutoff = now - windowMs;

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

  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((f) => ({
      path: path.relative(root, f.path).split(path.sep).join("/"),
      mtime: new Date(f.mtimeMs).toISOString(),
    }));
}

export interface CaptureOptions {
  cwd: string;
  note?: string | null;
  input?: string | null;
  now?: number;
}

export async function captureState(opts: CaptureOptions): Promise<CapturedState> {
  const cwd = path.resolve(opts.cwd);
  const root = await findRepoRoot(cwd);
  const base = root ?? cwd;

  const [git, recentFiles] = await Promise.all([
    root ? captureGit(root) : Promise.resolve(emptyGitState()),
    findRecentFiles(base, opts.now === undefined ? {} : { now: opts.now }),
  ]);

  return {
    repoPath: base,
    git,
    recentFiles,
    note: opts.note?.trim() ? opts.note.trim() : null,
    input: opts.input?.trim() ? opts.input : null,
  };
}
