import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, parseAnalysis, validateAnalysis } from "../src/analyze.js";
import type { Analysis, CapturedState } from "../src/types.js";
import type { Provider } from "../src/providers/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The real thing, captured from an evaluation run against gpt-oss-120b — not
 * an approximation of it. The model serialised the tail of `working_set` into
 * its first element and left `next_step` empty, and every existing guard
 * passed it.
 */
const CAPTURED = JSON.parse(
  readFileSync(path.join(here, "fixtures", "malformed-analysis.json"), "utf8"),
) as Analysis;

const good: Analysis = {
  summary: "You were chasing why the collector's token refresh never fires.",
  hypothesis: "refreshSinkToken only bumps the timestamp without fetching a token.",
  ruled_out: [],
  working_set: [
    "packages/collector/src/index.ts — holds the token-age check you were editing",
    "packages/guard/src/index.ts — fails to build, blocking the test run",
  ],
  next_step: "Implement refreshSinkToken so it actually requests a new token.",
};

describe("the captured failure", () => {
  it("is the payload that got through every existing guard", () => {
    // Guard against the fixture silently drifting into something easier.
    expect(CAPTURED.working_set[0]).toContain('","');
    expect(CAPTURED.working_set[0]!.length).toBeGreaterThan(300);
    expect(CAPTURED.next_step).toBe("");
  });

  it("is rejected", () => {
    const reason = validateAnalysis(CAPTURED);
    expect(reason).not.toBeNull();
    // next_step is checked first, and is the plainest thing wrong with it.
    expect(reason).toContain("next_step");
  });

  it("is still rejected once the empty next_step is filled in", () => {
    // The double-encoding is the real defect; an empty next_step is a symptom.
    const patched = { ...CAPTURED, next_step: "Run the tests." };
    expect(validateAnalysis(patched)).toContain("JSON fragment");
  });
});

describe("validateAnalysis", () => {
  it("accepts a coherent analysis", () => {
    expect(validateAnalysis(good)).toBeNull();
  });

  it("accepts an empty ruled_out, which is the common correct answer", () => {
    expect(validateAnalysis({ ...good, ruled_out: [] })).toBeNull();
  });

  it("accepts an empty working_set", () => {
    expect(validateAnalysis({ ...good, working_set: [] })).toBeNull();
  });

  for (const field of ["summary", "hypothesis", "next_step"] as const) {
    it(`rejects an empty ${field}`, () => {
      expect(validateAnalysis({ ...good, [field]: "" })).toContain(field);
      expect(validateAnalysis({ ...good, [field]: "   \n " })).toContain(field);
    });
  }

  it("rejects a JSON fragment in an entry", () => {
    for (const bad of ['a.ts — x","b.ts — y', 'a.ts — x"]', 'a.ts — x":"y', 'a.ts — x\\"y']) {
      expect(validateAnalysis({ ...good, working_set: [bad] })).toContain("JSON fragment");
    }
  });

  it("rejects a glob, which resume --open cannot open", () => {
    expect(validateAnalysis({ ...good, working_set: ["packages/**/*.ts — everything"] })).toContain(
      "glob",
    );
  });

  it("rejects an absurdly long path", () => {
    const long = `${"a".repeat(250)} — reason`;
    expect(validateAnalysis({ ...good, working_set: [long] })).toContain(
      "prose rather than a file",
    );
  });

  it("rejects prose where a path belongs", () => {
    const prose = "then run the full test suite to confirm all passes";
    expect(validateAnalysis({ ...good, working_set: [prose] })).toContain("prose where a path");
  });

  it("keeps accepting paths that only look unusual", () => {
    // These are real and must not be collateral damage.
    for (const ok of [
      "Makefile — the build entrypoint",
      "Dockerfile",
      "packages/core/src/index.ts — exports evaluateRun",
      "src/my-module/index.ts",
      ".github/workflows/ci.yml — the failing job",
      "a/b/file with space.ts — still a real path",
    ]) {
      expect(validateAnalysis({ ...good, working_set: [ok] })).toBeNull();
    }
  });
});

describe("parseAnalysis strictness", () => {
  it("rejects a non-string ruled_out member rather than dropping it", () => {
    const raw = JSON.stringify({ ...good, ruled_out: ["clock skew", { reason: "nope" }] });
    expect(() => parseAnalysis(raw)).toThrow(/ruled_out contained a non-string/);
  });

  it("rejects a non-string working_set member", () => {
    const raw = JSON.stringify({ ...good, working_set: ["a.ts — x", 42] });
    expect(() => parseAnalysis(raw)).toThrow(/working_set contained a non-string/);
  });

  it("rejects a ruled_out that is not an array at all", () => {
    const raw = JSON.stringify({ ...good, ruled_out: "clock skew" });
    expect(() => parseAnalysis(raw)).toThrow(/ruled_out was not an array/);
  });

  it("still tolerates a missing optional array", () => {
    const raw = JSON.stringify({ ...good, ruled_out: undefined });
    expect(parseAnalysis(raw).ruled_out).toEqual([]);
  });
});

describe("degradation", () => {
  const state: CapturedState = {
    repoPath: "/repo",
    git: {
      isRepo: true,
      branch: "main",
      diff: "",
      stagedDiff: "",
      log: "",
      status: "",
      diffTruncated: false,
      stagedDiffTruncated: false,
    },
    recentFiles: [],
    note: null,
    input: null,
  };

  const providerReturning = (payload: unknown): Provider => ({
    name: "openai-compatible",
    model: "stub-model",
    complete: async () => ({ text: JSON.stringify(payload), model: "stub-model" }),
  });

  it("stores no analysis and names the reason, like the other guards", async () => {
    const result = await analyze(state, { provider: providerReturning(CAPTURED) });
    expect(result.analysis).toBeNull();
    expect(result.error).toContain("unusable analysis");
    expect(result.error).toContain("stub-model");
  });

  it("lets a coherent analysis straight through", async () => {
    const result = await analyze(state, { provider: providerReturning(good) });
    expect(result.analysis).toEqual(good);
    expect(result.error).toBeNull();
  });
});
