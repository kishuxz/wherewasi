import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

export class FixtureRepo {
  private constructor(readonly dir: string) {}

  static async create(name = "wherewasi-fixture-"): Promise<FixtureRepo> {
    // macOS tmpdir is a symlink (/var → /private/var); resolve so paths that
    // come back from `git rev-parse --show-toplevel` compare equal.
    const base = fs.realpathSync(tmpdir());
    const dir = await mkdtemp(path.join(base, name));
    const repo = new FixtureRepo(dir);
    await repo.git("init", "-b", "main");
    await repo.git("config", "user.email", "fixture@example.com");
    await repo.git("config", "user.name", "Fixture");
    await repo.git("config", "commit.gpgsign", "false");
    return repo;
  }

  git(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, { cwd: this.dir });
  }

  async write(rel: string, content: string, mtime?: Date): Promise<string> {
    const full = path.join(this.dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    if (mtime) await utimes(full, mtime, mtime);
    return full;
  }

  async touch(rel: string, mtime: Date): Promise<void> {
    await utimes(path.join(this.dir, rel), mtime, mtime);
  }

  async commit(message: string): Promise<void> {
    await this.git("add", "-A");
    await this.git("commit", "-m", message);
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

export async function tempHome(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = fs.realpathSync(tmpdir());
  const dir = await mkdtemp(path.join(base, "wherewasi-home-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
