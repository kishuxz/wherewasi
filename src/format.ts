import type { Session } from "./types.js";

const ESC = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  red: "\u001b[31m",
} as const;

export type Color = keyof Omit<typeof ESC, "reset">;

export function colorsEnabled(): boolean {
  if (process.env["NO_COLOR"]) return false;
  if (process.env["FORCE_COLOR"]) return true;
  return Boolean(process.stdout.isTTY);
}

export function makePaint(enabled = colorsEnabled()) {
  return (text: string, ...styles: Color[]): string =>
    enabled ? `${styles.map((s) => ESC[s]).join("")}${text}${ESC.reset}` : text;
}

export function relativeTime(from: string, now: number = Date.now()): string {
  const then = new Date(from).getTime();
  if (Number.isNaN(then)) return "at an unknown time";
  const secs = Math.max(0, Math.round((now - then) / 1000));

  if (secs < 45) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
  ];
  let value = secs;
  let label = "second";
  for (const [size, name] of units) {
    if (secs < size) break;
    value = Math.round(secs / size);
    label = name;
  }
  return `${value} ${label}${value === 1 ? "" : "s"} ago`;
}

/** Wraps prose at `width`, indenting continuation lines. */
export function wrap(text: string, width = 76, indent = ""): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

/**
 * Splits `src/auth.ts — validates the token` into its path and reason.
 * Falls back to treating the whole entry as a path.
 */
export function splitWorkingSetEntry(entry: string): { path: string; reason: string } {
  const match = entry.match(/^\s*[`"']?(.+?)[`"']?\s*(?:—|–|:|\s-\s)\s*(.+)$/);
  if (match?.[1] && match[2]) {
    return { path: match[1].trim(), reason: match[2].trim() };
  }
  return { path: entry.replace(/^[`"']|[`"']$/g, "").trim(), reason: "" };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim());
  return line ? line.trim() : "";
}

export function formatResume(
  session: Session,
  opts: { now?: number; color?: boolean } = {},
): string {
  const paint = makePaint(opts.color ?? colorsEnabled());
  const now = opts.now ?? Date.now();
  const out: string[] = [];

  const when = relativeTime(session.savedAt, now);
  const branch = session.git.branch || "(no branch)";
  out.push("");
  out.push(`${paint("← where you were", "bold", "cyan")}  ${paint(`${when} · ${branch}`, "dim")}`);
  out.push("");

  const a = session.analysis;

  if (a) {
    out.push(wrap(a.summary, 76, "  "));
    out.push("");

    if (a.hypothesis) {
      out.push(paint("  Hypothesis", "bold"));
      out.push(wrap(a.hypothesis, 74, "    "));
      out.push("");
    }

    if (a.ruled_out.length) {
      out.push(paint("  Already ruled out", "bold"));
      for (const item of a.ruled_out) {
        out.push(`    ${paint("✗", "red")} ${wrap(item, 70, "      ").trimStart()}`);
      }
      out.push("");
    }

    if (a.working_set.length) {
      out.push(paint("  Working set", "bold"));
      for (const entry of a.working_set) {
        const { path, reason } = splitWorkingSetEntry(entry);
        out.push(
          reason
            ? `    ${paint(path, "cyan")} ${paint("—", "dim")} ${reason}`
            : `    ${paint(path, "cyan")}`,
        );
      }
      out.push("");
    }

    if (a.next_step) {
      out.push(paint("  Next step", "bold"));
      out.push(wrap(a.next_step, 74, "    "));
      out.push("");
    }

    if (session.note) {
      out.push(paint("  Your note", "bold"));
      out.push(wrap(session.note, 74, "    "));
      out.push("");
    }
  } else {
    out.push(...formatRawState(session, paint));
  }

  return `${out.join("\n")}\n`;
}

function formatRawState(session: Session, paint: ReturnType<typeof makePaint>): string[] {
  const out: string[] = [];

  if (session.note) {
    out.push(paint("  Your note", "bold"));
    out.push(wrap(session.note, 74, "    "));
    out.push("");
  }

  if (session.git.status) {
    out.push(paint("  Working tree", "bold"));
    for (const line of session.git.status.split("\n").slice(0, 15)) {
      out.push(`    ${line}`);
    }
    out.push("");
  }

  if (session.recentFiles.length) {
    out.push(paint("  Files touched in the 2 hours before you paused", "bold"));
    for (const f of session.recentFiles) out.push(`    ${paint(f.path, "cyan")}`);
    out.push("");
  }

  if (session.git.log) {
    out.push(paint("  Recent commits", "bold"));
    for (const line of session.git.log.split("\n").slice(0, 5)) out.push(`    ${line}`);
    out.push("");
  }

  if (session.input) {
    const lines = session.input.trimEnd().split("\n");
    out.push(paint("  Captured output (tail)", "bold"));
    for (const line of lines.slice(-12)) out.push(`    ${paint(line, "dim")}`);
    out.push("");
  }

  const reason = session.analysisError ?? "no analysis was recorded";
  out.push(paint(`  ⚠ Raw state only — ${reason}.`, "yellow"));
  out.push(
    paint(
      "    With ANTHROPIC_API_KEY set, this would instead be a three-sentence summary of",
      "dim",
    ),
  );
  out.push(
    paint(
      "    what you were doing, the hypothesis you were testing, what you'd already ruled",
      "dim",
    ),
  );
  out.push(paint("    out, why each file mattered, and your next step.", "dim"));
  out.push("");

  return out;
}

export function formatList(
  sessions: Session[],
  opts: { now?: number; color?: boolean } = {},
): string {
  const paint = makePaint(opts.color ?? colorsEnabled());
  if (!sessions.length) {
    return `\n  No pauses saved for this repo yet. Run ${paint("wherewasi pause", "cyan")} before you step away.\n\n`;
  }

  const rows = sessions.map((s) => {
    const summary = s.analysis
      ? firstLine(s.analysis.summary)
      : s.note
        ? `(no analysis) ${firstLine(s.note)}`
        : "(no analysis)";
    return {
      when: relativeTime(s.savedAt, opts.now ?? Date.now()),
      branch: s.git.branch || "—",
      summary,
    };
  });

  const w = (key: "when" | "branch") => Math.max(key.length, ...rows.map((r) => r[key].length));
  const whenW = Math.min(w("when"), 18);
  const branchW = Math.min(w("branch"), 24);

  const clip = (text: string, width: number) =>
    text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);

  const out: string[] = [""];
  out.push(
    `  ${paint(clip("WHEN", whenW), "dim")}  ${paint(clip("BRANCH", branchW), "dim")}  ${paint("SUMMARY", "dim")}`,
  );
  for (const r of rows) {
    out.push(
      `  ${clip(r.when, whenW)}  ${paint(clip(r.branch, branchW), "cyan")}  ${clip(r.summary, 60).trimEnd()}`,
    );
  }
  out.push("");
  return `${out.join("\n")}\n`;
}
