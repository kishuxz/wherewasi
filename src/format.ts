import { DIFF_LIMIT } from "./capture.js";
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

/**
 * Describes the mtime window the session actually used. The window stopped
 * being a fixed two hours when it was anchored to the previous pause, so the
 * heading has to read it rather than assert it. Sessions written before the
 * window was recorded carry no `window` at all.
 */
export function describeWindow(session: Session): string {
  const w = session.window;
  if (!w) return "Files touched before you paused";
  switch (w.source) {
    case "last-pause":
      return "Files touched since your previous pause";
    case "explicit": {
      // Anchored to the pause, not to now — the window is a property of when
      // the capture ran, so it must not drift each time the session is read.
      const span = relativeTime(w.from, new Date(session.savedAt).getTime());
      return span === "just now"
        ? "Files touched just before you paused"
        : `Files touched since ${span.replace(/ ago$/, "")} before you paused`;
    }
    case "fallback":
      return "Files touched in the 2 hours before you paused";
  }
}

/**
 * Names the diffs that were cut, or null if nothing was.
 *
 * Truncation is the one failure the output cannot otherwise reveal: hunks past
 * the cap were invisible to the model, so `working_set` narrows while reading
 * exactly as confident as a complete answer. A returning developer has no way
 * to tell a two-file working set that is complete from one that is missing a
 * third, so the incompleteness has to be stated rather than implied.
 */
export function truncationNotice(session: Session): string | null {
  const { diffTruncated, stagedDiffTruncated } = session.git;
  if (!diffTruncated && !stagedDiffTruncated) return null;

  const which =
    diffTruncated && stagedDiffTruncated
      ? "Both diffs were"
      : diffTruncated
        ? "The unstaged diff was"
        : "The staged diff was";

  // Raw-state sessions have no working set to qualify, so name what is
  // actually at stake there: the stored diff itself is partial.
  const consequence = session.analysis
    ? "was not analysed, so this working set may be incomplete"
    : "was not captured, so the stored diff is partial";

  return `⚠ ${which} truncated at ${DIFF_LIMIT} chars — anything past the cut ${consequence}.`;
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
  // With several investigations in one repo, which one you got back is the
  // first thing you need to know.
  const label = session.tag ? `${when} · ${branch} · ${session.tag}` : `${when} · ${branch}`;
  out.push("");
  out.push(`${paint("← where you were", "bold", "cyan")}  ${paint(label, "dim")}`);
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

    // Directly under the working set, because that is the field it qualifies.
    const cut = truncationNotice(session);
    if (cut) {
      out.push(paint(wrap(cut, 74, "  "), "yellow"));
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
    out.push(paint(`  ${describeWindow(session)}`, "bold"));
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

  // Worth saying even with no analysis: the stored diff itself is partial.
  const cut = truncationNotice(session);
  if (cut) {
    out.push(paint(wrap(cut, 74, "  "), "yellow"));
    out.push("");
  }

  const reason = session.analysisError ?? "no analysis was recorded";
  out.push(paint(`  ⚠ Raw state only — ${reason}.`, "yellow"));
  out.push(
    paint(
      "    With WHEREWASI_API_KEY set, this would instead be a three-sentence summary of",
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

/**
 * Shown after a keyless `pause`. The full block prints only on a genuine first
 * run; every later keyless pause gets the one-liner.
 *
 * The local path leads because it is the stronger claim — no key, no account,
 * nothing leaving the machine — and because pointing a first-time user at a
 * vendor signup is where onboarding loses them. The quality tradeoff is stated
 * outright rather than buried: a small local model really is worse (#26), and
 * discovering that later feels like the tool failing.
 */
export function keylessGuidance(opts: { firstRun: boolean; color?: boolean }): string {
  const paint = makePaint(opts.color ?? colorsEnabled());

  if (!opts.firstRun) {
    return `    ${paint("Raw state only. Set WHEREWASI_API_KEY, or point WHEREWASI_BASE_URL at a", "yellow")}\n${paint("    local model, to capture the reasoning too.", "yellow")}\n`;
  }

  const out = [
    `    ${paint("Saved as raw state — the files and the diff, but not the reasoning", "yellow")}`,
    `    ${paint("behind them. To get that, point wherewasi at a model:", "yellow")}`,
    "",
    `    ${paint("Fully local", "bold")} ${paint("— no key, no account, nothing leaves your machine:", "dim")}`,
    "",
    `      ${paint("ollama pull qwen2.5:7b", "cyan")}`,
    `      ${paint("export WHEREWASI_BASE_URL=http://localhost:11434/v1", "cyan")}`,
    `      ${paint("export WHEREWASI_MODEL=qwen2.5:7b", "cyan")}`,
    "",
    `    ${paint("Hosted", "bold")} ${paint("— any OpenAI-compatible endpoint; the default free tier runs a", "dim")}`,
    `    ${paint("120B model:", "dim")}`,
    "",
    `      ${paint("export WHEREWASI_API_KEY=...", "cyan")}`,
    "",
    `    ${paint("Both work. A 7B local model gives noticeably weaker analysis than a", "dim")}`,
    `    ${paint("120B hosted one, so the choice is privacy against quality.", "dim")}`,
  ];
  return `${out.join("\n")}\n`;
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
      // Automatic captures outnumber deliberate ones, so the deliberate ones
      // have to stay findable.
      auto: s.trigger === "auto",
      tag: s.tag ?? "",
    };
  });

  const w = (key: "when" | "branch" | "tag") =>
    Math.max(key.length, ...rows.map((r) => r[key].length));
  const whenW = Math.min(w("when"), 18);
  const branchW = Math.min(w("branch"), 24);

  // The column appears only once something is tagged, so an untagged history
  // looks exactly as it did before.
  const anyTag = rows.some((r) => r.tag);
  const tagW = Math.min(w("tag"), 16);

  const clip = (text: string, width: number) =>
    text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);

  const anyAuto = rows.some((r) => r.auto);
  // The marker column only exists once something is marked, so a purely
  // manual history looks exactly as it did before.
  const mark = (auto: boolean) => (anyAuto ? (auto ? `${paint("⟳", "dim")} ` : "  ") : "");

  const tagCol = (text: string, color: boolean) =>
    anyTag ? `${color ? paint(clip(text, tagW), "yellow") : paint(clip(text, tagW), "dim")}  ` : "";

  const out: string[] = [""];
  out.push(
    `  ${paint(clip("WHEN", whenW), "dim")}  ${paint(clip("BRANCH", branchW), "dim")}  ${tagCol("TAG", false)}${anyAuto ? "  " : ""}${paint("SUMMARY", "dim")}`,
  );
  for (const r of rows) {
    out.push(
      `  ${clip(r.when, whenW)}  ${paint(clip(r.branch, branchW), "cyan")}  ${tagCol(r.tag, true)}${mark(r.auto)}${clip(r.summary, 60).trimEnd()}`,
    );
  }
  if (anyAuto) {
    out.push("");
    out.push(`  ${paint("⟳ captured automatically", "dim")}`);
  }
  out.push("");
  return `${out.join("\n")}\n`;
}
