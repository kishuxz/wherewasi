import { describe, expect, it } from "vitest";
import {
  formatList,
  formatResume,
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
    const out = formatResume(raw, opts);
    expect(out).toContain("WHEREWASI_API_KEY");
    expect(out).not.toContain("ANTHROPIC_API_KEY");
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
