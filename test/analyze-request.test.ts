import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { MODEL, analyze } from "../src/analyze.js";
import type { CapturedState } from "../src/types.js";

/**
 * Exercises the real SDK against a local stub so the request shape is verified
 * without a live key: correct model, no prefill turn, JSON round-trip.
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

describe("analyze against a stub server", () => {
  let server: Server;
  let requests: { path: string; headers: Record<string, unknown>; body: any }[] = [];
  let respond: (res: import("node:http").ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          headers: req.headers as Record<string, unknown>,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        respond(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    delete process.env["ANTHROPIC_BASE_URL"];
    await new Promise<void>((r) => server.close(() => r()));
  });

  const okBody = (text: string) =>
    JSON.stringify({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    });

  it("sends a well-formed request and parses the analysis", async () => {
    requests = [];
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okBody(JSON.stringify(reply)));
    };

    const result = await analyze(state, { apiKey: "sk-ant-test" });

    expect(result.error).toBeNull();
    expect(result.analysis).toEqual(reply);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.path).toBe("/v1/messages");
    expect(req.body.model).toBe("claude-sonnet-4-6");
    expect(req.body.system).toContain("INTENT and REASONING");
    expect(req.body.max_tokens).toBeGreaterThan(0);

    // Exactly one user turn — a trailing assistant prefill is rejected on 4.6.
    expect(req.body.messages).toHaveLength(1);
    expect(req.body.messages[0].role).toBe("user");
    expect(req.body.messages[0].content).toContain("fix/session-expiry");
    expect(req.body.messages.at(-1).role).not.toBe("assistant");

    // Deprecated / rejected knobs must be absent.
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.top_p).toBeUndefined();
    expect(req.body.thinking?.budget_tokens).toBeUndefined();
    expect(req.body.output_format).toBeUndefined();
  });

  it("tolerates a fenced JSON response", async () => {
    requests = [];
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okBody("```json\n" + JSON.stringify(reply) + "\n```"));
    };
    const result = await analyze(state, { apiKey: "sk-ant-test" });
    expect(result.analysis?.summary).toBe(reply.summary);
  });

  it("reports an API error instead of throwing", async () => {
    requests = [];
    respond = (res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }),
      );
    };
    const result = await analyze(state, { apiKey: "sk-ant-test" });
    expect(result.analysis).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("reports unparseable output instead of throwing", async () => {
    requests = [];
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okBody("I'm not going to answer in JSON."));
    };
    const result = await analyze(state, { apiKey: "sk-ant-test" });
    expect(result.analysis).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("surfaces a refusal as a clean error", async () => {
    requests = [];
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: "refusal",
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      );
    };
    const result = await analyze(state, { apiKey: "sk-ant-test" });
    expect(result.analysis).toBeNull();
    expect(result.error).toMatch(/declined/);
  });
});
