import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { captureState, findRepoId } from "../src/capture.js";
import { formatHandoff, loadHandoff } from "../src/handoff.js";
import { saveSession } from "../src/storage.js";
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
});
