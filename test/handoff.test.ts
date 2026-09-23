import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { captureState, findRepoId } from "../src/capture.js";
import {
  appendTaskCheckpoint,
  CheckpointConflictError,
  formatHandoff,
  loadHandoff,
} from "../src/handoff.js";
import { listRepos, saveSession } from "../src/storage.js";
import { FixtureRepo, tempHome } from "./helpers/fixture-repo.js";

describe("portable task handoff", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("finds a Claude checkpoint from a Codex worktree in the same repository", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("src/app.ts", "export const app = true;\n");
    await repo.commit("base");
    const home = await tempHome();
    cleanups.push(home.cleanup);
    const state = await captureState({ cwd: repo.dir, note: "finish the auth check" });
    await saveSession(
      state,
      {
        analysis: null,
        analysisError: "no model",
        trigger: "manual",
        tag: "auth",
        actor: "claude-code",
      },
      { home: home.dir },
    );

    const worktree = path.join(home.dir, "codex-worktree");
    await repo.git("worktree", "add", "-b", "codex-task", worktree);
    expect(await findRepoId(worktree)).toBe(state.repoId);
    const handoff = await loadHandoff(worktree, "auth", { home: home.dir });
    expect(handoff?.actor).toBe("claude-code");
    expect(handoff?.developerNote).toBe("finish the auth check");
    expect(handoff?.repository.currentPath).toBe(worktree);
    expect(handoff?.verification.status).toBe("changed");
    expect(formatHandoff(handoff!)).toContain("Check the current repository state");
  });

  it("detects edits made after the checkpoint even when Git status names the same file", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("src/app.ts", "export const app = true;\n");
    await repo.commit("base");
    const home = await tempHome();
    cleanups.push(home.cleanup);
    await repo.write("src/app.ts", "export const app = false;\n");
    const state = await captureState({ cwd: repo.dir, note: "first edit" });
    await saveSession(
      state,
      { analysis: null, analysisError: "no model", trigger: "manual", tag: "app" },
      { home: home.dir },
    );
    expect((await loadHandoff(repo.dir, "app", { home: home.dir }))?.verification.status).toBe(
      "current",
    );
    await repo.write("src/app.ts", "export const app = 123;\n");
    const handoff = await loadHandoff(repo.dir, "app", { home: home.dir });
    expect(handoff?.verification.status).toBe("changed");
    expect(handoff?.verification.reasons).toContain(
      "Tracked changes or Git status differ from this checkpoint.",
    );
  });

  it("does not claim unchanged untracked file contents are verified", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("base", "base");
    await repo.commit("base");
    const home = await tempHome();
    cleanups.push(home.cleanup);
    await repo.write("untracked.txt", "first");
    const state = await captureState({ cwd: repo.dir });
    await saveSession(
      state,
      { analysis: null, analysisError: "no model", trigger: "manual" },
      { home: home.dir },
    );
    await repo.write("untracked.txt", "second");
    expect((await loadHandoff(repo.dir, undefined, { home: home.dir }))?.verification.status).toBe(
      "unverified",
    );
  });

  it("preserves one winner when linked worktrees update the same revision concurrently", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("app.ts", "export const app = true;\n");
    await repo.commit("base");
    const home = await tempHome();
    cleanups.push(home.cleanup);
    const worktree = path.join(home.dir, "other-worktree");
    await repo.git("worktree", "add", "-b", "other-branch", worktree);

    const initial = await saveSession(
      await captureState({ cwd: repo.dir, note: "human intent" }),
      { analysis: null, analysisError: "no model", trigger: "manual", tag: "auth", actor: "human" },
      { home: home.dir },
    );
    const expectedCheckpointId = initial.session.checkpointId!;
    const sameInstant = new Date(new Date(initial.session.savedAt).getTime() + 1000);
    const states = await Promise.all([
      captureState({ cwd: repo.dir, note: "Claude update" }),
      captureState({ cwd: worktree, note: "Codex update" }),
    ]);
    const results = await Promise.allSettled(
      states.map((state, index) =>
        appendTaskCheckpoint(
          state,
          {
            analysis: null,
            analysisError: "agent update",
            trigger: "manual",
            tag: "auth",
            actor: index === 0 ? "claude-code" : "codex",
          },
          { home: home.dir, expectedCheckpointId, now: sameInstant },
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(CheckpointConflictError);
    const sessions = (await listRepos({ home: home.dir, all: true })).flatMap(
      (item) => item.sessions,
    );
    expect(sessions.filter((session) => session.tag === "auth")).toHaveLength(2);
    const handoff = await loadHandoff(repo.dir, "auth", { home: home.dir });
    expect(["claude-code", "codex"]).toContain(handoff?.actor);
    expect(handoff?.checkpointId).not.toBe(expectedCheckpointId);
  });
});
