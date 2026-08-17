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
/**
 * Per reasoning entry. Reasoning is verbose and highly variable — one measured
 * window held 35 entries — so it is capped tighter than speech.
 */
export const THINKING_CHAR_LIMIT = 600;
/**
 * All turns together, ~1,375 tokens. With reasoning capped at 600 the median
 * window is 4,722 chars, so a typical session keeps all of its reasoning and
 * only the long tail gets trimmed.
 */
export const TOTAL_CHAR_LIMIT = 5500;
/**
 * Below this a user turn is an acknowledgement rather than an instruction.
 * Median turn across measured transcripts is ~100 chars; real instructions run
 * to thousands.
 */
export const SUBSTANTIVE_TURN_CHARS = 200;

export interface TranscriptTurn {
  role: "user" | "assistant";
  /**
   * `thinking` is the assistant's reasoning. It is included because that is
   * where the *why* lives, and it is the first thing dropped when the budget
   * bites — sacrificed under pressure rather than omitted by default.
   */
  kind: "text" | "thinking";
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

type Block = { type?: string; text?: string; thinking?: string };

/**
 * Splits one record into ordered entries.
 *
 * A user turn is a plain string. Tool results arrive as user records whose
 * content is an array of tool_result blocks — keeping only text and thinking
 * drops those, which is what we want. Content order is preserved so reasoning
 * stays next to the reply it produced.
 */
function entriesOf(role: "user" | "assistant", content: unknown): TranscriptTurn[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ role, kind: "text", text, truncated: false }] : [];
  }
  if (!Array.isArray(content)) return [];

  const out: TranscriptTurn[] = [];
  for (const block of content as Block[]) {
    if (block?.type === "text" && block.text?.trim()) {
      out.push({ role, kind: "text", text: block.text.trim(), truncated: false });
    } else if (block?.type === "thinking" && block.thinking?.trim()) {
      out.push({ role, kind: "thinking", text: block.thinking.trim(), truncated: false });
    }
  }
  return out;
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

    turns.push(...entriesOf(record.type, record.message?.content));
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
  opts: { maxTurns?: number; perTurn?: number; perThinking?: number; total?: number } = {},
): { turns: TranscriptTurn[]; dropped: number } {
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const perTurn = opts.perTurn ?? TURN_CHAR_LIMIT;
  const perThinking = opts.perThinking ?? THINKING_CHAR_LIMIT;
  const total = opts.total ?? TOTAL_CHAR_LIMIT;

  // The window is counted in spoken turns, not entries. Reasoning interleaved
  // with them rides along rather than consuming slots — otherwise a verbose
  // session would push out the conversation the window is meant to hold.
  const spokenAt = turns.map((t, i) => (t.kind === "text" ? i : -1)).filter((i) => i >= 0);
  const start = spokenAt.length > maxTurns ? spokenAt[spokenAt.length - maxTurns]! : 0;

  const window = turns.slice(start);
  const older = turns.slice(0, start);
  const spokenIn = window.filter((t) => t.kind === "text" && t.role === "user");

  // Back-fill the developer's own words when the window is all assistant.
  if (!spokenIn.length) {
    const lastUser = [...older].reverse().find((t) => t.kind === "text" && t.role === "user");
    if (lastUser) window.unshift(lastUser);
  }

  // A trailing "go" or "yes" is a continuation, not a statement of intent — the
  // instruction it approves is further back. Observed live: the newest user
  // turn was literally "go" while the actual task sat several turns earlier.
  const present = window.filter((t) => t.kind === "text" && t.role === "user");
  if (present.length && present.every((t) => t.text.length < SUBSTANTIVE_TURN_CHARS)) {
    const substantive = [...older]
      .reverse()
      .find(
        (t) => t.kind === "text" && t.role === "user" && t.text.length >= SUBSTANTIVE_TURN_CHARS,
      );
    if (substantive) window.unshift(substantive);
  }

  const clipped = window.map((t) => {
    const limit = t.kind === "thinking" ? perThinking : perTurn;
    const { text, truncated } = clip(t.text, limit);
    return { role: t.role, kind: t.kind, text, truncated };
  });

  const size = (list: TranscriptTurn[]) => list.reduce((n, t) => n + t.text.length, 0);

  // Reasoning is sacrificed first, oldest first, and only then whole turns.
  // Dropping a sentence the developer wrote to keep a paragraph the model
  // thought would be the wrong trade.
  let kept = clipped;
  while (size(kept) > total && kept.some((t) => t.kind === "thinking")) {
    const oldest = kept.findIndex((t) => t.kind === "thinking");
    kept = [...kept.slice(0, oldest), ...kept.slice(oldest + 1)];
  }
  while (kept.length > 1 && size(kept) > total) {
    kept = kept.slice(1);
  }

  return { turns: kept, dropped: Math.max(0, turns.length - kept.length) };
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
  opts: { home?: string; thinking?: boolean } = {},
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
  // Dropped before selection, so disabling reasoning gives the whole budget
  // back to speech rather than leaving a hole in it.
  const usable =
    opts.thinking === false ? parsed.turns.filter((t) => t.kind !== "thinking") : parsed.turns;

  // The directory name is lossy, so confirm against the cwd the records carry.
  // Without this, two repos whose paths differ only by a hyphen collide.
  if (parsed.cwd && path.resolve(parsed.cwd) !== path.resolve(repoPath)) return null;
  if (!usable.length) return null;

  const { turns, dropped } = selectTurns(usable);
  return {
    source: "claude-code",
    sessionId: parsed.sessionId,
    file,
    branch: parsed.branch,
    turns: turns.length,
    thinkingTurns: turns.filter((t) => t.kind === "thinking").length,
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
    thinkingTurns: transcript.thinkingTurns,
    droppedTurns: transcript.droppedTurns,
  };
}
