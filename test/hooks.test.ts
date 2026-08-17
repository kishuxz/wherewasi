import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MARKER,
  SHELLS,
  detectShell,
  hookPath,
  installHook,
  launchLine,
  postCheckoutHook,
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

  it("quotes the path so a space in it cannot split the command", () => {
    expect(launchLine(NODE, "/Users/a b/wherewasi/dist/cli.js")).toContain(
      '"/Users/a b/wherewasi/dist/cli.js"',
    );
  });
});

describe("postCheckoutHook", () => {
  const hook = postCheckoutHook(NODE, CLI);

  it("is a marked shell script", () => {
    expect(hook.startsWith("#!/bin/sh")).toBe(true);
    expect(hook).toContain(MARKER);
  });

  it("ignores file checkouts, which are not context switches", () => {
    expect(hook).toContain('[ "$3" = "1" ] || exit 0');
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
