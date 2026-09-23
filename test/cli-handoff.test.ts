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

  it("saves the departing branch before switching", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("app.ts", "export const app = 'main';\n");
    await repo.commit("base");
    await repo.git("branch", "feature");
    const home = await tempHome();
    cleanups.push(home.cleanup);
    const env = {
      ...process.env,
      HOME: home.dir,
      WHEREWASI_API_KEY: "",
      GROQ_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      WHEREWASI_WITH_SESSION: "",
    };
    await execFileAsync(
      CLI,
      [SOURCE, "switch", "feature", "--tag", "departure", "investigating auth"],
      {
        cwd: repo.dir,
        env,
      },
    );
    expect((await repo.git("branch", "--show-current")).stdout.trim()).toBe("feature");
    const session = (await listSessions(repo.dir, { home: home.dir })).find(
      (s) => s.tag === "departure",
    );
    expect(session?.git.branch).toBe("main");
    expect(session?.note).toBe("investigating auth");
  });

  it("stores redacted credential paths and connection strings", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("app.ts", "export const app = true;\n");
    await repo.commit("base");
    await repo.write(
      "src/.env.production",
      "DATABASE_URL=postgresql://dev:fakepass@db.invalid/app\n",
    );
    const home = await tempHome();
    cleanups.push(home.cleanup);
    await execFileAsync(
      CLI,
      [SOURCE, "pause", "--tag", "privacy", "read /Users/developer/.ssh/id_ed25519"],
      {
        cwd: repo.dir,
        env: { ...process.env, HOME: home.dir, WHEREWASI_API_KEY: "", GROQ_API_KEY: "" },
      },
    );
    const session = (await listSessions(repo.dir, { home: home.dir }))[0];
    const saved = JSON.stringify(session);
    expect(saved).not.toContain("src/.env.production");
    expect(saved).not.toContain("/Users/developer/.ssh/id_ed25519");
    expect(saved).not.toContain("postgresql://dev:fakepass@db.invalid/app");
    expect(saved).toContain("[REDACTED]");
  });

  it("withholds a first hosted request in a noninteractive pause", async () => {
    const repo = await FixtureRepo.create();
    cleanups.push(() => repo.cleanup());
    await repo.write("app.ts", "export const app = true;\n");
    await repo.commit("base");
    const home = await tempHome();
    cleanups.push(home.cleanup);
    const env = {
      ...process.env,
      HOME: home.dir,
      WHEREWASI_API_KEY: "synthetic-key",
      WHEREWASI_BASE_URL: "https://example.invalid/v1",
    };
    await execFileAsync(CLI, [SOURCE, "pause", "--tag", "hosted", "investigate expiry"], {
      cwd: repo.dir,
      env,
    });
    const session = (await listSessions(repo.dir, { home: home.dir }))[0];
    expect(session?.analysis).toBeNull();
    expect(session?.analysisError).toContain("hosted analysis withheld");
    await execFileAsync(
      CLI,
      [SOURCE, "pause", "--tag", "local", "investigate expiry", "--local-only"],
      {
        cwd: repo.dir,
        env,
      },
    );
    const latest = (await listSessions(repo.dir, { home: home.dir }))[0];
    expect(latest?.analysisError).toContain("hosted analysis disabled");
  });
});
