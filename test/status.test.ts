import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listRepos, removeRepo, saveSession } from "../src/storage.js";
import { STALE_AFTER_MS, blockerOf, formatStatus, toRow } from "../src/status.js";
import { tempHome } from "./helpers/fixture-repo.js";
import type { Analysis, CapturedState, Session } from "../src/types.js";

const NOW = Date.parse("2026-01-15T12:00:00.000Z");

const analysis: Analysis = {
  summary: "You were chasing why the collector's token refresh never fires.",
  hypothesis: "The token-age check compares against the wrong timestamp.",
  ruled_out: [],
  working_set: [
    "packages/guard/src/index.ts — guard build fails because core no longer exports evaluate, blocking the test run",
    "packages/collector/src/index.ts — holds the token-age check you were editing",
  ],
  next_step: "Add an export alias so guard builds again.",
};

function state(repoPath: string, over: Partial<CapturedState> = {}): CapturedState {
  return {
    repoPath,
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
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    version: 1,
    savedAt: new Date(NOW).toISOString(),
    ...state("/repos/alpha"),
    analysis,
    analysisError: null,
    ...over,
  };
}

describe("blockerOf", () => {
  it("surfaces the blocker the analysis already recorded", () => {
    const b = blockerOf(session());
    expect(b?.path).toBe("packages/guard/src/index.ts");
    expect(b?.reason).toContain("blocking the test run");
  });

  it("prefers the blocker over a merely relevant file", () => {
    // The prompt puts blockers first; this must not pick the second entry.
    expect(blockerOf(session())?.path).not.toBe("packages/collector/src/index.ts");
  });

  it("says nothing when no entry reads like an obstacle", () => {
    const calm = session({
      analysis: {
        ...analysis,
        working_set: ["src/grid.css — the breakpoint you were adjusting"],
      },
    });
    expect(blockerOf(calm)).toBeNull();
  });

  it("says nothing without an analysis", () => {
    expect(blockerOf(session({ analysis: null }))).toBeNull();
  });
});

describe("toRow", () => {
  const repo = (over: Partial<Session> = {}) => ({
    key: "abc123abc123",
    repoPath: "/repos/alpha",
    sessions: [session(over)],
  });

  it("derives name, age and staleness", () => {
    const row = toRow(repo(), true, NOW + 3 * 86_400_000)!;
    expect(row.repoName).toBe("alpha");
    expect(row.stale).toBe(false);

    const old = toRow(repo(), true, NOW + STALE_AFTER_MS + 1000)!;
    expect(old.stale).toBe(true);
  });

  it("does not invent a name for a session written without its path", () => {
    // The bucket is a hash and does not reverse.
    const row = toRow({ key: "deadbeefcafe", repoPath: null, sessions: [session()] }, false, NOW)!;
    expect(row.repoName).toBe("(unknown repo deadbeefcafe)");
    expect(row.repoPath).toBeNull();
  });

  it("falls back to the note when there is no analysis", () => {
    const row = toRow(repo({ analysis: null, note: "half-done migration" }), true, NOW)!;
    expect(row.summary).toBe("(no analysis) half-done migration");
  });

  it("reports transcript provenance", () => {
    const withTx = repo({
      transcript: { source: "claude-code", sessionId: "s1", turns: 8, droppedTurns: 2 },
    });
    expect(toRow(withTx, true, NOW)!.fromSession).toBe(true);
    expect(toRow(repo(), true, NOW)!.fromSession).toBe(false);
  });
});

describe("formatStatus", () => {
  const rows = (now: number) => [
    toRow({ key: "k1", repoPath: "/repos/alpha", sessions: [session()] }, true, now)!,
    toRow(
      {
        key: "k2",
        repoPath: "/repos/gone",
        sessions: [session({ analysis: null, note: "migration" })],
      },
      false,
      now,
    )!,
  ];

  it("marks a missing directory and points at the fix", () => {
    const out = formatStatus(rows(NOW), { now: NOW });
    expect(out).toContain("directory gone");
    expect(out).toContain("wherewasi status --prune");
  });

  it("marks stale investigations", () => {
    const out = formatStatus(rows(NOW + STALE_AFTER_MS + 1000), {
      now: NOW + STALE_AFTER_MS + 1000,
    });
    expect(out).toContain("stale");
  });

  it("shows the blocker inline", () => {
    expect(formatStatus(rows(NOW), { now: NOW })).toContain("blocked:");
  });

  it("explains itself when there is nothing saved", () => {
    expect(formatStatus([], {})).toContain("No saved context anywhere yet");
  });
});

describe("listRepos", () => {
  let home: { dir: string; cleanup: () => Promise<void> };
  beforeEach(async () => {
    home = await tempHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  const save = (repoPath: string, minute: number) =>
    saveSession(
      state(repoPath),
      { analysis, analysisError: null },
      { home: home.dir, now: new Date(`2026-01-15T12:${String(minute).padStart(2, "0")}:00.000Z`) },
    );

  it("spans repos, newest first", async () => {
    await save("/repos/alpha", 1);
    await save("/repos/beta", 5);
    const repos = await listRepos({ home: home.dir });
    expect(repos.map((r) => r.repoPath)).toEqual(["/repos/beta", "/repos/alpha"]);
  });

  it("returns only the latest per repo by default", async () => {
    await save("/repos/alpha", 1);
    await save("/repos/alpha", 2);
    const [repo] = await listRepos({ home: home.dir });
    expect(repo!.sessions).toHaveLength(1);
    expect(repo!.sessions[0]!.savedAt).toBe("2026-01-15T12:02:00.000Z");
  });

  it("returns every session with all", async () => {
    await save("/repos/alpha", 1);
    await save("/repos/alpha", 2);
    const [repo] = await listRepos({ home: home.dir, all: true });
    expect(repo!.sessions).toHaveLength(2);
  });

  it("survives a bucket holding unreadable json", async () => {
    await save("/repos/alpha", 1);
    const junk = path.join(home.dir, ".wherewasi", "sessions", "ffffffffffff");
    await mkdir(junk, { recursive: true });
    await writeFile(path.join(junk, "x.json"), "{{{ not json", "utf8");
    const repos = await listRepos({ home: home.dir });
    expect(repos.map((r) => r.repoPath)).toEqual(["/repos/alpha"]);
  });

  it("is empty rather than throwing when nothing was ever saved", async () => {
    expect(await listRepos({ home: home.dir })).toEqual([]);
  });

  it("removeRepo deletes only the named bucket", async () => {
    await save("/repos/alpha", 1);
    await save("/repos/beta", 2);
    const before = await listRepos({ home: home.dir });
    await removeRepo(before[0]!.key, { home: home.dir });
    const after = await listRepos({ home: home.dir });
    expect(after.map((r) => r.repoPath)).toEqual(["/repos/alpha"]);
  });
});
