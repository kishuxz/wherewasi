import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  extra: Pick<Session, "analysis" | "analysisError">,
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

export async function latestSession(
  repoPath: string,
  opts: { home?: string } = {},
): Promise<Session | null> {
  const files = await listFiles(repoPath, opts.home ?? homedir());
  for (const file of files) {
    const session = await readSession(file);
    if (session) return session;
  }
  return null;
}
