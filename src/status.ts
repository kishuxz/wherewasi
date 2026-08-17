import path from "node:path";
import { makePaint, relativeTime, splitWorkingSetEntry } from "./format.js";
import type { RepoSessions } from "./storage.js";
import type { Session } from "./types.js";

/** Older than this and the investigation is probably not live any more. */
export const STALE_AFTER_MS = 7 * 86_400_000;

/**
 * Words that mark a `working_set` reason as describing an obstacle rather than
 * a file that merely matters.
 *
 * This reads the reason the analysis already wrote — it does not re-derive
 * anything. The prompt puts blockers first and requires the clause to name the
 * obstacle, so the first entry whose reason reads like an obstacle is the
 * blocker. It is a heuristic over stored prose, not a separate stored field,
 * which is why it errs toward saying nothing.
 */
const BLOCKER_LANGUAGE =
  /\b(fail(s|ed|ing)?|block(s|ed|ing)?|break(s|ing)?|broken|cannot|can't|unable|missing|no longer|does not (compile|build|exist)|undefined|unresolved|error)\b/i;

export interface StatusRow {
  key: string;
  repoPath: string | null;
  repoName: string;
  exists: boolean;
  savedAt: string;
  ageMs: number;
  stale: boolean;
  branch: string;
  tag: string | null;
  summary: string;
  blocker: { path: string; reason: string } | null;
  fromSession: boolean;
  sessionCount: number;
}

/** The obstacle this investigation is stuck on, or null. */
export function blockerOf(session: Session): { path: string; reason: string } | null {
  for (const entry of session.analysis?.working_set ?? []) {
    const { path: p, reason } = splitWorkingSetEntry(entry);
    if (reason && BLOCKER_LANGUAGE.test(reason)) return { path: p, reason };
  }
  return null;
}

function firstSentence(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return (line.split(/(?<=\.)\s/)[0] ?? line).trim();
}

export function toRow(repo: RepoSessions, exists: boolean, now: number): StatusRow | null {
  const latest = repo.sessions[0];
  if (!latest) return null;

  const savedAt = latest.savedAt;
  const ageMs = Math.max(0, now - new Date(savedAt).getTime());
  const summary = latest.analysis
    ? firstSentence(latest.analysis.summary)
    : latest.note
      ? `(no analysis) ${firstSentence(latest.note)}`
      : "(no analysis)";

  return {
    key: repo.key,
    repoPath: repo.repoPath,
    // A hash bucket with no recorded path is all we can honestly call it.
    repoName: repo.repoPath ? path.basename(repo.repoPath) : `(unknown repo ${repo.key})`,
    exists,
    savedAt,
    ageMs,
    stale: ageMs > STALE_AFTER_MS,
    branch: latest.git.branch || "—",
    tag: latest.tag ?? null,
    summary,
    blocker: blockerOf(latest),
    fromSession: Boolean(latest.transcript),
    sessionCount: repo.sessions.length,
  };
}

export function formatStatus(
  rows: StatusRow[],
  opts: { now?: number; color?: boolean; all?: boolean } = {},
): string {
  const paint = makePaint(opts.color ?? false);
  const now = opts.now ?? Date.now();

  if (!rows.length) {
    return `\n  No saved context anywhere yet. Run ${paint("wherewasi pause", "cyan")} in a repo you are working in.\n\n`;
  }

  const out: string[] = [""];
  const missing = rows.filter((r) => !r.exists).length;

  for (const r of rows) {
    const bits: string[] = [relativeTime(r.savedAt, now)];
    if (r.branch !== "—") bits.push(r.branch);
    if (r.tag) bits.push(r.tag);
    if (opts.all && r.sessionCount > 1) bits.push(`${r.sessionCount} pauses`);

    const flags: string[] = [];
    if (!r.exists) flags.push(paint("directory gone", "red"));
    else if (r.stale) flags.push(paint("stale", "yellow"));
    if (r.fromSession) flags.push(paint("from session", "dim"));

    out.push(
      `  ${paint(r.repoName, "bold", "cyan")}  ${paint(bits.join(" · "), "dim")}${
        flags.length ? `  ${flags.join(" ")}` : ""
      }`,
    );
    if (r.repoPath) out.push(`    ${paint(r.repoPath, "dim")}`);
    out.push(`    ${r.summary}`);
    if (r.blocker) {
      out.push(`    ${paint("blocked:", "red")} ${r.blocker.path} — ${r.blocker.reason}`);
    }
    out.push("");
  }

  if (missing) {
    out.push(
      paint(
        `  ${missing} repo${missing === 1 ? "" : "s"} no longer exist${missing === 1 ? "s" : ""} on disk. Remove with ${"wherewasi status --prune"}.`,
        "dim",
      ),
    );
    out.push("");
  }

  return `${out.join("\n")}\n`;
}
