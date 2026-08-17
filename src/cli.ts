#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fstatSync } from "node:fs";
import path from "node:path";
import { captureState, findRepoRoot, parseSince } from "./capture.js";
import { analyze } from "./analyze.js";
import { selectProvider } from "./providers/index.js";
import { redact } from "./redact.js";
import { latestSession, listSessions, saveSession } from "./storage.js";
import { formatList, formatResume, makePaint, splitWorkingSetEntry } from "./format.js";
import type { Session } from "./types.js";

const STDIN_LIMIT = 8000;
const STDIN_WAIT_MS = 3000;

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

async function cmdPause(note: string | undefined, opts: { since?: string }): Promise<void> {
  const paint = makePaint();
  const started = Date.now();

  const input = await readStdin();

  // Anchor the mtime scan to the last pause for this repo. A fixed window is
  // wrong in both directions: too short after a long absence, too long after a
  // five-minute interruption.
  const repoPath = await resolveRepoPath();
  let since: Date | null = null;
  let sinceSource: "last-pause" | "explicit" | undefined;

  if (opts.since) {
    since = parseSince(opts.since);
    if (!since)
      fail(`could not parse --since "${opts.since}" (try 30m, 2h, 1d, or an ISO timestamp)`);
    sinceSource = "explicit";
  } else {
    const previous = await latestSession(repoPath);
    if (previous) {
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

  const selection = selectProvider(process.env);
  const hasKey = selection.provider !== null;
  if (hasKey) {
    process.stderr.write(
      paint(`  reconstructing context via ${selection.provider!.name}…\n`, "dim"),
    );
  }

  const { analysis, error } = await analyze(stored, { provider: selection.provider });
  const { session, file } = await saveSession(stored, { analysis, analysisError: error });

  const totalMs = Date.now() - started;
  process.stdout.write("\n");

  if (analysis) {
    // One sentence only — you are being interrupted, not reading a report.
    const gist = analysis.summary.split(/(?<=\.)\s/)[0] ?? analysis.summary;
    process.stdout.write(`  ${paint("✓", "green")} Context saved. ${paint(gist, "dim")}\n`);
  } else {
    process.stdout.write(
      `  ${paint("✓", "green")} State saved (${stored.recentFiles.length} recent files, ${stored.git.branch || "no branch"}).\n`,
    );
    if (!hasKey) {
      process.stdout.write(
        `    ${paint("Set WHEREWASI_API_KEY to also capture the reasoning behind it.", "yellow")}\n`,
      );
    } else {
      process.stdout.write(`    ${paint(`Analysis unavailable: ${error}`, "yellow")}\n`);
    }
  }

  process.stdout.write(
    `    ${paint(`${file}  ·  capture ${captureMs}ms, total ${totalMs}ms`, "dim")}\n\n`,
  );
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

async function cmdResume(opts: { open?: boolean }): Promise<void> {
  const repoPath = await resolveRepoPath();
  const session = await latestSession(repoPath);
  if (!session) {
    const paint = makePaint();
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

const program = new Command();

program
  .name("wherewasi")
  .description(
    "Save and restore your mental context across interruptions.\nEverything stays on this machine except one Anthropic API call.",
  )
  .version("0.1.0");

program
  .command("pause")
  .argument("[note]", "freeform note about what you were doing")
  .option(
    "--since <when>",
    "scan files modified since 30m / 2h / 1d / an ISO timestamp (default: your last pause)",
  )
  .description("capture what you were working on, and why")
  .action(async (note: string | undefined, opts: { since?: string }) => {
    await cmdPause(note, opts);
  });

program
  .command("resume")
  .option("--open", "open the working set in $EDITOR")
  .description("print the most recent pause for this repo")
  .action(async (opts: { open?: boolean }) => {
    await cmdResume(opts);
  });

program
  .command("list")
  .description("list recent pauses for this repo")
  .action(async () => {
    await cmdList();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
