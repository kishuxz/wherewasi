import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { analyze } from "../src/analyze.js";
import { AnthropicProvider, OpenAICompatibleProvider } from "../src/providers/index.js";
import type { CapturedState } from "../src/types.js";

/**
 * Exercises both providers against a local stub so the wire format is pinned
 * without a live key: correct endpoint, correct request shape, and every
 * failure mode degrading to an error string rather than an exception.
 */

const state: CapturedState = {
  repoPath: "/repo",
  git: {
    isRepo: true,
    branch: "fix/session-expiry",
    diff: "+if (!token) return null;",
    stagedDiff: "",
    log: "abc1234 add refresh flow",
    status: " M src/auth.ts",
    diffTruncated: false,
    stagedDiffTruncated: false,
  },
  recentFiles: [{ path: "src/auth.ts", mtime: "2026-01-15T11:55:00.000Z" }],
  note: "auth failing",
  input: null,
};

const reply = {
  summary: "You were tracking down why expired sessions still authenticate.",
  hypothesis: "The TTL comparison mixes seconds and milliseconds.",
  ruled_out: ["Clock skew"],
  working_set: ["src/auth.ts — holds the TTL comparison"],
  next_step: "Write a failing test for a 61-minute-old token.",
};

interface Captured {
  path: string;
  auth: string | undefined;
  body: any;
}

let server: Server;
let baseUrl = "";
let requests: Captured[] = [];
let respond: (res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: unknown = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* leave empty */
      }
      requests.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body,
      });
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const groqOk = (content: string) => ({
  id: "chatcmpl-stub",
  model: "openai/gpt-oss-120b",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { completion_tokens: 120 },
});

const anthropicOk = (text: string) => ({
  id: "msg_stub",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 50 },
});

const groq = (model?: string) =>
  new OpenAICompatibleProvider({
    apiKey: "gsk_test",
    baseUrl: `${baseUrl}/openai/v1`,
    model: model ?? "",
  });

const anthropic = () => {
  process.env["ANTHROPIC_BASE_URL"] = baseUrl;
  return new AnthropicProvider({ apiKey: "sk-ant-test" });
};

describe("OpenAI-compatible provider", () => {
  it("sends an OpenAI chat-completions request and parses the analysis", async () => {
    requests = [];
    respond = (res) => json(res, 200, groqOk(JSON.stringify(reply)));

    const result = await analyze(state, { provider: groq() });

    expect(result.error).toBeNull();
    expect(result.analysis).toEqual(reply);
    expect(result.model).toBe("openai/gpt-oss-120b");

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.path).toBe("/openai/v1/chat/completions");
    expect(req.auth).toBe("Bearer gsk_test");
    expect(req.body.model).toBe("openai/gpt-oss-120b");
    expect(req.body.response_format).toEqual({ type: "json_object" });
    expect(req.body.max_completion_tokens).toBeGreaterThan(0);

    // system + user, in that order — no assistant prefill.
    expect(req.body.messages).toHaveLength(2);
    expect(req.body.messages[0].role).toBe("system");
    expect(req.body.messages[0].content).toContain("EVIDENCE, NOT THE SUBJECT");
    expect(req.body.messages[1].role).toBe("user");
    expect(req.body.messages[1].content).toContain("fix/session-expiry");
  });

  it("honours a model override", async () => {
    requests = [];
    respond = (res) => json(res, 200, groqOk(JSON.stringify(reply)));
    await analyze(state, { provider: groq("llama-3.1-8b-instant") });
    expect(requests[0]!.body.model).toBe("llama-3.1-8b-instant");
  });

  it("degrades on 429 with a message that says to retry", async () => {
    respond = (res) => json(res, 429, { error: { message: "Rate limit reached for model" } });
    const result = await analyze(state, { provider: groq() });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/rate limit/i);
    expect(result.error).toMatch(/try again/i);
  });

  it("reports an auth failure distinctly", async () => {
    respond = (res) => json(res, 401, { error: { message: "Invalid API Key" } });
    const result = await analyze(state, { provider: groq() });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/key was rejected/i);
  });

  it("reports a server error without throwing", async () => {
    respond = (res) => json(res, 500, { error: { message: "internal" } });
    const result = await analyze(state, { provider: groq() });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/500/);
  });

  it("reports unparseable output without throwing", async () => {
    respond = (res) => json(res, 200, groqOk("I'm not going to answer in JSON."));
    const result = await analyze(state, { provider: groq() });
    expect(result.analysis).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("still rescues fenced JSON via the tolerant parser", async () => {
    respond = (res) => json(res, 200, groqOk("```json\n" + JSON.stringify(reply) + "\n```"));
    const result = await analyze(state, { provider: groq() });
    expect(result.analysis?.summary).toBe(reply.summary);
  });

  it("rejects a completion cut off at the token cap", async () => {
    // json_object closes the braces on a truncated answer, so this parses fine
    // and is garbage — fields split mid-string, next_step empty. Observed live.
    respond = (res) =>
      json(res, 200, {
        id: "chatcmpl-stub",
        model: "openai/gpt-oss-120b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                '{"summary":"You were debugging","working_set":["a.ts — x","next_step",":"],"next_step":""}',
            },
            finish_reason: "length",
          },
        ],
      });
    const result = await analyze(state, { provider: groq() });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/output budget/i);
  });

  it("reports an empty completion", async () => {
    respond = (res) => json(res, 200, groqOk(""));
    const result = await analyze(state, { provider: groq() });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/empty/i);
  });
});

describe("Anthropic provider", () => {
  it("sends a messages request and parses the analysis", async () => {
    requests = [];
    respond = (res) => json(res, 200, anthropicOk(JSON.stringify(reply)));

    const result = await analyze(state, { provider: anthropic() });

    expect(result.error).toBeNull();
    expect(result.analysis).toEqual(reply);

    const req = requests[0]!;
    expect(req.path).toBe("/v1/messages");
    expect(req.body.model).toBe("claude-sonnet-4-6");
    expect(req.body.system).toContain("EVIDENCE, NOT THE SUBJECT");
    // Exactly one user turn — a trailing assistant prefill is rejected on 4.6.
    expect(req.body.messages).toHaveLength(1);
    expect(req.body.messages[0].role).toBe("user");
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.top_p).toBeUndefined();
    expect(req.body.response_format).toBeUndefined();
  });

  it("degrades on 429 with a retry message", async () => {
    respond = (res) => json(res, 429, { type: "error", error: { message: "rate limited" } });
    const result = await analyze(state, { provider: anthropic() });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/rate limit/i);
    expect(result.error).toMatch(/try again/i);
  });

  it("surfaces a refusal as a clean error", async () => {
    respond = (res) =>
      json(res, 200, {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: "refusal",
        usage: { input_tokens: 10, output_tokens: 0 },
      });
    const result = await analyze(state, { provider: anthropic() });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/declined/);
  });

  it("reports unparseable output without throwing", async () => {
    respond = (res) => json(res, 200, anthropicOk("no json here"));
    const result = await analyze(state, { provider: anthropic() });
    expect(result.analysis).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

describe("no provider", () => {
  it("degrades to raw state when no key is set", async () => {
    const result = await analyze(state, { env: {} });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/WHEREWASI_API_KEY/);
  });
});
