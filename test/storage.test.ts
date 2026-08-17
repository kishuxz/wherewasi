import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  fileNameFor,
  hasAnySession,
  latestSession,
  listTags,
  listSessions,
  repoKey,
  sessionsDir,
  saveSession,
} from "../src/storage.js";
import { tempHome } from "./helpers/fixture-repo.js";
import type { Analysis, CapturedState } from "../src/types.js";

const analysis: Analysis = {
  summary: "You were chasing a session-expiry bug in the auth middleware.",
  hypothesis: "The refresh token TTL is compared in seconds against a ms timestamp.",
  ruled_out: ["Clock skew — you deleted the NTP check"],
  working_set: ["src/auth.ts — where the TTL comparison happens"],
  next_step: "Add a failing test for a token issued 61 minutes ago.",
};

function state(repoPath: string, overrides: Partial<CapturedState> = {}): CapturedState {
  return {
    repoPath,
    git: {
      isRepo: true,
      branch: "fix/session-expiry",
      diff: "diff --git a/src/auth.ts",
      stagedDiff: "",
      log: "abc1234 flip verify",
      status: " M src/auth.ts",
      diffTruncated: false,
      stagedDiffTruncated: false,
    },
    recentFiles: [{ path: "src/auth.ts", mtime: "2026-01-15T11:55:00.000Z" }],
    note: "auth failing",
    input: null,
    ...overrides,
  };
}

describe("storage layer", () => {
  let home: { dir: string; cleanup: () => Promise<void> };
  const repoA = "/Users/dev/projects/alpha";
  const repoB = "/Users/dev/projects/beta";

  beforeEach(async () => {
    home = await tempHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it("derives a stable 12-char key from the repo path", () => {
    expect(repoKey(repoA)).toHaveLength(12);
    expect(repoKey(repoA)).toMatch(/^[0-9a-f]{12}$/);
    expect(repoKey(repoA)).toBe(repoKey(repoA));
    expect(repoKey(repoA)).not.toBe(repoKey(repoB));
    // Trailing separators must not fork the bucket.
    expect(repoKey(`${repoA}/`)).toBe(repoKey(repoA));
  });

  it("writes under ~/.wherewasi/sessions/<key>/ and never into the repo", async () => {
    const { file } = await saveSession(
      state(repoA),
      { analysis, analysisError: null },
      { home: home.dir, now: new Date("2026-01-15T12:00:00.000Z") },
    );

    expect(file.startsWith(home.dir)).toBe(true);
    expect(file.startsWith(repoA)).toBe(false);
    expect(path.dirname(file)).toBe(sessionsDir(repoA, home.dir));
    expect(path.basename(file)).toBe("2026-01-15T12-00-00.000Z.json");
  });

  it("round-trips a session losslessly", async () => {
    const { session } = await saveSession(
      state(repoA),
      { analysis, analysisError: null },
      { home: home.dir, now: new Date("2026-01-15T12:00:00.000Z") },
    );

    const [loaded] = await listSessions(repoA, { home: home.dir });
    expect(loaded).toEqual(session);
    expect(loaded?.version).toBe(1);
    expect(loaded?.savedAt).toBe("2026-01-15T12:00:00.000Z");
    expect(loaded?.analysis?.summary).toBe(analysis.summary);
  });

  it("stores keyless pauses with the reason recorded", async () => {
    await saveSession(
      state(repoA),
      { analysis: null, analysisError: "ANTHROPIC_API_KEY is not set" },
      { home: home.dir, now: new Date("2026-01-15T12:00:00.000Z") },
    );

    const latest = await latestSession(repoA, { home: home.dir });
    expect(latest?.analysis).toBeNull();
    expect(latest?.analysisError).toBe("ANTHROPIC_API_KEY is not set");
    // The raw state survives regardless.
    expect(latest?.git.diff).toContain("src/auth.ts");
    expect(latest?.recentFiles).toHaveLength(1);
    expect(latest?.note).toBe("auth failing");
  });

  it("returns sessions newest-first and picks the newest on resume", async () => {
    const times = [
      "2026-01-15T09:00:00.000Z",
      "2026-01-15T12:00:00.000Z",
      "2026-01-15T10:30:00.000Z",
    ];
    for (const t of times) {
      await saveSession(
        state(repoA, { note: t }),
        { analysis: null, analysisError: null },
        { home: home.dir, now: new Date(t) },
      );
    }

    const sessions = await listSessions(repoA, { home: home.dir });
    expect(sessions.map((s) => s.savedAt)).toEqual([
      "2026-01-15T12:00:00.000Z",
      "2026-01-15T10:30:00.000Z",
      "2026-01-15T09:00:00.000Z",
    ]);
    expect((await latestSession(repoA, { home: home.dir }))?.savedAt).toBe(
      "2026-01-15T12:00:00.000Z",
    );
  });

  it("honours the list limit", async () => {
    for (let i = 0; i < 5; i++) {
      await saveSession(
        state(repoA),
        { analysis: null, analysisError: null },
        { home: home.dir, now: new Date(Date.UTC(2026, 0, 15, 8 + i)) },
      );
    }
    expect(await listSessions(repoA, { home: home.dir, limit: 3 })).toHaveLength(3);
  });

  it("keeps repos in separate buckets", async () => {
    await saveSession(state(repoA), { analysis: null, analysisError: null }, { home: home.dir });
    expect(await listSessions(repoB, { home: home.dir })).toEqual([]);
    expect(await latestSession(repoB, { home: home.dir })).toBeNull();
  });

  it("returns empty results for a repo that has never been paused", async () => {
    expect(await listSessions(repoA, { home: home.dir })).toEqual([]);
    expect(await latestSession(repoA, { home: home.dir })).toBeNull();
  });

  it("skips corrupt session files rather than failing the command", async () => {
    const { file } = await saveSession(
      state(repoA),
      { analysis, analysisError: null },
      { home: home.dir, now: new Date("2026-01-15T09:00:00.000Z") },
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(path.dirname(file), fileNameFor("2026-01-15T12:00:00.000Z")),
      "{ not json",
      "utf8",
    );

    const sessions = await listSessions(repoA, { home: home.dir });
    expect(sessions).toHaveLength(1);
    expect((await latestSession(repoA, { home: home.dir }))?.savedAt).toBe(
      "2026-01-15T09:00:00.000Z",
    );
  });

  it("produces filesystem-safe filenames", () => {
    const name = fileNameFor("2026-01-15T12:00:00.000Z");
    expect(name).not.toContain(":");
    expect(name).toMatch(/^[\w.-]+\.json$/);
  });

  it("writes valid, human-readable JSON", async () => {
    const { file } = await saveSession(
      state(repoA),
      { analysis, analysisError: null },
      { home: home.dir },
    );
    const text = await readFile(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "version": 1');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe("hasAnySession", () => {
  let home: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    home = await tempHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it("is false on a machine that has never paused", async () => {
    expect(await hasAnySession(home.dir)).toBe(false);
  });

  it("is true once any repo has a session, not just this one", async () => {
    await saveSession(
      state("/Users/dev/projects/alpha"),
      {
        analysis,
        analysisError: null,
      },
      { home: home.dir },
    );
    expect(await hasAnySession(home.dir)).toBe(true);
  });

  it("ignores a sessions directory containing no session files", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const bucket = path.join(home.dir, ".wherewasi", "sessions", "deadbeefcafe");
    await mkdir(bucket, { recursive: true });
    await writeFile(path.join(bucket, "README.txt"), "not a session", "utf8");
    expect(await hasAnySession(home.dir)).toBe(false);
  });
});

describe("tags", () => {
  let home: { dir: string; cleanup: () => Promise<void> };
  const repo = "/Users/dev/projects/alpha";
  const save = (tag: string | undefined, minute: number) =>
    saveSession(
      state(repo),
      { analysis, analysisError: null, ...(tag ? { tag } : {}) },
      { home: home.dir, now: new Date(`2026-01-15T12:${String(minute).padStart(2, "0")}:00.000Z`) },
    );

  beforeEach(async () => {
    home = await tempHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it("returns the newest pause carrying the tag, not the newest overall", async () => {
    await save("refresh", 1);
    await save("layout", 2);
    await save("refresh", 3);
    await save("layout", 4);

    const refresh = await latestSession(repo, { home: home.dir, tag: "refresh" });
    expect(refresh?.savedAt).toBe("2026-01-15T12:03:00.000Z");
    expect(refresh?.tag).toBe("refresh");
  });

  it("ignores tags when none is asked for", async () => {
    await save("refresh", 1);
    await save("layout", 2);
    expect((await latestSession(repo, { home: home.dir }))?.tag).toBe("layout");
  });

  it("returns null for a tag that was never used", async () => {
    await save("refresh", 1);
    expect(await latestSession(repo, { home: home.dir, tag: "nope" })).toBeNull();
  });

  it("does not match untagged sessions against a tag", async () => {
    await save(undefined, 1);
    expect(await latestSession(repo, { home: home.dir, tag: "refresh" })).toBeNull();
  });

  it("lists distinct tags, most recent first", async () => {
    await save("refresh", 1);
    await save("layout", 2);
    await save("refresh", 3);
    await save(undefined, 4);
    expect(await listTags(repo, { home: home.dir })).toEqual(["refresh", "layout"]);
  });
});
