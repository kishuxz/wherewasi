#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fstatSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { captureState, findGitDir, findRepoRoot, parseSince } from "./capture.js";
import { analyze } from "./analyze.js";
import { selectProvider } from "./providers/index.js";
import { redact } from "./redact.js";
import {
  hasAnySession,
  latestSession,
  listSessions,
  listTags,
  rootDir,
  saveSession,
} from "./storage.js";
import { findTranscript, toRef } from "./transcript.js";
import {
  formatList,
  formatResume,
  keylessGuidance,
  makePaint,
  splitWorkingSetEntry,
} from "./format.js";
import {
  DEBUG_ENV,
  SHELLS,
  detectShell,
  hookPath,
  installHook,
  postCheckoutHook,
  shellSnippet,
  uninstallHook,
} from "./hooks.js";
import type { Session } from "./types.js";

const STDIN_LIMIT = 8000;
const STDIN_WAIT_MS = 3000;

/**
 * Floor on the interval between automatic captures for one repo.
 *
 * Both triggers fire in bursts — closing four terminals, or switching branches
 * three times while looking for something. Without a floor that writes a
 * session and spends tokens each time, for context that has not changed.
 * Deliberate `pause` is never debounced.
 */
const AUTO_MIN_INTERVAL_MS = 2 * 60_000;

/**
 * Automatic capture is fail-silent by design, which is right for users and is
 * also how three real bugs survived development. WHEREWASI_DEBUG turns every
 * silent path loud. Written to stderr so it never contaminates stdout.
 */
function debugging(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env[DEBUG_ENV]);
}

function debug(message: string): void {
  if (debugging()) process.stderr.write(`wherewasi: ${message}\n`);
}

/**
 * Single source of truth for the version. `dist/cli.js` and `src/cli.ts` are
 * both exactly one level below the package root, so the same relative path
 * resolves under `tsx` and in the built artifact.
 */
export function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    // Packaged oddly, or bundled — a wrong version is worse than an unknown one.
    return "0.0.0";
  }
}

/**
 * True only for an actual pipe or redirected file. A non-TTY stdin is not
 * enough: under CI, cron, or an editor task runner stdin is often /dev/null,
 * and reading it would block until the process is killed.
 */
function stdinIsPiped(): boolean {
  if (process.stdin.isTTY) return false;
  try {
    const s = fstatSync(0);
    return s.isFIFO() || s.isSocket() || (s.isFile() && s.size > 0);
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string | null> {
  if (!stdinIsPiped()) return null;

  const chunks: Buffer[] = [];
  const collected = (): string => Buffer.concat(chunks).toString("utf8");

  // Bounded: a producer that never closes must not eat the pause budget.
  const text = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      process.stdin.pause();
      resolve(collected());
    }, STDIN_WAIT_MS);

    const finish = () => {
      clearTimeout(timer);
      resolve(collected());
    };

    process.stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
  });

  if (!text.trim()) return null;
  // Keep the tail — failures and summaries land at the end of test output.
  return text.length > STDIN_LIMIT
    ? `… [${text.length - STDIN_LIMIT} earlier chars omitted]\n${text.slice(-STDIN_LIMIT)}`
    : text;
}

async function resolveRepoPath(): Promise<string> {
  const root = await findRepoRoot(process.cwd());
  return root ?? path.resolve(process.cwd());
}

function fail(message: string): never {
  const paint = makePaint();
  process.stderr.write(`${paint("wherewasi:", "red")} ${message}\n`);
  process.exit(1);
}

/**
 * Reading someone's AI conversation is a bigger step than reading their diff,
 * so it is stated once, the first time it actually happens, rather than buried
 * in the README and hoped for.
 */
async function noticeOnce(home: string): Promise<boolean> {
  const flag = path.join(rootDir(home), "session-notice-shown");
  try {
    await access(flag);
    return false;
  } catch {
    try {
      await mkdir(path.dirname(flag), { recursive: true });
      await writeFile(flag, new Date().toISOString(), "utf8");
    } catch {
      // Cannot record it — better to re-notify than to silently never notify.
    }
    return true;
  }
}

async function cmdPause(
  note: string | undefined,
  opts: { since?: string; auto?: boolean; tag?: string; session?: boolean },
): Promise<void> {
  const paint = makePaint();
  const started = Date.now();
  // An automatic capture writes nothing, ever. It is triggered by someone
  // else's command — a git checkout, a shell exiting — and printing into that
  // output is worse than not running.
  const say = opts.auto ? () => {} : (text: string) => void process.stdout.write(text);

  const input = await readStdin();

  // Anchor the mtime scan to the last pause for this repo. A fixed window is
  // wrong in both directions: too short after a long absence, too long after a
  // five-minute interruption.
  const repoPath = await resolveRepoPath();
  const tag = opts.tag?.trim() || undefined;
  if (opts.tag !== undefined && !tag) fail("--tag needs a name");

  let since: Date | null = null;
  let sinceSource: "last-pause" | "explicit" | undefined;

  if (opts.since) {
    since = parseSince(opts.since);
    if (!since)
      fail(`could not parse --since "${opts.since}" (try 30m, 2h, 1d, or an ISO timestamp)`);
    sinceSource = "explicit";
  } else {
    // Anchored within the tag. With two investigations alternating, the
    // globally-latest pause belongs to the other one and yields a window far
    // too short for this one.
    const previous = await latestSession(repoPath, { tag });
    if (previous) {
      // Debounced before any work is done, so a burst of triggers costs a
      // directory read rather than a capture and a network call.
      if (opts.auto && started - new Date(previous.savedAt).getTime() < AUTO_MIN_INTERVAL_MS) {
        const ago = Math.round((started - new Date(previous.savedAt).getTime()) / 1000);
        // The most confusing "the hook is not firing" case is the one where it
        // fired correctly and declined.
        debug(
          `skipped: last pause for this repo was ${ago}s ago, under the ${AUTO_MIN_INTERVAL_MS / 1000}s auto floor`,
        );
        return;
      }
      since = new Date(previous.savedAt);
      sinceSource = "last-pause";
    }
  }

  const state = await captureState({
    cwd: process.cwd(),
    note: note ?? null,
    input,
    since,
    ...(sinceSource ? { sinceSource } : {}),
  });
  const captureMs = Date.now() - started;

  // Redact at rest as well as in flight: the session file is a durable artifact.
  const stored = {
    ...state,
    git: {
      ...state.git,
      diff: redact(state.git.diff),
      stagedDiff: redact(state.git.stagedDiff),
      status: redact(state.git.status),
      log: redact(state.git.log),
    },
    note: state.note ? redact(state.note) : null,
    input: state.input ? redact(state.input) : null,
  };

  // Opt-out is checked before anything is read, not after.
  const sessionsAllowed = opts.session !== false && !process.env["WHEREWASI_NO_SESSION"];
  const transcript = sessionsAllowed ? await findTranscript(repoPath) : null;
  const stateWithSession = transcript
    ? { ...stored, transcript: toRef(transcript) }
    : { ...stored };

  const selection = selectProvider(process.env);
  const hasKey = selection.provider !== null;

  // Read before this pause is written, so the first pause on a machine still
  // counts as a first run. Only needed on the keyless path.
  const sessionsExisted = hasKey || opts.auto || (await hasAnySession());

  if (hasKey && !opts.auto) {
    process.stderr.write(
      paint(`  reconstructing context via ${selection.provider!.name}…\n`, "dim"),
    );
  }

  const { analysis, error } = await analyze(stateWithSession, {
    provider: selection.provider,
    transcript,
  });
  const { session, file } = await saveSession(stateWithSession, {
    analysis,
    analysisError: error,
    trigger: opts.auto ? "auto" : "manual",
    ...(tag ? { tag } : {}),
  });

  if (transcript && !opts.auto) {
    if (await noticeOnce(homedir())) {
      say(
        `\n  ${paint("Note:", "bold")} ${paint("wherewasi read the last few turns of your Claude Code session for", "yellow")}\n` +
          `  ${paint("this repo, to work from what you said rather than only from the diff.", "yellow")}\n` +
          `  ${paint("Turn it off with --no-session, or permanently with WHEREWASI_NO_SESSION=1.", "yellow")}\n` +
          `  ${paint("Point WHEREWASI_BASE_URL at a local model and it never leaves this machine.", "yellow")}\n`,
      );
    }
  }

  const totalMs = Date.now() - started;
  if (opts.auto) {
    debug(`captured ${stored.recentFiles.length} file(s) on ${stored.git.branch || "no branch"}`);
    debug(
      transcript
        ? `read ${transcript.turns} turn(s) from Claude Code session ${transcript.sessionId.slice(0, 8)}`
        : sessionsAllowed
          ? "no Claude Code session found for this repo"
          : "session ingestion disabled",
    );
    if (error) debug(`analysis failed: ${error}`);
    debug(`wrote ${file}`);
  }
  say("\n");

  if (analysis) {
    // One sentence only — you are being interrupted, not reading a report.
    const gist = analysis.summary.split(/(?<=\.)\s/)[0] ?? analysis.summary;
    say(`  ${paint("✓", "green")} Context saved. ${paint(gist, "dim")}\n`);
  } else {
    say(
      `  ${paint("✓", "green")} State saved (${stored.recentFiles.length} recent file${stored.recentFiles.length === 1 ? "" : "s"}, ${stored.git.branch || "no branch"}).\n`,
    );
    if (!hasKey) {
      // Checked before this pause is counted, so the first pause on a machine
      // is the one that gets the full setup block.
      say(keylessGuidance({ firstRun: !sessionsExisted }));
    } else {
      say(`    ${paint(`Analysis unavailable: ${error}`, "yellow")}\n`);
    }
  }

  say(`    ${paint(`${file}  ·  capture ${captureMs}ms, total ${totalMs}ms`, "dim")}\n\n`);
  void session;
}

async function openWorkingSet(session: Session): Promise<void> {
  const paint = makePaint();
  const editor = process.env["EDITOR"] ?? process.env["VISUAL"];
  if (!editor) {
    process.stderr.write(`${paint("wherewasi:", "yellow")} $EDITOR is not set; nothing opened.\n`);
    return;
  }

  const candidates = session.analysis?.working_set.length
    ? session.analysis.working_set.map((e) => splitWorkingSetEntry(e).path)
    : session.recentFiles.map((f) => f.path);

  const existing: string[] = [];
  for (const rel of candidates) {
    const abs = path.resolve(session.repoPath, rel);
    // Never open anything the analysis pointed at outside the repo.
    if (!abs.startsWith(session.repoPath + path.sep)) continue;
    try {
      await access(abs);
      existing.push(abs);
    } catch {
      // file was renamed or deleted since the pause
    }
  }

  if (!existing.length) {
    process.stderr.write(
      `${paint("wherewasi:", "yellow")} none of the working-set files still exist.\n`,
    );
    return;
  }

  const [cmd, ...args] = editor.split(/\s+/);
  if (!cmd) return;
  spawn(cmd, [...args, ...existing], { stdio: "inherit", detached: false });
}

async function cmdResume(tag: string | undefined, opts: { open?: boolean }): Promise<void> {
  const paint = makePaint();
  const repoPath = await resolveRepoPath();
  const wanted = tag?.trim() || undefined;
  const session = await latestSession(repoPath, { tag: wanted });

  if (!session) {
    if (wanted) {
      // Naming the tags that do exist turns a dead end into the next command.
      const known = await listTags(repoPath);
      fail(
        known.length
          ? `no pause tagged "${wanted}" in this repo. Tagged: ${known.join(", ")}`
          : `no pause tagged "${wanted}" in this repo, and nothing here is tagged yet.`,
      );
    }
    process.stdout.write(
      `\n  No saved context for this repo. Run ${paint("wherewasi pause", "cyan")} before your next interruption.\n\n`,
    );
    return;
  }
  process.stdout.write(formatResume(session));
  if (opts.open) await openWorkingSet(session);
}

async function cmdList(): Promise<void> {
  const repoPath = await resolveRepoPath();
  const sessions = await listSessions(repoPath, { limit: 10 });
  process.stdout.write(formatList(sessions));
}

/**
 * Absolute paths to the node running us and to this entrypoint, embedded into
 * the hook and the snippet. Both absolute so an automatic capture does not
 * depend on the PATH of whatever spawned it.
 */
function cliPath(): string {
  return path.resolve(process.argv[1] ?? "wherewasi");
}

function nodePath(): string {
  return process.execPath;
}

async function cmdInstallHook(opts: { uninstall?: boolean; dryRun?: boolean }): Promise<void> {
  const paint = makePaint();
  const gitDir = await findGitDir(process.cwd());
  if (!gitDir) fail("not a git repository — nothing to install a hook into");

  const file = hookPath(gitDir);

  if (opts.uninstall) {
    const result = await uninstallHook(gitDir);
    if (!result.ok) {
      fail(
        `${file} was not written by wherewasi — refusing to remove it.\n` +
          `  Delete it yourself if you are sure.`,
      );
    }
    process.stdout.write(
      result.action === "removed"
        ? `\n  ${paint("✓", "green")} Removed ${file}\n\n`
        : `\n  Nothing to remove — no hook at ${file}\n\n`,
    );
    return;
  }

  const content = postCheckoutHook(nodePath(), cliPath());

  // Printed in full before anything is written. A hook runs on someone's
  // machine on every checkout; they are entitled to read it first.
  process.stdout.write(`\n  ${paint(`Will write ${file}:`, "bold")}\n\n`);
  for (const line of content.trimEnd().split("\n")) {
    process.stdout.write(`    ${paint(line, "dim")}\n`);
  }
  process.stdout.write("\n");

  if (opts.dryRun) {
    process.stdout.write(`  ${paint("--dry-run: nothing written.", "yellow")}\n\n`);
    return;
  }

  const result = await installHook(gitDir, nodePath(), cliPath());
  if (!result.ok) {
    fail(
      `${file} already exists and was not written by wherewasi.\n` +
        `  Refusing to overwrite it. Merge the snippet above in by hand, or move\n` +
        `  the existing hook aside first.`,
    );
  }

  process.stdout.write(
    `  ${paint("✓", "green")} ${result.action === "updated" ? "Updated" : "Installed"} ${result.file}\n` +
      `    Captures on branch switch. Remove with ${paint("wherewasi install-hook --uninstall", "cyan")}.\n\n`,
  );
}

function cmdShellInit(shellArg: string | undefined, opts: { uninstall?: boolean }): void {
  const paint = makePaint();
  const shell = shellArg
    ? (SHELLS.find((s) => s === shellArg) ?? null)
    : detectShell(process.env as Record<string, string | undefined>);

  if (!shell) {
    fail(
      shellArg
        ? `unknown shell "${shellArg}" — expected one of ${SHELLS.join(", ")}`
        : `could not detect your shell from $SHELL — pass one of ${SHELLS.join(", ")}`,
    );
  }

  if (opts.uninstall) {
    const line =
      shell === "fish"
        ? `wherewasi shell-init fish | source`
        : `eval "$(wherewasi shell-init ${shell})"`;
    const rc = shell === "fish" ? "~/.config/fish/config.fish" : `~/.${shell}rc`;
    process.stderr.write(
      `\n  ${paint("Nothing was written by shell-init, so there is nothing to delete.", "bold")}\n` +
        `  Remove this line from ${paint(rc, "cyan")} and restart your shell:\n\n` +
        `    ${paint(line, "dim")}\n\n`,
    );
    return;
  }

  // Snippet to stdout and nothing else, so `eval "$(...)"` stays clean.
  process.stdout.write(shellSnippet(shell, nodePath(), cliPath()));
}

const program = new Command();

program
  .name("wherewasi")
  .description(
    [
      "Save and restore your mental context across interruptions.",
      "",
      "Sessions are stored on this machine only, under ~/.wherewasi.",
      "`pause` makes one call to whichever OpenAI-compatible endpoint you",
      "configure; `resume` and `list` make none. Point WHEREWASI_BASE_URL at a",
      "local model (e.g. http://localhost:11434/v1) and nothing leaves at all.",
    ].join("\n"),
  )
  .version(readVersion());

program
  .command("pause")
  .argument("[note]", "freeform note about what you were doing")
  .option(
    "--since <when>",
    "scan files modified since 30m / 2h / 1d / an ISO timestamp (default: your last pause)",
  )
  .option("--tag <name>", "label this pause, to resume it by name later")
  .option("--no-session", "do not read a Claude Code session for this repo")
  .option("--auto", "triggered automatically: print nothing, debounce, never fail", false)
  .description("capture what you were working on, and why")
  .action(
    async (
      note: string | undefined,
      opts: { since?: string; auto?: boolean; tag?: string; session?: boolean },
    ) => {
      await cmdPause(note, opts);
    },
  );

program
  .command("install-hook")
  .option("--uninstall", "remove the hook")
  .option("--dry-run", "print the hook without writing it")
  .description("install a git post-checkout hook that captures on branch switch")
  .action(async (opts: { uninstall?: boolean; dryRun?: boolean }) => {
    await cmdInstallHook(opts);
  });

program
  .command("shell-init")
  .argument("[shell]", `one of ${SHELLS.join(", ")} (default: detected from $SHELL)`)
  .option("--uninstall", "print how to remove it")
  .description("print a shell snippet that captures when the shell exits")
  .action((shell: string | undefined, opts: { uninstall?: boolean }) => {
    cmdShellInit(shell, opts);
  });

program
  .command("resume")
  .argument("[tag]", "resume the most recent pause carrying this tag")
  .option("--open", "open the working set in $EDITOR")
  .description("print the most recent pause for this repo")
  .action(async (tag: string | undefined, opts: { open?: boolean }) => {
    await cmdResume(tag, opts);
  });

program
  .command("list")
  .description("list recent pauses for this repo")
  .action(async () => {
    await cmdList();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  // An automatic capture must never fail the command that triggered it. A
  // non-zero exit from a post-checkout hook is noise in someone's git output.
  if (process.argv.includes("--auto")) {
    if (debugging()) {
      process.stderr.write(
        `wherewasi: capture threw — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
    }
    process.exit(0);
  }
  fail(err instanceof Error ? err.message : String(err));
});
