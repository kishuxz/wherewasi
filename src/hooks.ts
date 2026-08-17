import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type Shell = "bash" | "zsh" | "fish";

export const SHELLS: Shell[] = ["bash", "zsh", "fish"];

/**
 * Identifies content this tool wrote. Both the hook and the shell snippet
 * carry it, so uninstall can refuse to touch anything it did not create.
 */
export const MARKER = "wherewasi:auto-capture";

/**
 * Every automatic capture is launched like this:
 *
 *   ( nohup <node> <cli> pause --auto >/dev/null 2>&1 & )
 *
 * The subshell means the parent never waits, so `git checkout` and shell exit
 * are not slowed. `nohup` keeps the capture alive when the terminal that
 * spawned it goes away — the whole point of the shell-exit trigger. Output
 * goes to /dev/null because an automatic capture must never write into
 * someone's `git checkout` output, and `--auto` already exits 0 regardless.
 *
 * Both paths are absolute, and node is invoked explicitly rather than relying
 * on the script's shebang or on PATH. Two reasons, both found the hard way:
 * `tsc` does not set an executable bit, so exec-ing the entrypoint directly
 * fails with EACCES; and git hooks run with whatever environment the caller
 * had, which for a GUI git client often does not include the node on your
 * PATH. A hook that silently does nothing is the worst outcome here, because
 * fail-silent is exactly what hides it.
 */
export function launchLine(nodePath: string, cliPath: string): string {
  return `( nohup ${shQuote(nodePath)} ${shQuote(cliPath)} pause --auto >/dev/null 2>&1 & )`;
}

/** Environment variable that turns every silent path into a loud one. */
export const DEBUG_ENV = "WHEREWASI_DEBUG";

/**
 * Foreground, output attached — the opposite of `launchLine` in every respect
 * that matters for diagnosis.
 *
 * A debug switch read only inside the node process would be useless here. The
 * two worst bugs this integration has had were an EACCES before node started
 * and a guard that never invoked node at all; in both cases the process that
 * would honour such a flag never ran, and the hook discarded the evidence.
 * Checked at run time rather than baked in at install, so
 * `WHEREWASI_DEBUG=1 git checkout other` works without reinstalling.
 */
export function debugLine(nodePath: string, cliPath: string): string {
  return `${shQuote(nodePath)} ${shQuote(cliPath)} pause --auto`;
}

/**
 * POSIX single-quoting. Inside single quotes the shell expands nothing, so a
 * path containing `$`, a backtick or a space is safe. Double quotes — which is
 * what JSON.stringify produces — still expand `$` and backticks.
 */
export function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * fish single-quoting. Only `\` and `'` are special inside fish single quotes.
 */
export function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function postCheckoutHook(nodePath: string, cliPath: string): string {
  return `#!/bin/sh
# ${MARKER}
# Installed by \`wherewasi install-hook\`. Remove with \`wherewasi install-hook --uninstall\`.
#
# post-checkout receives: $1 previous HEAD, $2 new HEAD, $3 1 if this was a
# branch checkout and 0 if it was a file checkout.

wwi_debug() {
  [ -n "\${${DEBUG_ENV}:-}" ] && echo "wherewasi: $1" >&2
  return 0
}

# Traced before the guards, not after. A guard that wrongly declines is
# indistinguishable from a hook that never ran unless the skip says so — which
# is exactly how the \`git checkout -b\` case stayed hidden.
wwi_debug "post-checkout $1 -> $2 (branch-checkout=$3)"

# File checkouts (\`git checkout -- path\`) are not context switches.
if [ "$3" != "1" ]; then
  wwi_debug "skipped: file checkout, not a branch checkout"
  exit 0
fi

# The checkout that ends \`git clone\` reports an all-zero previous HEAD. There
# is no prior context in a repo you just cloned, so skip it. Matched as
# "contains no non-zero character" to cover both SHA-1 and SHA-256 repos.
#
# Deliberately NOT skipped when $1 = $2: switching between two branches that
# point at the same commit, and \`git checkout -b\`, both leave HEAD unchanged
# and are both real context switches. Repeat triggers are handled by the
# debounce in \`pause --auto\`, not here.
case "$1" in
  *[!0]*) ;;
  *)
    wwi_debug "skipped: previous HEAD is all zeros, this is the checkout ending a clone"
    exit 0
    ;;
esac

if [ -n "\${${DEBUG_ENV}:-}" ]; then
  # Foreground, output attached. The only way to see a capture that dies before
  # it can report anything — which is what the normal path is built to hide.
  ${debugLine(nodePath, cliPath)}
  echo "wherewasi: capture exited $?" >&2
else
  ${launchLine(nodePath, cliPath)}
fi

# Never fail the checkout, whatever happened above.
exit 0
`;
}

export function shellSnippet(shell: Shell, nodePath: string, cliPath: string): string {
  const launch = launchLine(nodePath, cliPath);

  if (shell === "fish") {
    // fish cannot express this itself. `( … )` is command substitution, not a
    // subshell, so the POSIX form is a syntax error — and with fish's own
    // backgrounding the capture is killed during startup regardless of `nohup`
    // and `disown` (measured: 0 captures either way, foreground works).
    //
    // Delegating to sh fixes both. The intermediate sh forks the capture and
    // exits immediately, leaving it reparented with nothing for fish to kill.
    return `# ${MARKER}
# Add to ~/.config/fish/config.fish:
#   wherewasi shell-init fish | source

function __wherewasi_auto_capture --on-event fish_exit
    if set -q ${DEBUG_ENV}
        command ${debugLine(nodePath, cliPath)}
    else
        command sh -c ${fishQuote(launch)}
    end
end
`;
  }

  // bash and zsh share EXIT-trap semantics closely enough for one snippet.
  // zsh runs zshexit for interactive shells; trap EXIT covers both shells and
  // does not depend on the shell being interactive.
  return `# ${MARKER}
# Add to ~/.${shell}rc:
#   eval "$(wherewasi shell-init ${shell})"

__wherewasi_auto_capture() {
  if [ -n "\${${DEBUG_ENV}:-}" ]; then
    ${debugLine(nodePath, cliPath)}
    echo "wherewasi: capture exited $?" >&2
  else
    ${launch}
  fi
}
trap __wherewasi_auto_capture EXIT
`;
}

/** Reads $SHELL. Returns null rather than guessing when it is unrecognised. */
export function detectShell(env: Record<string, string | undefined>): Shell | null {
  const raw = env["SHELL"];
  if (!raw) return null;
  const name = path.basename(raw.trim());
  return SHELLS.find((s) => name === s || name.endsWith(`-${s}`)) ?? null;
}

export function hookPath(gitDir: string): string {
  return path.join(gitDir, "hooks", "post-checkout");
}

export type InstallOutcome =
  | { ok: true; action: "installed" | "updated"; file: string }
  | { ok: false; reason: "foreign-hook"; file: string };

/**
 * Writes the hook, refusing to overwrite one this tool did not write.
 * Clobbering a project's existing post-checkout hook is destructive and
 * silent, so an unrecognised file is always an error rather than a backup.
 */
export async function installHook(
  gitDir: string,
  nodePath: string,
  cliPath: string,
): Promise<InstallOutcome> {
  const file = hookPath(gitDir);
  const existing = await readIfPresent(file);

  if (existing !== null && !existing.includes(MARKER)) {
    return { ok: false, reason: "foreign-hook", file };
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, postCheckoutHook(nodePath, cliPath), "utf8");
  await chmod(file, 0o755);
  return { ok: true, action: existing === null ? "installed" : "updated", file };
}

export type UninstallOutcome =
  | { ok: true; action: "removed"; file: string }
  | { ok: true; action: "absent"; file: string }
  | { ok: false; reason: "foreign-hook"; file: string };

export async function uninstallHook(gitDir: string): Promise<UninstallOutcome> {
  const file = hookPath(gitDir);
  const existing = await readIfPresent(file);

  if (existing === null) return { ok: true, action: "absent", file };
  if (!existing.includes(MARKER)) return { ok: false, reason: "foreign-hook", file };

  await unlink(file);
  return { ok: true, action: "removed", file };
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
