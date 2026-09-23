import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeProjectDir } from "../src/transcript.js";
import { listSessions } from "../src/storage.js";
import { FixtureRepo, tempHome } from "./helpers/fixture-repo.js";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("node_modules/.bin/tsx");
const SOURCE = path.resolve("src/cli.ts");

describe("installed-style CLI handoff", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("requires an explicit flag before reading a Claude Code session", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("app.ts", "export const app = true;\n");
    await repo.commit("base");
    const home = await tempHome();
    cleanups.push(home.cleanup);
    const transcriptDir = path.join(home.dir, ".claude", "projects", encodeProjectDir(repo.dir));
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, "session.jsonl"),
      `${JSON.stringify({ type: "user", cwd: repo.dir, sessionId: "test-session", message: { content: "Investigate why auth refresh fails after expiry" } })}\n`,
    );
    const env = {
      ...process.env,
      HOME: home.dir,
      WHEREWASI_API_KEY: "",
      GROQ_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      WHEREWASI_WITH_SESSION: "",
      WHEREWASI_WITH_THINKING: "",
      WHEREWASI_NO_SESSION: "",
    };
    const run = (args: string[]) => execFileAsync(CLI, [SOURCE, ...args], { cwd: repo.dir, env });

    await run(["pause", "--tag", "default", "first"]);
    await run(["pause", "--tag", "explicit", "--with-session", "second"]);
    await run(["pause", "--tag", "codex", "--actor", "codex", "--with-session", "third"]);
    const sessions = await listSessions(repo.dir, { home: home.dir });
    expect(sessions.find((s) => s.tag === "default")?.transcript).toBeUndefined();
    expect(sessions.find((s) => s.tag === "explicit")?.transcript?.source).toBe("claude-code");
    expect(sessions.find((s) => s.tag === "codex")?.transcript).toBeUndefined();
    const { stdout } = await run(["handoff", "explicit", "--json"]);
    expect(JSON.parse(stdout).source).toBe("claude-code-session");
  });
});
