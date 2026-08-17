import { describe, expect, it } from "vitest";
import { analyze, buildPrompt, copiedFromPrompt, parseAnalysis } from "../src/analyze.js";
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
    expect(prompt).toContain("<files_modified_in_last_2_hours>");
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

  it("coerces missing or wrongly-typed optional fields", () => {
    const result = parseAnalysis(
      JSON.stringify({
        summary: "You were debugging.",
        ruled_out: "nope",
        working_set: [1, "a.ts"],
      }),
    );
    expect(result.hypothesis).toBe("");
    expect(result.ruled_out).toEqual([]);
    expect(result.working_set).toEqual(["a.ts"]);
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
