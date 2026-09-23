import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { captureState } from "../src/capture.js";
import { saveSession } from "../src/storage.js";
import { FixtureRepo, tempHome } from "./helpers/fixture-repo.js";

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
    expect(listed.tools.map((tool) => tool.name)).toEqual(["list_tasks", "get_handoff"]);

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

    await repo.write("app.ts", "export const app = false;\n");
    const changed = await client.callTool({ name: "get_handoff", arguments: { tag: "auth" } });
    const changedText = changed.content.find((block) => block.type === "text");
    expect(JSON.parse(changedText?.text ?? "null").verification.status).toBe("changed");

    const invalidRepo = await client.callTool({
      name: "list_tasks",
      arguments: { repository: "relative/path" },
    });
    expect(invalidRepo.isError).toBe(true);

    const missing = await client.callTool({ name: "get_handoff", arguments: { tag: "missing" } });
    expect(missing.isError).toBe(true);
  });
});
