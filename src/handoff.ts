import path from "node:path";
import { captureGit, findRepoId, findRepoRoot } from "./capture.js";
import { listRepos, saveSession, withTaskLock } from "./storage.js";
import type { Analysis, CapturedState, GitState, Session } from "./types.js";

export function checkpointToken(session: Session): string {
  return session.checkpointId ?? session.savedAt;
}

export class CheckpointConflictError extends Error {
  constructor(readonly currentCheckpointId: string | null) {
    super("Task checkpoint changed since you read it; get_handoff again before updating.");
    this.name = "CheckpointConflictError";
  }
}

async function sessionsForRepository(cwd: string, home?: string): Promise<Session[]> {
  const repoPath = (await findRepoRoot(cwd)) ?? path.resolve(cwd);
  const repoId = await findRepoId(repoPath);
  const repos = await listRepos({ home, all: true });
  return repos
    .flatMap((repo) => repo.sessions)
    .filter((candidate) =>
      repoId && candidate.repoId ? candidate.repoId === repoId : candidate.repoPath === repoPath,
    )
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export interface HandoffTask {
  task: string | null;
  checkpointId: string;
  savedAt: string;
  actor: Session["actor"] | "unknown";
  note: string | null;
}

/** One latest checkpoint per task, including the latest untagged checkpoint. */
export async function listHandoffTasks(
  cwd: string,
  opts: { home?: string } = {},
): Promise<HandoffTask[]> {
  const sessions = await sessionsForRepository(cwd, opts.home);
  const seen = new Set<string | null>();
  const tasks: HandoffTask[] = [];
  for (const session of sessions) {
    const task = session.tag ?? null;
    if (seen.has(task)) continue;
    seen.add(task);
    tasks.push({
      task,
      checkpointId: checkpointToken(session),
      savedAt: session.savedAt,
      actor: session.actor ?? "unknown",
      note: session.note,
    });
  }
  return tasks;
}

/** Append one tagged revision; a supplied expected id prevents stale agent writes. */
export async function appendTaskCheckpoint(
  state: CapturedState,
  extra: Pick<Session, "analysis" | "analysisError" | "trigger" | "tag" | "actor">,
  opts: { home?: string; expectedCheckpointId?: string; now?: Date } = {},
): Promise<{ session: Session; file: string }> {
  const tag = extra.tag?.trim();
  if (!tag) throw new Error("A tagged checkpoint needs a task name.");
  const identity = state.repoId ?? state.repoPath;
  return withTaskLock(
    identity,
    tag,
    async () => {
      const latest = (await sessionsForRepository(state.repoPath, opts.home)).find(
        (session) => session.tag === tag,
      );
      if (
        opts.expectedCheckpointId !== undefined &&
        (!latest || checkpointToken(latest) !== opts.expectedCheckpointId)
      ) {
        throw new CheckpointConflictError(latest ? checkpointToken(latest) : null);
      }
      // Distinct revisions need a deterministic order even if they arrive in
      // the same millisecond from two agents.
      const now = new Date((opts.now ?? new Date()).getTime());
      if (latest && now.getTime() <= new Date(latest.savedAt).getTime()) {
        now.setTime(new Date(latest.savedAt).getTime() + 1);
      }
      return saveSession(state, { ...extra, tag }, { home: opts.home, now });
    },
    opts.home,
  );
}

export interface Handoff {
  schemaVersion: 1;
  task: string | null;
  checkpointId: string;
  savedAt: string;
  actor: Session["actor"] | "unknown";
  source: "claude-code-session" | "note-and-repository";
  repository: {
    savedPath: string;
    currentPath: string;
    savedBranch: string;
    currentBranch: string;
    savedHead: string | null;
    currentHead: string | null;
  };
  verification: { status: "current" | "changed" | "unverified"; reasons: string[] };
  /** Legacy JSON key; inspect actor to distinguish a human from an agent note. */
  developerNote: string | null;
  analysis: Analysis | null;
  analysisError: string | null;
  capturedOutputTail: string | null;
  changedFiles: string[];
  diffTruncated: boolean;
  /** Absent for checkpoints created before balanced diff sampling. */
  omittedDiffFiles?: number;
}

function verify(saved: GitState, current: GitState, samePath: boolean): Handoff["verification"] {
  const reasons: string[] = [];
  if (!saved.head || !saved.fingerprint || !current.head || !current.fingerprint) {
    reasons.push(
      "A complete Git snapshot is unavailable; verify the checkpoint against the files.",
    );
    return { status: "unverified", reasons };
  }
  if (saved.head !== current.head) reasons.push("HEAD changed since this checkpoint.");
  if (saved.fingerprint !== current.fingerprint)
    reasons.push("Tracked changes or Git status differ from this checkpoint.");
  if (saved.branch !== current.branch)
    reasons.push("The current branch differs from the saved branch.");
  if (reasons.length) return { status: "changed", reasons };
  if (!samePath) {
    reasons.push("This checkpoint came from another worktree; verify its untracked files here.");
  } else if (saved.status.split("\n").some((line) => line.startsWith("??"))) {
    reasons.push("Untracked file contents are not included in the Git fingerprint.");
  }
  return reasons.length ? { status: "unverified", reasons } : { status: "current", reasons };
}

/** Selects a checkpoint by Git repository identity, not by agent or worktree. */
export async function loadHandoff(
  cwd: string,
  tag?: string,
  opts: { home?: string } = {},
): Promise<Handoff | null> {
  const repoPath = (await findRepoRoot(cwd)) ?? path.resolve(cwd);
  const session = (await sessionsForRepository(cwd, opts.home)).find(
    (candidate) => tag === undefined || candidate.tag === tag,
  );
  if (!session) return null;

  const current = await captureGit(repoPath);
  const output = session.input;
  return {
    schemaVersion: 1,
    task: session.tag ?? null,
    checkpointId: checkpointToken(session),
    savedAt: session.savedAt,
    actor: session.actor ?? "unknown",
    source: session.transcript ? "claude-code-session" : "note-and-repository",
    repository: {
      savedPath: session.repoPath,
      currentPath: repoPath,
      savedBranch: session.git.branch,
      currentBranch: current.branch,
      savedHead: session.git.head || null,
      currentHead: current.head || null,
    },
    verification: verify(session.git, current, session.repoPath === repoPath),
    developerNote: session.note,
    analysis: session.analysis,
    analysisError: session.analysisError,
    capturedOutputTail: output ? output.slice(-2000) : null,
    changedFiles: session.recentFiles.filter((f) => f.inGit).map((f) => f.path),
    diffTruncated: session.git.diffTruncated || session.git.stagedDiffTruncated,
    ...(session.git.diffOmittedFiles !== undefined ||
    session.git.stagedDiffOmittedFiles !== undefined
      ? {
          omittedDiffFiles:
            (session.git.diffOmittedFiles ?? 0) + (session.git.stagedDiffOmittedFiles ?? 0),
        }
      : {}),
  };
}

/** Compact agent-readable and human-readable handoff with explicit uncertainty. */
export function formatHandoff(handoff: Handoff): string {
  const out: string[] = [
    `# wherewasi handoff${handoff.task ? `: ${handoff.task}` : ""}`,
    "",
    `Saved: ${handoff.savedAt} by ${handoff.actor} (${handoff.source})`,
    `Checkpoint: ${handoff.checkpointId}`,
    `Repository: ${handoff.repository.savedPath}`,
    `Current location: ${handoff.repository.currentPath}`,
    `Git: ${handoff.repository.savedBranch} ${handoff.repository.savedHead ?? "unknown HEAD"}`,
    `Verification: ${handoff.verification.status}`,
  ];
  for (const reason of handoff.verification.reasons) out.push(`- ${reason}`);
  if (handoff.diffTruncated)
    out.push(
      handoff.omittedDiffFiles === undefined
        ? "- The captured diff was truncated; inspect the current files."
        : `- The captured diff was sampled; ${handoff.omittedDiffFiles} file sections were omitted and shown sections may be partial. Inspect the current files.`,
    );
  if (handoff.developerNote) {
    const heading =
      handoff.actor === "human"
        ? "Developer note"
        : handoff.actor === "unknown"
          ? "Checkpoint note (author unknown)"
          : `Agent note (${handoff.actor})`;
    out.push("", `## ${heading}`, handoff.developerNote);
  }
  if (handoff.analysis) {
    const a = handoff.analysis;
    out.push(
      "",
      "## Model reconstruction (verify before acting)",
      `Goal: ${a.summary}`,
      `Hypothesis: ${a.hypothesis}`,
      `Next step: ${a.next_step}`,
    );
    if (a.ruled_out.length) out.push("Ruled out:", ...a.ruled_out.map((x) => `- ${x}`));
    if (a.working_set.length) out.push("Working set:", ...a.working_set.map((x) => `- ${x}`));
  } else {
    out.push("", "## Analysis unavailable", handoff.analysisError ?? "No analysis was recorded.");
  }
  if (handoff.changedFiles.length)
    out.push("", "## Captured changed files", ...handoff.changedFiles.map((x) => `- ${x}`));
  if (handoff.capturedOutputTail)
    out.push("", "## Captured command output (tail)", "```text", handoff.capturedOutputTail, "```");
  out.push(
    "",
    'Check the current repository state before continuing. Agents can call `update_task` with this checkpoint id; a human can run `wherewasi pause --tag <task> "what changed and what is next"`.',
  );
  return `${out.join("\n")}\n`;
}
