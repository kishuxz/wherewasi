import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { TranscriptRef } from "./types.js";

export type { TranscriptRef };

/**
 * Reads the Claude Code session for the current repo, so the analysis can work
 * from what the developer actually said rather than only from the residue their
 * edits left behind.
 *
 * Layout, established by inspection rather than documentation:
 *
 *   ~/.claude/projects/<repo path, / replaced by ->/<session uuid>.jsonl
 */

export const PROJECTS_DIR = path.join(".claude", "projects");

/** Turns kept. Past 8 the added turns are older and cost rises sharply. */
export const MAX_TURNS = 8;
/** Per turn. Median turn is ~100 chars; one measured turn was 847,636. */
export const TURN_CHAR_LIMIT = 1500;
/** All turns together, ~1,125 tokens. Sized against the free-tier ceiling. */
export const TOTAL_CHAR_LIMIT = 4500;
/**
 * Below this a user turn is an acknowledgement rather than an instruction.
 * Median turn across measured transcripts is ~100 chars; real instructions run
 * to thousands.
 */
export const SUBSTANTIVE_TURN_CHARS = 200;

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  truncated: boolean;
}

export interface Transcript extends TranscriptRef {
  file: string;
  branch: string | null;
  content: TranscriptTurn[];
}

/**
 * Forward-only. The encoding is lossy — a path segment containing a hyphen is
 * indistinguishable from a separator once encoded — so a directory name must
 * never be decoded back into a path. Encode the known cwd and look it up.
 */
export function encodeProjectDir(repoPath: string): string {
  return path.resolve(repoPath).split(path.sep).join("-");
}

export function projectsRoot(home = homedir()): string {
  return path.join(home, PROJECTS_DIR);
}

interface RawRecord {
  type?: string;
  cwd?: string;
  sessionId?: string;
  gitBranch?: string | null;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
  // A user turn is a plain string. Tool results arrive as user records whose
  // content is an array of tool_result blocks — taking only `text` blocks
  // drops those to empty, which is what we want.
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => {
      const t = (b as { type?: unknown })?.type;
      return t === "text";
    })
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}

/**
 * Pulls conversational turns out of raw JSONL.
 *
 * Excluded on purpose: `tool_use` and `tool_result`, which are 66% of a
 * transcript by volume and are the same file contents and command output the
 * diff already carries; and `thinking`, which is the most sensitive material
 * in the file while user and assistant text already state intent directly.
 */
export function parseTranscript(
  raw: string,
  opts: { repoPath?: string } = {},
): { turns: TranscriptTurn[]; sessionId: string; branch: string | null; cwd: string | null } {
  const turns: TranscriptTurn[] = [];
  let sessionId = "";
  let branch: string | null = null;
  let cwd: string | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: RawRecord;
    try {
      record = JSON.parse(line) as RawRecord;
    } catch {
      // A transcript being written while we read it can end mid-line.
      continue;
    }

    if (record.sessionId && !sessionId) sessionId = record.sessionId;
    if (record.cwd && !cwd) cwd = record.cwd;
    if (record.gitBranch) branch = record.gitBranch;

    // Subagent conversations are a different thread of work.
    if (record.isSidechain) continue;
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (opts.repoPath && record.cwd && path.resolve(record.cwd) !== path.resolve(opts.repoPath)) {
      continue;
    }

    const text = textOf(record.message?.content);
    if (!text) continue;
    turns.push({ role: record.type, text, truncated: false });
  }

  return { turns, sessionId, branch, cwd };
}

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  // Head, not tail: a turn that states a task states it first.
  return { text: `${text.slice(0, limit)}…`, truncated: true };
}

/**
 * Applies the budget. Newest turns win, because the question is what you were
 * doing when you stopped.
 *
 * Two back-fills, both because the developer's own words are the point and
 * both found by running this against real transcripts:
 *
 * 1. If the window is all assistant text, pull in the most recent user turn.
 *    Real user messages are rare in a tool-heavy session — 7 among 295 user
 *    records in one measured transcript.
 * 2. If every user turn in the window is an acknowledgement ("go", "yes"),
 *    also pull in the most recent substantive one. The instruction being
 *    approved is what states the intent; the approval says nothing.
 */
export function selectTurns(
  turns: TranscriptTurn[],
  opts: { maxTurns?: number; perTurn?: number; total?: number } = {},
): { turns: TranscriptTurn[]; dropped: number } {
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const perTurn = opts.perTurn ?? TURN_CHAR_LIMIT;
  const total = opts.total ?? TOTAL_CHAR_LIMIT;

  const window = turns.slice(-maxTurns);
  const older = turns.slice(0, Math.max(0, turns.length - window.length));

  // Back-fill the developer's own words when the window is all assistant text.
  if (!window.some((t) => t.role === "user")) {
    const lastUser = [...older].reverse().find((t) => t.role === "user");
    if (lastUser) window.unshift(lastUser);
  }

  // A trailing "go" or "yes" is a continuation, not a statement of intent — the
  // instruction it approves is further back. Observed live: the newest user
  // turn was literally "go" while the actual task sat several turns earlier.
  const inWindow = window.filter((t) => t.role === "user");
  if (inWindow.length && inWindow.every((t) => t.text.length < SUBSTANTIVE_TURN_CHARS)) {
    const substantive = [...older]
      .reverse()
      .find((t) => t.role === "user" && t.text.length >= SUBSTANTIVE_TURN_CHARS);
    if (substantive) window.unshift(substantive);
  }

  const clipped = window.map((t) => {
    const { text, truncated } = clip(t.text, perTurn);
    return { role: t.role, text, truncated };
  });

  // Drop oldest first until the whole thing fits.
  let used = clipped.reduce((n, t) => n + t.text.length, 0);
  let start = 0;
  while (start < clipped.length - 1 && used > total) {
    used -= clipped[start]!.text.length;
    start++;
  }

  const kept = clipped.slice(start);
  return { turns: kept, dropped: turns.length - kept.length };
}

async function newestSessionFile(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith(".jsonl"));
  if (!files.length) return null;

  const stamped = await Promise.all(
    files.map(async (name) => {
      const full = path.join(dir, name);
      try {
        return { full, mtimeMs: (await stat(full)).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const usable = stamped.filter((s): s is { full: string; mtimeMs: number } => s !== null);
  if (!usable.length) return null;

  usable.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return usable[0]!.full;
}

/**
 * Locates and reads the most recent session for a repo, or null. Every failure
 * is a null rather than a throw: a missing, unreadable or malformed transcript
 * must never cost the user their capture.
 */
export async function findTranscript(
  repoPath: string,
  opts: { home?: string } = {},
): Promise<Transcript | null> {
  const dir = path.join(projectsRoot(opts.home ?? homedir()), encodeProjectDir(repoPath));
  const file = await newestSessionFile(dir);
  if (!file) return null;

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  const parsed = parseTranscript(raw, { repoPath });

  // The directory name is lossy, so confirm against the cwd the records carry.
  // Without this, two repos whose paths differ only by a hyphen collide.
  if (parsed.cwd && path.resolve(parsed.cwd) !== path.resolve(repoPath)) return null;
  if (!parsed.turns.length) return null;

  const { turns, dropped } = selectTurns(parsed.turns);
  return {
    source: "claude-code",
    sessionId: parsed.sessionId,
    file,
    branch: parsed.branch,
    turns: turns.length,
    droppedTurns: Math.max(0, dropped),
    content: turns,
  };
}

/** Strips the turns, leaving what is safe and useful to persist. */
export function toRef(transcript: Transcript): TranscriptRef {
  return {
    source: transcript.source,
    sessionId: transcript.sessionId,
    turns: transcript.turns,
    droppedTurns: transcript.droppedTurns,
  };
}
