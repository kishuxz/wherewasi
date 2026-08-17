import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import {
  DIFF_LIMIT,
  captureState,
  findRecentFiles,
  findRepoRoot,
  markBursts,
  parseSince,
  pathsFromStatus,
  truncate,
} from "../src/capture.js";
import { FixtureRepo } from "./helpers/fixture-repo.js";

describe("capture layer", () => {
  let repo: FixtureRepo;
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const minutesAgo = (m: number) => new Date(now - m * 60_000);

  beforeAll(async () => {
    repo = await FixtureRepo.create();

    await repo.write("src/auth.ts", "export const verify = () => true;\n");
    await repo.write("src/db.ts", "export const query = () => [];\n");
    await repo.write("README.md", "# fixture\n");
    await repo.commit("initial commit");
    await repo.write("src/auth.ts", "export const verify = () => false;\n");
    await repo.commit("flip verify");

    await repo.git("checkout", "-b", "fix/session-expiry");

    // unstaged change
    await repo.write("src/auth.ts", "export const verify = (t: string) => t.length > 0;\n");
    // staged change
    await repo.write("src/db.ts", "export const query = (sql: string) => [sql];\n");
    await repo.git("add", "src/db.ts");
    // untracked
    await repo.write("src/scratch.ts", "// debugging\n");

    // Files inside/outside the 2h window, plus excluded dirs.
    await repo.touch("src/auth.ts", minutesAgo(5));
    await repo.touch("src/db.ts", minutesAgo(20));
    await repo.touch("src/scratch.ts", minutesAgo(1));
    await repo.touch("README.md", minutesAgo(300));
    await repo.write("node_modules/pkg/index.js", "x", minutesAgo(2));
    await repo.write("dist/bundle.js", "x", minutesAgo(2));
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  it("finds the repo root from a subdirectory", async () => {
    const root = await findRepoRoot(path.join(repo.dir, "src"));
    expect(root).toBe(repo.dir);
  });

  it("returns null outside a git work tree", async () => {
    const root = await findRepoRoot(path.parse(repo.dir).root);
    expect(root).toBeNull();
  });

  it("captures branch, both diffs, log and status", async () => {
    const state = await captureState({ cwd: repo.dir, now });

    expect(state.repoPath).toBe(repo.dir);
    expect(state.git.isRepo).toBe(true);
    expect(state.git.branch).toBe("fix/session-expiry");

    expect(state.git.diff).toContain("src/auth.ts");
    expect(state.git.diff).toContain("t.length > 0");
    expect(state.git.diff).not.toContain("src/db.ts");

    expect(state.git.stagedDiff).toContain("src/db.ts");
    expect(state.git.stagedDiff).not.toContain("src/auth.ts");

    expect(state.git.log.split("\n")).toHaveLength(2);
    expect(state.git.log).toContain("flip verify");

    expect(state.git.status).toContain("src/auth.ts");
    expect(state.git.status).toContain("?? src/scratch.ts");
  });

  it("lists recent files newest-first, excluding node_modules/dist/.git", async () => {
    const files = await findRecentFiles(repo.dir, { now });
    const paths = files.map((f) => f.path);

    expect(paths.slice(0, 3)).toEqual(["src/scratch.ts", "src/auth.ts", "src/db.ts"]);
    expect(paths).not.toContain("README.md"); // 5 hours old
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("caps the recent-file list at 40", async () => {
    const many = await FixtureRepo.create("wherewasi-many-");
    try {
      for (let i = 0; i < 60; i++) {
        await many.write(`f${String(i).padStart(2, "0")}.txt`, "x", minutesAgo(i + 1));
      }
      const files = await findRecentFiles(many.dir, { now, since: new Date(now - 86_400_000) });
      expect(files).toHaveLength(40);
      expect(files[0]?.path).toBe("f00.txt"); // most recently modified
    } finally {
      await many.cleanup();
    }
  });

  it("sorts git-changed files ahead of mtime-only ones", async () => {
    const repo2 = await FixtureRepo.create("wherewasi-sort-");
    try {
      // The git-changed file is OLDER, so mtime alone would rank it last.
      await repo2.write("touched-recently.txt", "x", minutesAgo(1));
      await repo2.write("changed-in-git.txt", "x", minutesAgo(90));
      const files = await findRecentFiles(repo2.dir, {
        now,
        since: new Date(now - 86_400_000),
        gitPaths: new Set(["changed-in-git.txt"]),
      });
      expect(files[0]?.path).toBe("changed-in-git.txt");
      expect(files[0]?.inGit).toBe(true);
      expect(files[1]?.inGit).toBe(false);
    } finally {
      await repo2.cleanup();
    }
  });

  it("respects an explicit since instant", async () => {
    const repo3 = await FixtureRepo.create("wherewasi-since-");
    try {
      await repo3.write("new.txt", "x", minutesAgo(10));
      await repo3.write("old.txt", "x", minutesAgo(400));
      const narrow = await findRecentFiles(repo3.dir, { now, since: new Date(now - 3_600_000) });
      expect(narrow.map((f) => f.path)).toContain("new.txt");
      expect(narrow.map((f) => f.path)).not.toContain("old.txt");

      const wide = await findRecentFiles(repo3.dir, { now, since: new Date(now - 86_400_000) });
      expect(wide.map((f) => f.path)).toContain("old.txt");
    } finally {
      await repo3.cleanup();
    }
  });

  it("truncates each diff at 8000 chars", () => {
    const short = truncate("abc");
    expect(short).toEqual({ text: "abc", truncated: false });

    const long = truncate("x".repeat(DIFF_LIMIT + 500));
    expect(long.truncated).toBe(true);
    expect(long.text).toContain("truncated at 8000 chars");
    expect(long.text.slice(0, DIFF_LIMIT)).toBe("x".repeat(DIFF_LIMIT));
  });

  it("truncates a real oversized diff", async () => {
    const big = await FixtureRepo.create("wherewasi-big-");
    try {
      await big.write("big.txt", "seed\n");
      await big.commit("seed");
      await big.write("big.txt", Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n"));
      const state = await captureState({ cwd: big.dir, now });
      expect(state.git.diffTruncated).toBe(true);
      expect(state.git.diff.length).toBeLessThan(DIFF_LIMIT + 100);
    } finally {
      await big.cleanup();
    }
  });

  it("carries the note and piped input through", async () => {
    const state = await captureState({
      cwd: repo.dir,
      note: "  auth failing  ",
      input: "FAIL src/auth.test.ts\n",
      now,
    });
    expect(state.note).toBe("auth failing");
    expect(state.input).toContain("FAIL src/auth.test.ts");
  });

  it("normalizes empty note and input to null", async () => {
    const state = await captureState({ cwd: repo.dir, note: "   ", input: "\n\n", now });
    expect(state.note).toBeNull();
    expect(state.input).toBeNull();
  });

  it("degrades outside a git repo instead of throwing", async () => {
    const plain = await FixtureRepo.create("wherewasi-plain-");
    try {
      // Remove the git metadata so it is a bare directory again.
      const { rm } = await import("node:fs/promises");
      await rm(path.join(plain.dir, ".git"), { recursive: true, force: true });
      await plain.write("notes.md", "hello", minutesAgo(3));

      const state = await captureState({ cwd: plain.dir, now });
      expect(state.git.isRepo).toBe(false);
      expect(state.git.branch).toBe("");
      expect(state.repoPath).toBe(plain.dir);
      expect(state.recentFiles.map((f) => f.path)).toContain("notes.md");
    } finally {
      await plain.cleanup();
    }
  });

  it("completes well inside the 5s budget", async () => {
    const started = Date.now();
    await captureState({ cwd: repo.dir, now });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("recency window", () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

  describe("parseSince", () => {
    it("parses relative durations", () => {
      expect(parseSince("30m", NOW)?.toISOString()).toBe("2026-01-15T11:30:00.000Z");
      expect(parseSince("2h", NOW)?.toISOString()).toBe("2026-01-15T10:00:00.000Z");
      expect(parseSince("1d", NOW)?.toISOString()).toBe("2026-01-14T12:00:00.000Z");
      expect(parseSince("45s", NOW)?.toISOString()).toBe("2026-01-15T11:59:15.000Z");
      expect(parseSince(" 2 h ", NOW)?.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    });

    it("parses an ISO timestamp", () => {
      expect(parseSince("2026-01-14T09:00:00.000Z", NOW)?.toISOString()).toBe(
        "2026-01-14T09:00:00.000Z",
      );
    });

    it("returns null for nonsense", () => {
      for (const bad of ["", "  ", "yesterday", "2x", "-3h", "h"]) {
        expect(parseSince(bad, NOW)).toBeNull();
      }
    });
  });

  describe("pathsFromStatus", () => {
    it("extracts paths across status codes", () => {
      const paths = pathsFromStatus(
        [" M src/a.ts", "?? src/b.ts", "A  src/c.ts", "MM src/d.ts"].join("\n"),
      );
      expect([...paths].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    });

    it("takes the destination of a rename", () => {
      const paths = pathsFromStatus("R  src/old.ts -> src/new.ts");
      expect(paths.has("src/new.ts")).toBe(true);
      expect(paths.has("src/old.ts")).toBe(false);
    });

    it("handles quoted paths and blank lines", () => {
      const paths = pathsFromStatus('?? "src/has space.ts"\n\n');
      expect(paths.has("src/has space.ts")).toBe(true);
    });
  });

  describe("markBursts", () => {
    it("tags a dense cluster as a bulk edit", () => {
      // 20 files written inside one second — an agent or a codemod.
      const files = Array.from({ length: 20 }, (_, i) => ({ mtimeMs: NOW + i * 50 }));
      expect(markBursts(files)).toBe(20);
      expect(files.every((f) => (f as { bulk?: boolean }).bulk)).toBe(true);
    });

    it("leaves human-paced edits alone", () => {
      // 10 files, minutes apart.
      const files = Array.from({ length: 10 }, (_, i) => ({ mtimeMs: NOW + i * 300_000 }));
      expect(markBursts(files)).toBe(0);
      expect(files.some((f) => (f as { bulk?: boolean }).bulk)).toBe(false);
    });

    it("tags only the burst, not files around it", () => {
      const burst = Array.from({ length: 18 }, (_, i) => ({ mtimeMs: NOW + i * 100 }));
      const human = [{ mtimeMs: NOW - 3_600_000 }, { mtimeMs: NOW + 3_600_000 }];
      const all = [...human, ...burst];
      expect(markBursts(all)).toBe(18);
      expect(human.every((f) => !(f as { bulk?: boolean }).bulk)).toBe(true);
    });
  });
});
