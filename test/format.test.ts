import { describe, expect, it } from "vitest";
import {
  formatList,
  formatResume,
  keylessGuidance,
  needsKey,
  provenanceLine,
  relativeTime,
  splitWorkingSetEntry,
  truncationNotice,
  wrap,
} from "../src/format.js";
import type { Session } from "../src/types.js";

const base: Session = {
  version: 1,
  savedAt: "2026-01-15T12:00:00.000Z",
  repoPath: "/repo",
  git: {
    isRepo: true,
    branch: "fix/session-expiry",
    diff: " M src/auth.ts",
    stagedDiff: "",
    log: "abc1234 add refresh flow",
    status: " M src/auth.ts\n?? src/scratch.ts",
    diffTruncated: false,
    stagedDiffTruncated: false,
  },
  recentFiles: [{ path: "src/auth.ts", mtime: "2026-01-15T11:55:00.000Z" }],
  note: "auth failing",
  input: "FAIL src/auth.test.ts > rejects expired tokens",
  analysis: {
    summary: "You were tracking down why expired sessions still authenticate.",
    hypothesis: "The TTL comparison mixes seconds and milliseconds.",
    ruled_out: ["Clock skew — the NTP check was removed", "Cookie parsing"],
    working_set: [
      "src/auth.ts — holds the TTL comparison you were editing",
      "src/auth.test.ts — the failing test",
    ],
    next_step: "Write a failing test for a token issued 61 minutes ago.",
  },
  analysisError: null,
};

const NOW = Date.parse("2026-01-15T14:00:00.000Z");
const opts = { now: NOW, color: false };

/** ANSI control sequence introducer, built at runtime to keep it out of source. */
const CSI = `${String.fromCharCode(27)}[`;

describe("relativeTime", () => {
  it("describes recent and distant saves", () => {
    const t = (ms: number) => relativeTime(new Date(NOW - ms).toISOString(), NOW);
    expect(t(10_000)).toBe("just now");
    expect(t(60_000)).toBe("1 minute ago");
    expect(t(25 * 60_000)).toBe("25 minutes ago");
    expect(t(2 * 3600_000)).toBe("2 hours ago");
    expect(t(3 * 86400_000)).toBe("3 days ago");
    expect(t(21 * 86400_000)).toBe("3 weeks ago");
  });

  it("tolerates a malformed timestamp", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("at an unknown time");
  });
});

describe("wrap", () => {
  it("wraps and indents", () => {
    const out = wrap("one two three four five", 9, "  ");
    expect(out.split("\n").every((l) => l.startsWith("  "))).toBe(true);
    expect(out.split("\n").length).toBeGreaterThan(1);
  });
});

describe("splitWorkingSetEntry", () => {
  it("splits on an em dash", () => {
    expect(splitWorkingSetEntry("src/auth.ts — holds the TTL check")).toEqual({
      path: "src/auth.ts",
      reason: "holds the TTL check",
    });
  });

  it("splits on a colon or spaced hyphen", () => {
    expect(splitWorkingSetEntry("src/db.ts: query builder").path).toBe("src/db.ts");
    expect(splitWorkingSetEntry("src/db.ts - query builder").path).toBe("src/db.ts");
  });

  it("keeps hyphenated paths intact when there is no reason", () => {
    expect(splitWorkingSetEntry("src/my-module/index.ts")).toEqual({
      path: "src/my-module/index.ts",
      reason: "",
    });
  });

  it("strips backticks and quotes", () => {
    expect(splitWorkingSetEntry("`src/auth.ts`").path).toBe("src/auth.ts");
  });
});

describe("formatResume with an analysis", () => {
  const out = formatResume(base, opts);

  it("leads with how long ago and the branch", () => {
    expect(out).toContain("2 hours ago");
    expect(out).toContain("fix/session-expiry");
  });

  it("shows summary, hypothesis, ruled-out, working set and next step", () => {
    expect(out).toContain("expired sessions still authenticate");
    expect(out).toContain("Hypothesis");
    expect(out).toContain("seconds and milliseconds");
    expect(out).toContain("Already ruled out");
    expect(out).toContain("Clock skew");
    expect(out).toContain("Working set");
    expect(out).toContain("src/auth.ts");
    expect(out).toContain("holds the TTL comparison");
    expect(out).toContain("Next step");
    expect(out).toContain("61 minutes ago");
  });

  it("emits no ANSI codes when color is off", () => {
    expect(out).not.toContain(CSI);
  });

  it("emits ANSI codes when color is on", () => {
    expect(formatResume(base, { now: NOW, color: true })).toContain(CSI);
  });

  it("omits empty optional sections", () => {
    const trimmed = formatResume(
      { ...base, analysis: { ...base.analysis!, ruled_out: [], working_set: [] } },
      opts,
    );
    expect(trimmed).not.toContain("Already ruled out");
    expect(trimmed).not.toContain("Working set");
  });
});

describe("formatResume without an analysis", () => {
  const keyless: Session = {
    ...base,
    analysis: null,
    analysisError: "ANTHROPIC_API_KEY is not set",
    window: { from: "2026-01-15T10:00:00.000Z", source: "fallback", bulkCount: 0 },
  };
  const out = formatResume(keyless, opts);

  it("prints the raw captured state", () => {
    expect(out).toContain("Working tree");
    expect(out).toContain("?? src/scratch.ts");
    expect(out).toContain("Files touched in the 2 hours before you paused");
    expect(out).toContain("src/auth.ts");
    expect(out).toContain("Recent commits");
    expect(out).toContain("Captured output");
    expect(out).toContain("rejects expired tokens");
    expect(out).toContain("auth failing");
  });

  it("says what a key would add", () => {
    expect(out).toContain("ANTHROPIC_API_KEY is not set");
    expect(out).toContain("hypothesis you were testing");
  });
});

describe("formatList", () => {
  it("renders a table of timestamp, branch and first summary line", () => {
    const older: Session = {
      ...base,
      savedAt: "2026-01-14T12:00:00.000Z",
      git: { ...base.git, branch: "main" },
      analysis: { ...base.analysis!, summary: "You were reviewing the retry backoff." },
    };
    const out = formatList([base, older], opts);

    expect(out).toContain("WHEN");
    expect(out).toContain("BRANCH");
    expect(out).toContain("SUMMARY");
    expect(out).toContain("2 hours ago");
    expect(out).toContain("1 day ago");
    expect(out).toContain("fix/session-expiry");
    expect(out).toContain("main");
    expect(out).toContain("You were tracking down");
    expect(out).toContain("You were reviewing the retry backoff");
  });

  it("marks rows with no analysis", () => {
    const out = formatList([{ ...base, analysis: null }], opts);
    expect(out).toContain("(no analysis)");
    expect(out).toContain("auth failing");
  });

  it("explains itself when empty", () => {
    expect(formatList([], opts)).toContain("No pauses saved for this repo yet");
  });
});

describe("describeWindow", () => {
  const raw = { ...base, analysis: null };

  it("names the previous pause when the window was anchored to it", () => {
    const out = formatResume(
      { ...raw, window: { from: "2026-01-15T10:00:00.000Z", source: "last-pause", bulkCount: 0 } },
      opts,
    );
    expect(out).toContain("Files touched since your previous pause");
    expect(out).not.toContain("2 hours before you paused");
  });

  it("reports an explicit --since relative to the pause, not to now", () => {
    // savedAt is 12:00 and the window opens at 11:30, so this must read "30
    // minutes" whether the session is resumed at 14:00 or a week later.
    const session = {
      ...raw,
      window: { from: "2026-01-15T11:30:00.000Z", source: "explicit" as const, bulkCount: 0 },
    };
    expect(formatResume(session, opts)).toContain("since 30 minutes before you paused");
    expect(formatResume(session, { now: NOW + 7 * 86400_000, color: false })).toContain(
      "since 30 minutes before you paused",
    );
  });

  it("keeps the 2-hour wording only for the fallback window", () => {
    const out = formatResume(
      { ...raw, window: { from: "2026-01-15T10:00:00.000Z", source: "fallback", bulkCount: 0 } },
      opts,
    );
    expect(out).toContain("Files touched in the 2 hours before you paused");
  });

  it("stays vague for sessions written before the window was recorded", () => {
    const out = formatResume(raw, opts);
    expect(out).toContain("Files touched before you paused");
    expect(out).not.toContain("2 hours before you paused");
  });

  it("points at the current key variable, not the legacy one", () => {
    const out = formatResume(
      { ...raw, analysisError: "no API key set (WHEREWASI_API_KEY, or GROQ_API_KEY)" },
      opts,
    );
    expect(out).toContain("With WHEREWASI_API_KEY set");
  });

  it("does not offer a key when the reason for having none is unknown", () => {
    // analysisError null means nobody recorded why; guessing "missing key" is
    // how a valid key plus a bad model name sent someone to the wrong place.
    expect(formatResume(raw, opts)).not.toContain("With WHEREWASI_API_KEY set");
  });
});

describe("truncationNotice", () => {
  const cut = (diff: boolean, staged: boolean): Session => ({
    ...base,
    git: { ...base.git, diffTruncated: diff, stagedDiffTruncated: staged },
  });

  it("says nothing when neither diff was cut", () => {
    expect(truncationNotice(base)).toBeNull();
    expect(formatResume(base, opts)).not.toContain("truncated at");
  });

  it("names which diff was cut", () => {
    expect(truncationNotice(cut(true, false))).toContain("The unstaged diff was truncated");
    expect(truncationNotice(cut(false, true))).toContain("The staged diff was truncated");
    expect(truncationNotice(cut(true, true))).toContain("Both diffs were truncated");
  });

  it("names the cap so the number is not folklore", () => {
    expect(truncationNotice(cut(true, false))).toContain("8000 chars");
  });

  it("warns that the working set may be incomplete", () => {
    const out = formatResume(cut(true, false), opts);
    expect(out).toContain("this working set may be incomplete");
    // Directly under the field it qualifies, not buried at the end.
    expect(out.indexOf("Working set")).toBeLessThan(out.indexOf("may be incomplete"));
    expect(out.indexOf("may be incomplete")).toBeLessThan(out.indexOf("Next step"));
  });

  it("warns on raw state too, without claiming a working set exists", () => {
    const raw = { ...cut(true, false), analysis: null };
    const out = formatResume(raw, opts);
    expect(out).toContain("the stored diff is partial");
    expect(out).not.toContain("working set may be incomplete");
  });
});

describe("keylessGuidance", () => {
  const first = keylessGuidance({ firstRun: true, color: false });
  const later = keylessGuidance({ firstRun: false, color: false });

  it("leads with the local path on a first run", () => {
    expect(first.indexOf("Fully local")).toBeGreaterThan(-1);
    // The zero-key option must come before the one that needs an account.
    expect(first.indexOf("Fully local")).toBeLessThan(first.indexOf("Hosted"));
  });

  it("gives a runnable local setup, not a pointer to docs", () => {
    expect(first).toContain("ollama pull qwen2.5:7b");
    expect(first).toContain("WHEREWASI_BASE_URL=http://localhost:11434/v1");
    expect(first).toContain("WHEREWASI_MODEL=qwen2.5:7b");
  });

  it("states the quality tradeoff rather than implying local is strictly better", () => {
    expect(first).toContain("privacy against quality");
    expect(first).toContain("weaker analysis");
  });

  it("stays terse after the first run", () => {
    expect(later).not.toContain("ollama pull");
    expect(later).toContain("WHEREWASI_API_KEY");
    expect(later.split("\n").length).toBeLessThan(first.split("\n").length);
  });

  it("never claims a key is required", () => {
    for (const text of [first, later]) {
      expect(text).not.toMatch(/requires? (an )?API key/i);
    }
  });
});

describe("tags in output", () => {
  const tagged = (tag: string, over: Partial<Session> = {}): Session => ({ ...base, tag, ...over });

  it("names the tag in the resume header", () => {
    expect(formatResume(tagged("token-refresh"), opts)).toContain(
      "2 hours ago · fix/session-expiry · token-refresh",
    );
  });

  it("leaves the header alone when untagged", () => {
    const out = formatResume(base, opts);
    expect(out).toContain("2 hours ago · fix/session-expiry");
    expect(out).not.toContain(" ·  ");
  });

  it("shows a TAG column in list once anything is tagged", () => {
    const out = formatList([tagged("token-refresh"), base], opts);
    expect(out).toContain("TAG");
    expect(out).toContain("token-refresh");
  });

  it("omits the TAG column entirely when nothing is tagged", () => {
    expect(formatList([base], opts)).not.toContain("TAG");
  });
});

describe("provenance", () => {
  const withSession: Session = {
    ...base,
    transcript: {
      source: "claude-code",
      sessionId: "abc12345",
      turns: 6,
      thinkingTurns: 0,
      droppedTurns: 0,
    },
  };

  it("says when the analysis came from an agent session", () => {
    expect(provenanceLine(withSession)).toBe(
      "reconstructed from your Claude Code session — 6 turn(s)",
    );
    expect(formatResume(withSession, opts)).toContain(
      "reconstructed from your Claude Code session",
    );
  });

  it("says when there was no session to read", () => {
    // base carries a diff and piped output, so both are named.
    expect(provenanceLine(base)).toBe("inferred from the diff and the output you piped in");
    expect(formatResume(base, opts)).toContain("inferred from the diff");
  });

  it("admits when older turns were dropped for budget", () => {
    const trimmed = {
      ...withSession,
      transcript: { ...withSession.transcript!, droppedTurns: 14 },
    };
    expect(provenanceLine(trimmed)).toContain("14 older turn(s) not read");
  });

  it("stays quiet on raw-state sessions, which have no analysis to qualify", () => {
    const raw = { ...withSession, analysis: null };
    expect(formatResume(raw, opts)).not.toContain("reconstructed from");
  });
});

describe("provenance names what was actually read", () => {
  const bare = (over: Partial<Session["git"]> = {}, rest: Partial<Session> = {}): Session => ({
    ...base,
    git: { ...base.git, diff: "", stagedDiff: "", status: "", ...over },
    input: null,
    recentFiles: [],
    ...rest,
  });

  it("does not claim a diff when there is none", () => {
    // The whole point of the line is to say how much it had to work with.
    const clean = bare({ status: " M src/a.ts" });
    expect(provenanceLine(clean)).not.toContain("the diff");
    expect(provenanceLine(clean)).toBe("inferred from the working tree");
  });

  it("names the diff when there is one", () => {
    expect(provenanceLine(bare({ diff: "+const a = 1;" }))).toBe("inferred from the diff");
    expect(provenanceLine(bare({ stagedDiff: "+const a = 1;" }))).toBe("inferred from the diff");
  });

  it("names piped output, and both together", () => {
    expect(provenanceLine(bare({}, { input: "FAIL src/a.test.ts" }))).toBe(
      "inferred from the output you piped in",
    );
    expect(provenanceLine(bare({ diff: "+x" }, { input: "FAIL" }))).toBe(
      "inferred from the diff and the output you piped in",
    );
  });

  it("falls back to the files that were open", () => {
    const only = bare({}, { recentFiles: [{ path: "src/a.ts", mtime: base.savedAt }] });
    expect(provenanceLine(only)).toBe("inferred from the files you had open");
  });

  it("admits when there was almost nothing", () => {
    expect(provenanceLine(bare())).toContain("almost nothing");
  });
});

describe("the failure message reflects the actual failure", () => {
  const failed = (reason: string): Session => ({ ...base, analysis: null, analysisError: reason });

  it("offers the key only when the key was the problem", () => {
    expect(
      needsKey("no API key set (WHEREWASI_API_KEY, or GROQ_API_KEY for the default endpoint)"),
    ).toBe(true);
    expect(
      needsKey("Anthropic selected but neither WHEREWASI_API_KEY nor ANTHROPIC_API_KEY is set"),
    ).toBe(true);
  });

  it("does not blame the key for an unrelated failure", () => {
    for (const reason of [
      "404 model `openai/gpt-oss-120x` does not exist or you do not have access to it",
      "rate limit reached — state saved without analysis; try again in a minute",
      "openai/gpt-oss-120b returned an unusable analysis — next_step was empty",
    ]) {
      expect(needsKey(reason)).toBe(false);
    }
  });

  it("prints the error without telling the user to set a key they already set", () => {
    const out = formatResume(failed("404 model `openai/gpt-oss-120x` does not exist"), opts);
    expect(out).toContain("does not exist");
    expect(out).not.toContain("With WHEREWASI_API_KEY set");
    expect(out).toContain("The endpoint was reached");
  });

  it("still offers the key when the key really is missing", () => {
    const out = formatResume(failed("no API key set (WHEREWASI_API_KEY, or GROQ_API_KEY)"), opts);
    expect(out).toContain("With WHEREWASI_API_KEY set");
  });
});
