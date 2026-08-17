import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MARKER,
  SHELLS,
  DEBUG_ENV,
  debugLine,
  detectShell,
  fishQuote,
  hookPath,
  installHook,
  launchLine,
  postCheckoutHook,
  shQuote,
  shellSnippet,
  uninstallHook,
} from "../src/hooks.js";

const NODE = "/usr/local/bin/node";
const CLI = "/usr/local/lib/node_modules/wherewasi/dist/cli.js";

describe("launchLine", () => {
  it("detaches so the triggering command is never blocked", () => {
    const line = launchLine(NODE, CLI);
    // Subshell + background: the parent does not wait.
    expect(line.startsWith("(")).toBe(true);
    expect(line).toContain("&");
    // nohup: survives the terminal that spawned it going away.
    expect(line).toContain("nohup");
  });

  it("discards all output", () => {
    expect(launchLine(NODE, CLI)).toContain(">/dev/null 2>&1");
  });

  it("single-quotes paths, so a space cannot split the command", () => {
    expect(launchLine(NODE, "/Users/a b/wherewasi/dist/cli.js")).toContain(
      "'/Users/a b/wherewasi/dist/cli.js'",
    );
  });

  it("does not leave a path open to shell expansion", () => {
    // Double quotes would still expand these. Single quotes expand nothing.
    const line = launchLine(NODE, "/tmp/a $HOME/`id`/cli.js");
    expect(line).toContain("'/tmp/a $HOME/`id`/cli.js'");
    expect(line).not.toContain('"');
  });
});

describe("postCheckoutHook", () => {
  const hook = postCheckoutHook(NODE, CLI);

  it("is a marked shell script", () => {
    expect(hook.startsWith("#!/bin/sh")).toBe(true);
    expect(hook).toContain(MARKER);
  });

  it("ignores file checkouts, which are not context switches", () => {
    expect(hook).toContain('if [ "$3" != "1" ]; then');
  });

  it("skips the checkout that ends a clone, matching zeros of any SHA length", () => {
    expect(hook).toContain("*[!0]*");
  });

  it("does NOT skip a checkout that left HEAD unchanged", () => {
    // `git checkout -b`, and switching between branches on the same commit,
    // both pass $1 = $2 and are both real context switches.
    expect(hook).not.toContain('[ "$1" != "$2" ]');
  });

  it("always exits 0 so a checkout can never be failed by it", () => {
    expect(hook.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("traces before the guards, so a wrong skip is not silence", () => {
    // The `git checkout -b` bug survived because a guard declining looked
    // identical to the hook never running.
    const trace = hook.indexOf("post-checkout $1 -> $2");
    const firstGuard = hook.indexOf('[ "$3" != "1" ]');
    expect(trace).toBeGreaterThan(-1);
    expect(trace).toBeLessThan(firstGuard);
  });

  it("names the reason on every early exit", () => {
    expect(hook).toContain("skipped: file checkout");
    expect(hook).toContain("skipped: previous HEAD is all zeros");
  });

  it("runs in the foreground under WHEREWASI_DEBUG, detached otherwise", () => {
    expect(hook).toContain(`[ -n "\${${DEBUG_ENV}:-}" ]`);
    expect(hook).toContain(debugLine(NODE, CLI));
    expect(hook).toContain(launchLine(NODE, CLI));
  });
});

describe("shellSnippet", () => {
  it("uses an EXIT trap for bash and zsh", () => {
    for (const shell of ["bash", "zsh"] as const) {
      const s = shellSnippet(shell, NODE, CLI);
      expect(s).toContain("trap __wherewasi_auto_capture EXIT");
      expect(s).toContain(MARKER);
    }
  });

  it("uses fish_exit for fish, not an EXIT trap", () => {
    const s = shellSnippet("fish", NODE, CLI);
    expect(s).toContain("--on-event fish_exit");
    expect(s).not.toContain("trap ");
  });

  it("never emits the POSIX subshell form into fish", () => {
    // `( … )` is command substitution in fish, not a subshell. Emitting it is
    // a syntax error, and it shipped once because the tests only checked for
    // substrings rather than validity.
    const body = shellSnippet("fish", NODE, CLI)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"));
    expect(body.some((l) => l.trimStart().startsWith("("))).toBe(false);
  });

  it("delegates backgrounding to sh in fish", () => {
    // fish kills its own background jobs at exit regardless of nohup/disown;
    // the intermediate sh exits immediately and leaves the capture reparented.
    expect(shellSnippet("fish", NODE, CLI)).toContain("command sh -c ");
  });

  it("names the right rc file per shell", () => {
    expect(shellSnippet("zsh", NODE, CLI)).toContain("~/.zshrc");
    expect(shellSnippet("bash", NODE, CLI)).toContain("~/.bashrc");
    expect(shellSnippet("fish", NODE, CLI)).toContain("config.fish");
  });

  it("detaches in every shell", () => {
    for (const shell of SHELLS) {
      expect(shellSnippet(shell, NODE, CLI)).toContain("nohup");
    }
  });

  it("offers a foreground debug path in every shell", () => {
    for (const shell of SHELLS) {
      const snippet = shellSnippet(shell, NODE, CLI);
      expect(snippet).toContain(DEBUG_ENV);
      expect(snippet).toContain(debugLine(NODE, CLI));
    }
  });

  it("uses fish's own test for the variable, not POSIX syntax", () => {
    expect(shellSnippet("fish", NODE, CLI)).toContain(`set -q ${DEBUG_ENV}`);
  });
});

describe("quoting", () => {
  it("shQuote closes a single-quoted string safely", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  it("fishQuote escapes backslash and quote", () => {
    expect(fishQuote("a'b")).toBe("'a\\'b'");
    expect(fishQuote("a\\b")).toBe("'a\\\\b'");
  });
});

describe("detectShell", () => {
  it("reads the basename of $SHELL", () => {
    expect(detectShell({ SHELL: "/bin/zsh" })).toBe("zsh");
    expect(detectShell({ SHELL: "/usr/bin/fish" })).toBe("fish");
    expect(detectShell({ SHELL: "/bin/bash" })).toBe("bash");
  });

  it("returns null rather than guessing", () => {
    expect(detectShell({})).toBeNull();
    expect(detectShell({ SHELL: "/bin/tcsh" })).toBeNull();
    expect(detectShell({ SHELL: "" })).toBeNull();
  });
});

describe("install and uninstall", () => {
  let dir: string;
  let gitDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wherewasi-hooks-"));
    gitDir = path.join(dir, ".git");
    await mkdir(path.join(gitDir, "hooks"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes an executable hook", async () => {
    const result = await installHook(gitDir, NODE, CLI);
    expect(result).toMatchObject({ ok: true, action: "installed" });

    const file = hookPath(gitDir);
    expect(await readFile(file, "utf8")).toContain(MARKER);
    // 0o111 — executable by someone, or git silently ignores it.
    expect((await stat(file)).mode & 0o111).toBeGreaterThan(0);
  });

  it("refuses to overwrite a hook it did not write", async () => {
    const file = hookPath(gitDir);
    const theirs = "#!/bin/sh\nexec ./scripts/sync-submodules.sh\n";
    await writeFile(file, theirs, "utf8");

    const result = await installHook(gitDir, NODE, CLI);
    expect(result).toEqual({ ok: false, reason: "foreign-hook", file });
    // Untouched — clobbering someone's hook is silent and destructive.
    expect(await readFile(file, "utf8")).toBe(theirs);
  });

  it("updates its own hook in place", async () => {
    await installHook(gitDir, NODE, "/old/path/cli.js");
    const result = await installHook(gitDir, NODE, CLI);
    expect(result).toMatchObject({ ok: true, action: "updated" });
    const content = await readFile(hookPath(gitDir), "utf8");
    expect(content).toContain(CLI);
    expect(content).not.toContain("/old/path/cli.js");
  });

  it("removes only its own hook", async () => {
    await installHook(gitDir, NODE, CLI);
    expect(await uninstallHook(gitDir)).toMatchObject({ ok: true, action: "removed" });
    // Idempotent.
    expect(await uninstallHook(gitDir)).toMatchObject({ ok: true, action: "absent" });
  });

  it("refuses to remove a foreign hook", async () => {
    const file = hookPath(gitDir);
    await writeFile(file, "#!/bin/sh\necho theirs\n", "utf8");
    expect(await uninstallHook(gitDir)).toEqual({ ok: false, reason: "foreign-hook", file });
    expect(await readFile(file, "utf8")).toContain("theirs");
  });

  it("creates the hooks directory when it does not exist", async () => {
    await rm(path.join(gitDir, "hooks"), { recursive: true, force: true });
    expect(await installHook(gitDir, NODE, CLI)).toMatchObject({ ok: true });
  });
});
