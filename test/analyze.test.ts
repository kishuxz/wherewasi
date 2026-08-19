import { describe, expect, it } from "vitest";
import { formatResume } from "../src/format.js";
import {
  SYSTEM_PROMPT,
  analyze,
  buildPrompt,
  copiedFromPrompt,
  parseAnalysis,
} from "../src/analyze.js";
import type { CapturedState } from "../src/types.js";

const state: CapturedState = {
  repoPath: "/repo",
  git: {
    isRepo: true,
    branch: "fix/session-expiry",
    diff: "+const key = 'sk-ant-api03-SHOULDNOTLEAKAAAA';\n+if (!token) return null;",
    stagedDiff: "",
    log: "abc1234 add refresh flow",
    status: " M src/auth.ts",
    diffTruncated: false,
    stagedDiffTruncated: false,
  },
  recentFiles: [{ path: "src/auth.ts", mtime: "2026-01-15T11:55:00.000Z" }],
  note: "auth failing, GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  input: "FAIL src/auth.test.ts > rejects expired tokens",
};

describe("prompt construction", () => {
  const prompt = buildPrompt(state);

  it("includes every evidence channel", () => {
    expect(prompt).toContain("<developer_note>");
    expect(prompt).toContain("<captured_command_output>");
    expect(prompt).toContain("<branch>");
    expect(prompt).toContain("<recent_commits>");
    expect(prompt).toContain("<working_tree_status>");
    expect(prompt).toContain("<unstaged_diff>");
    expect(prompt).toContain("<recently_touched_files>");
    expect(prompt).toContain("FAIL src/auth.test.ts");
    expect(prompt).toContain("fix/session-expiry");
  });

  it("redacts secrets before anything leaves the machine", () => {
    expect(prompt).not.toContain("sk-ant-api03-SHOULDNOTLEAKAAAA");
    expect(prompt).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(prompt).toContain("[REDACTED]");
  });

  it("omits empty sections", () => {
    const bare = buildPrompt({ ...state, note: null, input: null });
    expect(bare).not.toContain("<developer_note>");
    expect(bare).not.toContain("<captured_command_output>");
  });

  it("marks a non-repo directory explicitly", () => {
    const prompt = buildPrompt({
      ...state,
      git: { ...state.git, isRepo: false, branch: "" },
    });
    expect(prompt).toContain("(not a git repository)");
  });
});

describe("parseAnalysis", () => {
  const valid = {
    summary: "You were tracking down why expired sessions still authenticate.",
    hypothesis: "The TTL comparison mixes seconds and milliseconds.",
    ruled_out: ["Clock skew"],
    working_set: ["src/auth.ts — holds the TTL comparison"],
    next_step: "Write a failing test for a 61-minute-old token.",
  };

  it("parses a bare JSON object", () => {
    expect(parseAnalysis(JSON.stringify(valid))).toEqual(valid);
  });

  it("parses JSON wrapped in a markdown fence", () => {
    expect(parseAnalysis("```json\n" + JSON.stringify(valid) + "\n```")).toEqual(valid);
  });

  it("parses JSON with surrounding prose", () => {
    expect(parseAnalysis(`Here you go:\n${JSON.stringify(valid)}\nHope that helps.`)).toEqual(
      valid,
    );
  });

  it("fills in a missing optional string field", () => {
    const result = parseAnalysis(
      JSON.stringify({ summary: "You were debugging.", next_step: "Run the tests." }),
    );
    expect(result.hypothesis).toBe("");
    expect(result.ruled_out).toEqual([]);
  });

  it("rejects wrongly-typed arrays instead of quietly salvaging them", () => {
    // Silently dropping a bad member hides that the model returned the wrong
    // shape, and half a bad answer still reaches the user as a whole one.
    expect(() => parseAnalysis(JSON.stringify({ summary: "x", ruled_out: "nope" }))).toThrow(
      /ruled_out was not an array/,
    );
    expect(() => parseAnalysis(JSON.stringify({ summary: "x", working_set: [1, "a.ts"] }))).toThrow(
      /working_set contained a non-string/,
    );
  });

  it("throws when there is no object or no summary", () => {
    expect(() => parseAnalysis("I cannot help with that.")).toThrow();
    expect(() => parseAnalysis(JSON.stringify({ hypothesis: "x" }))).toThrow(/summary/);
  });
});

describe("analyze without a key", () => {
  it("returns an error instead of throwing", async () => {
    // Explicit empty env, so an ambient key cannot make this pass or fail.
    const result = await analyze(state, { env: {} });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/WHEREWASI_API_KEY/);
    expect(result.model).toBeNull();
  });
});

describe("prompt-example contamination", () => {
  it("flags a summary lifted verbatim from the prompt's worked examples", () => {
    // Observed live: llama-3.1-8b-instant returned this exact sentence, which
    // is an illustration in the system prompt about an unrelated project.
    expect(
      copiedFromPrompt({
        summary: "You were chasing why long documents lose their last page on export.",
        hypothesis: "something original",
        ruled_out: [],
        working_set: [],
        next_step: "do a thing",
      }),
    ).toBe(true);
  });

  it("does not flag genuine analysis", () => {
    expect(
      copiedFromPrompt({
        summary: "You were investigating why the collector's sink token expires mid-run.",
        hypothesis: "You suspect refreshSinkToken only updates a timestamp.",
        ruled_out: [],
        working_set: [],
        next_step: "Update guard to import evaluateRun.",
      }),
    ).toBe(false);
  });
});

const sessionFixture = {
  version: 1 as const,
  savedAt: "2026-01-15T12:00:00.000Z",
  repoPath: "/repo",
  git: {
    isRepo: true,
    branch: "token-refresh",
    diff: "+x",
    stagedDiff: "",
    log: "",
    status: "",
    diffTruncated: false,
    stagedDiffTruncated: false,
  },
  recentFiles: [],
  note: null,
  input: null,
  analysis: {
    summary: "You were finishing a rename that broke the build.",
    hypothesis: "A missed call site still imports the old name.",
    ruled_out: [],
    working_set: [] as string[],
    next_step: "Update the missed import.",
  },
  analysisError: null,
};

describe("working_set ordering", () => {
  // The order is produced by the model, so nothing here can prove it obeys —
  // only the live runs can. What these pin are the two ways the ordering can
  // be lost after the model gets it right: the rule being deleted from the
  // prompt, and the renderer reordering what it was given.
  it("instructs ordering by cause rather than by where the failure surfaced", () => {
    expect(SYSTEM_PROMPT).toContain("ORDER BY CAUSE");
    expect(SYSTEM_PROMPT).toMatch(/file holding the cause first/i);
    expect(SYSTEM_PROMPT).toMatch(/failing test is evidence of a cause, not the cause/i);
    // The superseded rule must not linger and contradict it.
    expect(SYSTEM_PROMPT).not.toContain("Blockers first.");
  });

  it("renders the working set in the order given, without sorting it", () => {
    const causeFirst = [
      "src/core.ts — renamed evaluate to evaluateRun, which the other files still import",
      "src/guard.ts — fails to compile because it imports the old name",
      "src/guard.test.ts — the failing test that surfaced it",
    ];
    const out = formatResume(
      {
        ...sessionFixture,
        analysis: { ...sessionFixture.analysis!, working_set: causeFirst },
      },
      { now: Date.parse("2026-01-15T14:00:00.000Z"), color: false },
    );
    const positions = causeFirst.map((e) => out.indexOf(e.split(" — ")[0]!));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Alphabetical would put guard.test.ts before guard.ts; causal does not.
    expect(out.indexOf("src/guard.ts")).toBeLessThan(out.indexOf("src/guard.test.ts"));
  });
});

describe("next_step direction", () => {
  it("forbids steps that undo work already in flight", () => {
    expect(SYSTEM_PROMPT).toMatch(/CONTINUE the work, not undo it/i);
    expect(SYSTEM_PROMPT).toMatch(/reverses, re-adds, aliases or shims around/i);
    expect(SYSTEM_PROMPT).toMatch(/fastest-to-green is not the goal/i);
    // Stated generally. The prompt names renames elsewhere (summary, ruled_out)
    // and that is fine; this rule specifically must not be about them, or it
    // will not carry to migrations, deletions or API swaps.
    const rule = SYSTEM_PROMPT.slice(
      SYSTEM_PROMPT.indexOf("next_step —"),
      SYSTEM_PROMPT.indexOf("Keep the summary on the PROBLEM"),
    );
    expect(rule).toMatch(/CONTINUE the work/);
    expect(rule).not.toMatch(/\brenam/i);
    expect(rule).not.toMatch(/\bimport\b/i);
  });
});

describe("hypothesis targets the live thread", () => {
  it("no longer bars the obstacle from the hypothesis", () => {
    // This exact rule is what pushed the hypothesis onto the stale thread.
    expect(SYSTEM_PROMPT).not.toContain("never in summary or hypothesis");
    expect(SYSTEM_PROMPT).toMatch(/Address whichever is LIVE/i);
    expect(SYSTEM_PROMPT).toMatch(/say both in one sentence/i);
  });
});
