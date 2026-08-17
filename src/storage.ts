import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapturedState, Session } from "./types.js";

export const APP_DIR_NAME = ".wherewasi";

/** Storage always lives under the home directory — never inside the user's repo. */
export function rootDir(home = homedir()): string {
  return path.join(home, APP_DIR_NAME);
}

/** Stable per-repo bucket: first 12 hex chars of sha256(absolute repo path). */
export function repoKey(repoPath: string): string {
  return createHash("sha256").update(path.resolve(repoPath)).digest("hex").slice(0, 12);
}

export function sessionsDir(repoPath: string, home = homedir()): string {
  return path.join(rootDir(home), "sessions", repoKey(repoPath));
}

/** ISO 8601 with `:` swapped for `-`, so the name is legal on every filesystem. */
export function fileNameFor(savedAt: string): string {
  return `${savedAt.replace(/:/g, "-")}.json`;
}

export async function saveSession(
  state: CapturedState,
  extra: Pick<Session, "analysis" | "analysisError" | "trigger" | "tag">,
  opts: { home?: string; now?: Date } = {},
): Promise<{ session: Session; file: string }> {
  const home = opts.home ?? homedir();
  const savedAt = (opts.now ?? new Date()).toISOString();
  const session: Session = { version: 1, savedAt, ...state, ...extra };

  const dir = sessionsDir(state.repoPath, home);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileNameFor(savedAt));
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  return { session, file };
}

async function listFiles(repoPath: string, home: string): Promise<string[]> {
  const dir = sessionsDir(repoPath, home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .reverse()
    .map((n) => path.join(dir, n));
}

async function readSession(file: string): Promise<Session | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Session;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export interface RepoSessions {
  /** bucket directory name — sha256(repoPath)[0..12] */
  key: string;
  /**
   * Original path, read back from the session itself. The bucket name is a
   * hash and does not reverse, so a session written before `repoPath` was
   * persisted leaves this null rather than crashing the caller.
   */
  repoPath: string | null;
  /** newest first */
  sessions: Session[];
}

/**
 * Every repo that has stored sessions. The only view that spans repos, which
 * is what "what am I in the middle of?" actually requires.
 */
export async function listRepos(
  opts: { home?: string; all?: boolean } = {},
): Promise<RepoSessions[]> {
  const home = opts.home ?? homedir();
  const root = path.join(rootDir(home), "sessions");

  let keys: string[];
  try {
    keys = await readdir(root);
  } catch {
    return [];
  }

  const repos = await Promise.all(
    keys.map(async (key): Promise<RepoSessions | null> => {
      const dir = path.join(root, key);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return null;
      }
      const files = names
        .filter((n) => n.endsWith(".json"))
        .sort()
        .reverse()
        .map((n) => path.join(dir, n));
      if (!files.length) return null;

      const wanted = opts.all ? files : files.slice(0, 1);
      const loaded = (await Promise.all(wanted.map(readSession))).filter(
        (s): s is Session => s !== null,
      );
      if (!loaded.length) return null;

      // Fall back through the loaded sessions: only the newest is read in the
      // default case, but an older one may carry the path when it does not.
      const repoPath = loaded.find((s) => s.repoPath)?.repoPath ?? null;
      return { key, repoPath, sessions: loaded };
    }),
  );

  return repos
    .filter((r): r is RepoSessions => r !== null)
    .sort((a, b) => (b.sessions[0]?.savedAt ?? "").localeCompare(a.sessions[0]?.savedAt ?? ""));
}

/** Deletes a bucket outright. Used by `status --prune`. */
export async function removeRepo(key: string, opts: { home?: string } = {}): Promise<void> {
  const dir = path.join(rootDir(opts.home ?? homedir()), "sessions", key);
  await rm(dir, { recursive: true, force: true });
}

/** Most recent first. */
export async function listSessions(
  repoPath: string,
  opts: { home?: string; limit?: number } = {},
): Promise<Session[]> {
  const files = await listFiles(repoPath, opts.home ?? homedir());
  const wanted = opts.limit ? files.slice(0, opts.limit) : files;
  const sessions = await Promise.all(wanted.map(readSession));
  return sessions.filter((s): s is Session => s !== null);
}

/**
 * True once any repo has a saved session. Distinguishes a genuine first run
 * from a keyless one, so setup guidance can print once instead of on every
 * pause — advice that reprints forever stops being read.
 */
export async function hasAnySession(home = homedir()): Promise<boolean> {
  const dir = path.join(rootDir(home), "sessions");
  let buckets: string[];
  try {
    buckets = await readdir(dir);
  } catch {
    return false;
  }
  for (const bucket of buckets) {
    try {
      const names = await readdir(path.join(dir, bucket));
      if (names.some((n) => n.endsWith(".json"))) return true;
    } catch {
      // not a directory, or unreadable — neither counts as a session
    }
  }
  return false;
}

export async function latestSession(
  repoPath: string,
  opts: { home?: string; tag?: string } = {},
): Promise<Session | null> {
  const files = await listFiles(repoPath, opts.home ?? homedir());
  for (const file of files) {
    const session = await readSession(file);
    if (!session) continue;
    if (opts.tag !== undefined && session.tag !== opts.tag) continue;
    return session;
  }
  return null;
}

/** Distinct tags in use for this repo, most recently used first. */
export async function listTags(repoPath: string, opts: { home?: string } = {}): Promise<string[]> {
  const sessions = await listSessions(repoPath, opts);
  const seen: string[] = [];
  for (const s of sessions) {
    if (s.tag && !seen.includes(s.tag)) seen.push(s.tag);
  }
  return seen;
}
