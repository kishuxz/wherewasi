import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { captureState } from "../src/capture.js";
import { saveSession } from "../src/storage.js";
import { FixtureRepo, tempHome } from "./helpers/fixture-repo.js";

const execFileAsync = promisify(execFile);

describe("MCP task handoffs", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("serves tagged checkpoints to an independent stdio MCP client", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("app.ts", "export const app = true;\n");
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

    const client = new Client({ name: "wherewasi-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: path.resolve("node_modules/.bin/tsx"),
      args: [path.resolve("src/cli.ts"), "mcp", "--repo", repo.dir],
      env: { ...process.env, HOME: home.dir },
      stderr: "pipe",
    });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "list_tasks",
      "get_handoff",
      "update_task",
    ]);

    const tasks = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(tasks.isError).toBeFalsy();
    const taskText = tasks.content.find((block) => block.type === "text");
    expect(taskText?.text).toContain('"task":"auth"');

    const result = await client.callTool({ name: "get_handoff", arguments: { tag: "auth" } });
    expect(result.isError).toBeFalsy();
    const handoffText = result.content.find((block) => block.type === "text");
    const handoff = JSON.parse(handoffText?.text ?? "null");
    expect(handoff.actor).toBe("claude-code");
    expect(handoff.developerNote).toBe("finish the auth check");
    expect(handoff.verification.status).toBe("current");

    const update = await client.callTool({
      name: "update_task",
      arguments: {
        tag: "auth",
        expectedCheckpointId: handoff.checkpointId,
        actor: "codex",
        note: "checked the expiry branch; next run the failing test. DATABASE_URL=postgresql://dev:fakepass@db.invalid/app",
      },
    });
    expect(update.isError).toBeFalsy();
    const updated = await client.callTool({ name: "get_handoff", arguments: { tag: "auth" } });
    const updatedText = updated.content.find((block) => block.type === "text");
    const updatedHandoff = JSON.parse(updatedText?.text ?? "null");
    expect(updatedHandoff.actor).toBe("codex");
    expect(updatedHandoff.developerNote).toContain("next run the failing test");
    expect(updatedHandoff.developerNote).not.toContain("fakepass");
    expect(updatedHandoff.checkpointId).not.toBe(handoff.checkpointId);

    const cliEnv = {
      ...process.env,
      HOME: home.dir,
      WHEREWASI_API_KEY: "",
      GROQ_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    };
    const { stdout: humanRead } = await execFileAsync(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("src/cli.ts"), "handoff", "auth", "--json"],
      { cwd: repo.dir, env: cliEnv },
    );
    expect(JSON.parse(humanRead).actor).toBe("codex");

    const stale = await client.callTool({
      name: "update_task",
      arguments: {
        tag: "auth",
        expectedCheckpointId: handoff.checkpointId,
        actor: "claude-code",
        note: "stale update",
      },
    });
    expect(stale.isError).toBe(true);
    expect(stale.content.find((block) => block.type === "text")?.text).toContain(
      "get_handoff again",
    );

    await execFileAsync(
      path.resolve("node_modules/.bin/tsx"),
      [
        path.resolve("src/cli.ts"),
        "pause",
        "--tag",
        "auth",
        "--actor",
        "human",
        "verified the failing test",
      ],
      { cwd: repo.dir, env: cliEnv },
    );
    const humanUpdate = await client.callTool({ name: "get_handoff", arguments: { tag: "auth" } });
    const humanText = humanUpdate.content.find((block) => block.type === "text");
    const humanHandoff = JSON.parse(humanText?.text ?? "null");
    expect(humanHandoff.actor).toBe("human");
    const claudeUpdate = await client.callTool({
      name: "update_task",
      arguments: {
        tag: "auth",
        expectedCheckpointId: humanHandoff.checkpointId,
        actor: "claude-code",
        note: "continuing after human verification",
      },
    });
    expect(claudeUpdate.isError).toBeFalsy();
    const finalRead = await client.callTool({ name: "get_handoff", arguments: { tag: "auth" } });
    const finalText = finalRead.content.find((block) => block.type === "text");
    expect(JSON.parse(finalText?.text ?? "null").actor).toBe("claude-code");

    await repo.write("app.ts", "export const app = false;\n");
    const changed = await client.callTool({ name: "get_handoff", arguments: { tag: "auth" } });
    const changedText = changed.content.find((block) => block.type === "text");
    expect(JSON.parse(changedText?.text ?? "null").verification.status).toBe("changed");

    const invalidRepo = await client.callTool({
      name: "list_tasks",
      arguments: { repository: "relative/path" },
    });
    expect(invalidRepo.isError).toBe(true);

    const worktree = path.join(home.dir, "linked-worktree");
    await repo.git("worktree", "add", "-b", "other-branch", worktree);
    const linked = await client.callTool({
      name: "get_handoff",
      arguments: { repository: worktree, tag: "auth" },
    });
    expect(linked.isError).toBeFalsy();

    const unrelated = await FixtureRepo.create("wherewasi-unrelated-");
    cleanups.push(() => unrelated.cleanup());
    await unrelated.write("base", "base");
    await unrelated.commit("base");
    const outside = await client.callTool({
      name: "list_tasks",
      arguments: { repository: unrelated.dir },
    });
    expect(outside.isError).toBe(true);
    expect(outside.content.find((block) => block.type === "text")?.text).toContain("outside");

    const missing = await client.callTool({ name: "get_handoff", arguments: { tag: "missing" } });
    expect(missing.isError).toBe(true);
  });
});
