import { describe, expect, it } from "vitest";
import { REDACTED, containsSecret, redact } from "../src/redact.js";

const syntheticGithubPat = ["ghp", "16C7e42F292c6912E7710c838347Ae178B4a"].join("_");
const syntheticGithubFineGrained = [
  "github",
  "pat",
  "11ABCDEFG0aBcDeFgHiJkL",
  "MnOpQrStUvWxYz",
].join("_");
const syntheticRepeatedGithubPat = ["ghp", "A".repeat(36)].join("_");

describe("redact", () => {
  const cases: [string, string][] = [
    [
      "Anthropic key",
      "+const client = new Anthropic({ apiKey: 'sk-ant-api03-AbCdEf0123456789xyz' });",
    ],
    ["OpenAI key", "OPENAI_KEY=sk-proj-9aZ8bY7cX6dW5eV4fU3t"],
    ["Stripe key", "const stripe = 'sk_live_51H8xKjKlMnOpQrStUvWx'"],
    ["GitHub PAT", `+  token: ${syntheticGithubPat}`],
    ["GitHub fine-grained", syntheticGithubFineGrained],
    ["AWS access key id", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"],
    ["bearer header", `headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def" }`],
    ["password assignment", "DB_PASSWORD=hunter2correcthorse"],
    ["json secret", `"client_secret": "s3cr3t-value-here"`],
    ["yaml token", "  token: gAAAAABlongopaquevalue"],
    ["api_key with spaces", "api_key = 'abcdef123456'"],
    ["API-KEY uppercase", "API-KEY: 9f8e7d6c5b4a"],
  ];

  for (const [name, line] of cases) {
    it(`redacts ${name}`, () => {
      const out = redact(line);
      expect(out).toContain(REDACTED);
      expect(containsSecret(line)).toBe(true);
      // The secret material itself must be gone.
      for (const secret of [
        "sk-ant-api03-AbCdEf0123456789xyz",
        "sk-proj-9aZ8bY7cX6dW5eV4fU3t",
        "sk_live_51H8xKjKlMnOpQrStUvWx",
        syntheticGithubPat,
        syntheticGithubFineGrained,
        "AKIAIOSFODNN7EXAMPLE",
        "eyJhbGciOiJIUzI1NiJ9.abc.def",
        "hunter2correcthorse",
        "s3cr3t-value-here",
        "gAAAAABlongopaquevalue",
        "abcdef123456",
        "9f8e7d6c5b4a",
      ]) {
        expect(out).not.toContain(secret);
      }
    });
  }

  it("redacts secrets inside a realistic diff without destroying structure", () => {
    const diff = [
      "diff --git a/src/client.ts b/src/client.ts",
      "index 1a2b3c4..5d6e7f8 100644",
      "--- a/src/client.ts",
      "+++ b/src/client.ts",
      "@@ -1,4 +1,5 @@",
      " import Anthropic from '@anthropic-ai/sdk';",
      "-const key = process.env.ANTHROPIC_API_KEY;",
      "+const key = 'sk-ant-api03-LEAKEDLEAKEDLEAKED';",
      `+const gh = '${syntheticRepeatedGithubPat}';`,
      " export const client = new Anthropic({ apiKey: key });",
    ].join("\n");

    const out = redact(diff);

    expect(out).not.toContain("sk-ant-api03-LEAKEDLEAKEDLEAKED");
    expect(out).not.toContain(syntheticRepeatedGithubPat);
    // Diff scaffolding is preserved so the model can still read the change.
    expect(out).toContain("diff --git a/src/client.ts b/src/client.ts");
    expect(out).toContain("@@ -1,4 +1,5 @@");
    expect(out.split("\n")).toHaveLength(diff.split("\n").length);
  });

  it("leaves ordinary code untouched", () => {
    const clean = [
      "export function tokenize(input: string) {",
      "  // the password field is rendered by PasswordInput",
      "  return input.split(/\\s+/);",
      "}",
    ].join("\n");
    expect(redact(clean)).toBe(clean);
    expect(containsSecret(clean)).toBe(false);
  });

  it("does not flag prose that merely mentions secrets", () => {
    const prose = "the token refresh flow is broken; password reset also fails";
    expect(redact(prose)).toBe(prose);
  });

  it("handles empty input", () => {
    expect(redact("")).toBe("");
  });
});
