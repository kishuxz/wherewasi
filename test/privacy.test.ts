import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { chmod, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { OpenAICompatibleProvider } from "../src/providers/index.js";
import { hasHostedConsent, hostedDestination, recordHostedConsent } from "../src/privacy.js";
import { rootDir, saveSession } from "../src/storage.js";
import { tempHome } from "./helpers/fixture-repo.js";

const execFileAsync = promisify(execFile);

describe("hosted analysis approval", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("requires separate approval for each hosted destination and stores only a hash", async () => {
    const home = await tempHome();
    cleanups.push(home.cleanup);
    const first = "https://example.invalid/v1";
    const second = "https://another.invalid/v1";
    expect(await hasHostedConsent(first, "repo-a", home.dir)).toBe(false);
    await recordHostedConsent(first, "repo-a", home.dir);
    expect(await hasHostedConsent(first, "repo-a", home.dir)).toBe(true);
    expect(await hasHostedConsent(second, "repo-a", home.dir)).toBe(false);
    expect(await hasHostedConsent(first, "repo-b", home.dir)).toBe(false);
    const { readdir } = await import("node:fs/promises");
    const [file] = (await readdir(rootDir(home.dir))).filter((name) =>
      name.startsWith("hosted-consent-"),
    );
    const content = await readFile(`${rootDir(home.dir)}/${file}`, "utf8");
    expect(content).not.toContain(first);
    expect((await stat(`${rootDir(home.dir)}/${file}`)).mode & 0o777).toBe(0o600);
  });

  it("treats loopback inference as local", () => {
    const local = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:11434/v1" });
    const hosted = new OpenAICompatibleProvider({ baseUrl: "https://example.invalid/v1" });
    expect(hostedDestination(local)).toBeNull();
    expect(hostedDestination(hosted)).toBe("https://example.invalid/v1");
  });

  it("runs the permission repair through the installed-style CLI", async () => {
    const home = await tempHome();
    cleanups.push(home.cleanup);
    const { file } = await saveSession(
      {
        repoPath: "/example/repo",
        git: {
          isRepo: false,
          branch: "",
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
      },
      { analysis: null, analysisError: null },
      { home: home.dir },
    );
    await chmod(file, 0o644);
    const { stdout } = await execFileAsync(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("src/cli.ts"), "privacy", "--fix-permissions"],
      { env: { ...process.env, HOME: home.dir } },
    );
    expect(stdout).toContain("Tightened 1");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
