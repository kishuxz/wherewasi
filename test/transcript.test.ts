import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_TURNS,
  THINKING_CHAR_LIMIT,
  TOTAL_CHAR_LIMIT,
  TURN_CHAR_LIMIT,
  encodeProjectDir,
  findTranscript,
  parseTranscript,
  selectTurns,
  toRef,
} from "../src/transcript.js";
import { buildPrompt } from "../src/analyze.js";
import type { CapturedState } from "../src/types.js";

const REPO = "/Users/dev/projects/alpha";
const syntheticGithubToken = ["ghp", "A".repeat(36)].join("_");

/** One JSONL line, in the shape Claude Code actually writes. */
function rec(o: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: "sess-1234", cwd: REPO, ...o });
}
function userTurn(text: string, extra: Record<string, unknown> = {}): string {
  return rec({ type: "user", message: { role: "user", content: text }, ...extra });
}
function assistantTurn(text: string, extra: Record<string, unknown> = {}): string {
  return rec({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  });
}

describe("encodeProjectDir", () => {
  it("replaces separators with hyphens", () => {
    expect(encodeProjectDir("/Users/dev/projects/alpha")).toBe("-Users-dev-projects-alpha");
  });

  it("is forward-only — two different paths can encode identically", () => {
    // Which is exactly why a directory name must never be decoded back.
    expect(encodeProjectDir("/a/openloop-bench/geneva")).toBe(
      encodeProjectDir("/a/openloop/bench/geneva"),
    );
  });
});

describe("parseTranscript", () => {
  it("keeps user and assistant text", () => {
    const raw = [
      userTurn("the refresh never fires"),
      assistantTurn("Looking at the token age."),
    ].join("\n");
    const { turns } = parseTranscript(raw);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[0]!.text).toBe("the refresh never fires");
  });

  it("drops tool traffic, which is 66% of a transcript and duplicates the diff", () => {
    const raw = [
      userTurn("why is this failing"),
      rec({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", input: { cmd: "ls -la" } }] },
      }),
      rec({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "a.ts\nb.ts" }] },
      }),
    ].join("\n");
    const { turns } = parseTranscript(raw);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("why is this failing");
  });

  it("keeps thinking as its own entry, in content order", () => {
    // Reasoning is where the *why* lives, so it is carried rather than
    // dropped — and kept separate so the budget can sacrifice it first.
    const raw = rec({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "the user probably means the collector" },
          { type: "text", text: "Checking the collector." },
        ],
      },
    });
    const { turns } = parseTranscript(raw);
    expect(turns.map((t) => t.kind)).toEqual(["thinking", "text"]);
    expect(turns[0]!.text).toBe("the user probably means the collector");
    expect(turns[1]!.text).toBe("Checking the collector.");
  });

  it("keeps a reasoning-only record, which has no reply to attach to", () => {
    const raw = rec({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking whether guard still imports evaluate" },
          { type: "tool_use", input: { cmd: "grep evaluate" } },
        ],
      },
    });
    const { turns } = parseTranscript(raw);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.kind).toBe("thinking");
  });

  it("ignores subagent sidechains", () => {
    const raw = [userTurn("main thread"), userTurn("subagent chatter", { isSidechain: true })].join(
      "\n",
    );
    expect(parseTranscript(raw).turns).toHaveLength(1);
  });

  it("ignores non-conversational record types", () => {
    const raw = [
      rec({ type: "ai-title", content: "Some title" }),
      rec({ type: "pr-link", content: "https://example.test/pr/1" }),
      rec({ type: "queue-operation", operation: "enqueue" }),
      userTurn("real turn"),
    ].join("\n");
    expect(parseTranscript(raw).turns).toHaveLength(1);
  });

  it("survives a half-written final line", () => {
    // The file can be appended to while we read it.
    const raw = `${userTurn("complete")}\n{"type":"user","messa`;
    expect(parseTranscript(raw).turns).toHaveLength(1);
  });

  it("reports sessionId, branch and cwd", () => {
    const raw = userTurn("x", { gitBranch: "fix/token" });
    const p = parseTranscript(raw);
    expect(p.sessionId).toBe("sess-1234");
    expect(p.branch).toBe("fix/token");
    expect(p.cwd).toBe(REPO);
  });

  it("skips turns recorded against a different cwd", () => {
    const raw = [
      userTurn("ours"),
      rec({ type: "user", cwd: "/somewhere/else", message: { role: "user", content: "theirs" } }),
    ].join("\n");
    const { turns } = parseTranscript(raw, { repoPath: REPO });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("ours");
  });
});

describe("selectTurns", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      kind: "text" as const,
      text: `turn ${i}`,
      truncated: false,
    }));

  it("keeps the newest turns", () => {
    const { turns } = selectTurns(many(30));
    expect(turns).toHaveLength(MAX_TURNS);
    expect(turns.at(-1)!.text).toBe("turn 29");
  });

  it("clips a turn that is far too long", () => {
    const huge = [
      { role: "user" as const, kind: "text" as const, text: "x".repeat(900_000), truncated: false },
    ];
    const { turns } = selectTurns(huge);
    expect(turns[0]!.text.length).toBeLessThanOrEqual(TURN_CHAR_LIMIT + 1);
    expect(turns[0]!.truncated).toBe(true);
  });

  it("stays inside the total budget", () => {
    const fat = Array.from({ length: 8 }, () => ({
      role: "assistant" as const,
      kind: "text" as const,
      text: "y".repeat(TURN_CHAR_LIMIT),
      truncated: false,
    }));
    const { turns } = selectTurns(fat);
    const total = turns.reduce((n, t) => n + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_CHAR_LIMIT + TURN_CHAR_LIMIT);
  });

  it("reaches past an acknowledgement for the instruction it approved", () => {
    // Found live: the newest user turn was literally "go", while the actual
    // task sat several turns earlier and was the only thing worth reading.
    const instruction = "Ingest agent session transcripts. ".repeat(10);
    const turns = [
      { role: "user" as const, kind: "text" as const, text: instruction, truncated: false },
      ...Array.from({ length: 8 }, () => ({
        role: "assistant" as const,
        kind: "text" as const,
        text: "working on it",
        truncated: false,
      })),
      { role: "user" as const, kind: "text" as const, text: "go", truncated: false },
    ];
    const { turns: kept } = selectTurns(turns);
    const users = kept.filter((t) => t.role === "user").map((t) => t.text);
    expect(users).toContain("go");
    expect(users.some((t) => t.startsWith("Ingest agent session"))).toBe(true);
  });

  it("does not reach back when the window already has a real instruction", () => {
    const turns = [
      {
        role: "user" as const,
        kind: "text" as const,
        text: "an old instruction ".repeat(20),
        truncated: false,
      },
      {
        role: "user" as const,
        kind: "text" as const,
        text: "a current instruction ".repeat(20),
        truncated: false,
      },
      { role: "assistant" as const, kind: "text" as const, text: "ok", truncated: false },
    ];
    const { turns: kept } = selectTurns(turns);
    expect(kept.filter((t) => t.role === "user")).toHaveLength(2);
  });

  it("always keeps the most recent user turn, even outside the window", () => {
    // Real user messages are rare in a tool-heavy session — one measured
    // transcript had 7 among 295 user records — and state intent most directly.
    const turns = [
      {
        role: "user" as const,
        kind: "text" as const,
        text: "the refresh never fires",
        truncated: false,
      },
      ...Array.from({ length: 20 }, () => ({
        role: "assistant" as const,
        kind: "text" as const,
        text: "working on it",
        truncated: false,
      })),
    ];
    const { turns: kept } = selectTurns(turns);
    expect(kept.some((t) => t.role === "user")).toBe(true);
    expect(kept[0]!.text).toBe("the refresh never fires");
  });
});

describe("reasoning is sacrificed first", () => {
  const T = (
    kind: "text" | "thinking",
    text: string,
    role: "user" | "assistant" = "assistant",
  ) => ({
    role,
    kind,
    text,
    truncated: false,
  });

  it("drops reasoning before any spoken turn", () => {
    const turns = [
      T("text", "u".repeat(1400), "user"),
      T("thinking", "r".repeat(600)),
      T("text", "a".repeat(1400)),
      T("thinking", "r".repeat(600)),
      T("text", "b".repeat(1400)),
      T("thinking", "r".repeat(600)),
    ];
    const { turns: kept } = selectTurns(turns, { total: 4200 });
    // All three spoken turns survive; reasoning absorbs the whole cut.
    expect(kept.filter((t) => t.kind === "text")).toHaveLength(3);
    expect(kept.filter((t) => t.kind === "thinking").length).toBeLessThan(3);
  });

  it("drops the oldest reasoning first", () => {
    const turns = [
      T("thinking", "oldest-reasoning"),
      T("text", "x".repeat(1400), "user"),
      T("thinking", "newest-reasoning"),
    ];
    // 1400 + 16 + 16 = 1432; a 1420 budget forces exactly one reasoning cut.
    const { turns: kept } = selectTurns(turns, { total: 1420 });
    const reasoning = kept.filter((t) => t.kind === "thinking").map((t) => t.text);
    expect(reasoning).toEqual(["newest-reasoning"]);
  });

  it("only cuts spoken turns once no reasoning is left to give", () => {
    const turns = [
      T("text", "x".repeat(1400), "user"),
      T("text", "y".repeat(1400)),
      T("text", "z".repeat(1400)),
    ];
    const { turns: kept } = selectTurns(turns, { total: 2000 });
    expect(kept.length).toBeLessThan(3);
    expect(kept.at(-1)!.text.startsWith("z")).toBe(true);
  });

  it("caps reasoning tighter than speech", () => {
    const { turns: kept } = selectTurns([
      T("text", "s".repeat(5000), "user"),
      T("thinking", "r".repeat(5000)),
    ]);
    const spoken = kept.find((t) => t.kind === "text")!;
    const reasoning = kept.find((t) => t.kind === "thinking");
    expect(spoken.text.length).toBeGreaterThan(THINKING_CHAR_LIMIT);
    if (reasoning) expect(reasoning.text.length).toBeLessThanOrEqual(THINKING_CHAR_LIMIT + 1);
  });

  it("does not let reasoning consume window slots meant for conversation", () => {
    // 8 spoken turns with reasoning interleaved must still yield 8 spoken.
    const turns = Array.from({ length: 10 }, (_, i) => [
      T("thinking", `reasoning ${i}`),
      T("text", `spoken ${i}`, i % 2 === 0 ? "user" : "assistant"),
    ]).flat();
    const { turns: kept } = selectTurns(turns, { total: 100_000 });
    expect(kept.filter((t) => t.kind === "text")).toHaveLength(MAX_TURNS);
  });
});

describe("findTranscript", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "wherewasi-tx-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const projectDir = () => path.join(home, ".claude", "projects", encodeProjectDir(REPO));

  it("returns null when nothing is there", async () => {
    expect(await findTranscript(REPO, { home })).toBeNull();
  });

  it("reads the newest session file", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "old.jsonl"), userTurn("older investigation"), "utf8");
    await writeFile(path.join(dir, "new.jsonl"), userTurn("current investigation"), "utf8");
    const past = new Date(Date.now() - 86_400_000);
    await utimes(path.join(dir, "old.jsonl"), past, past);

    const t = await findTranscript(REPO, { home });
    expect(t?.content.at(-1)!.text).toBe("current investigation");
    expect(t?.source).toBe("claude-code");
  });

  it("refuses a directory whose records belong to another repo", async () => {
    // The hyphen encoding is lossy, so the cwd in the records is the real check.
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "s.jsonl"),
      rec({
        type: "user",
        cwd: "/Users/dev/projects/beta",
        message: { role: "user", content: "x" },
      }),
      "utf8",
    );
    expect(await findTranscript(REPO, { home })).toBeNull();
  });

  it("omits reasoning entirely when asked to", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "s.jsonl"),
      rec({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "text", text: "the visible reply" },
          ],
        },
      }),
      "utf8",
    );
    const on = (await findTranscript(REPO, { home }))!;
    expect(on.content.some((t) => t.kind === "thinking")).toBe(true);
    expect(on.thinkingTurns).toBe(1);

    const off = (await findTranscript(REPO, { home, thinking: false }))!;
    expect(off.content.some((t) => t.kind === "thinking")).toBe(false);
    expect(off.thinkingTurns).toBe(0);
    expect(JSON.stringify(off.content)).not.toContain("private reasoning");
  });

  it("returns null rather than throwing on unreadable content", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "s.jsonl"), "not json at all\n{{{", "utf8");
    expect(await findTranscript(REPO, { home })).toBeNull();
  });

  it("stores provenance only, never the turns", async () => {
    const dir = projectDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "s.jsonl"), userTurn("something private"), "utf8");
    const t = (await findTranscript(REPO, { home }))!;
    const ref = toRef(t);
    expect(Object.keys(ref).sort()).toEqual([
      "droppedTurns",
      "sessionId",
      "source",
      "thinkingTurns",
      "turns",
    ]);
    expect(JSON.stringify(ref)).not.toContain("something private");
  });
});

describe("transcript in the prompt", () => {
  const state: CapturedState = {
    repoPath: REPO,
    git: {
      isRepo: true,
      branch: "fix/token",
      diff: "+const a = 1;",
      stagedDiff: "",
      log: "",
      status: " M a.ts",
      diffTruncated: false,
      stagedDiffTruncated: false,
    },
    recentFiles: [],
    note: null,
    input: null,
  };

  const transcript = {
    source: "claude-code" as const,
    sessionId: "s1",
    file: "/x.jsonl",
    branch: null,
    turns: 2,
    thinkingTurns: 0,
    droppedTurns: 0,
    content: [
      {
        role: "user" as const,
        kind: "text" as const,
        text: "the sink token expires after an hour",
        truncated: false,
      },
      {
        role: "assistant" as const,
        kind: "text" as const,
        text: "Checking refreshSinkToken.",
        truncated: false,
      },
    ],
  };

  it("puts the session before the diff", () => {
    const prompt = buildPrompt(state, transcript);
    expect(prompt).toContain("<agent_session>");
    expect(prompt.indexOf("<agent_session>")).toBeLessThan(prompt.indexOf("<unstaged_diff>"));
  });

  it("labels who said what", () => {
    const prompt = buildPrompt(state, transcript);
    expect(prompt).toContain("DEVELOPER: the sink token expires after an hour");
    expect(prompt).toContain("ASSISTANT: Checking refreshSinkToken.");
  });

  it("omits the section entirely with no transcript", () => {
    expect(buildPrompt(state, null)).not.toContain("<agent_session>");
  });

  it("redacts secrets pasted into chat", () => {
    // People paste keys into conversations far more casually than into code.
    const leaky = {
      ...transcript,
      content: [
        {
          role: "user" as const,
          kind: "text" as const,
          text: `it 401s, my key is sk-ant-api03-LEAKEDFROMCHAT0123 and GITHUB_TOKEN=${syntheticGithubToken}`,
          truncated: false,
        },
      ],
    };
    const prompt = buildPrompt(state, leaky);
    expect(prompt).not.toContain("sk-ant-api03-LEAKEDFROMCHAT0123");
    expect(prompt).not.toContain(syntheticGithubToken);
    expect(prompt).toContain("[REDACTED]");
  });

  it("drops bulk files to pay for the transcript rather than dropping turns", () => {
    const bulky: CapturedState = {
      ...state,
      recentFiles: Array.from({ length: 40 }, (_, i) => ({
        path: `gen/g${i}.ts`,
        mtime: "2026-01-15T11:00:00.000Z",
        bulk: true,
      })),
    };
    const withSession = buildPrompt(bulky, transcript);
    const without = buildPrompt(bulky, null);

    expect(without).toContain("[bulk-edit]");
    expect(withSession).not.toContain("[bulk-edit]");
    expect(withSession).toContain("omitted");
    expect(withSession).toContain("DEVELOPER: the sink token expires after an hour");
  });
});
