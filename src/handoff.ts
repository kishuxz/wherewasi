import path from "node:path";
import { captureGit, findRepoId, findRepoRoot } from "./capture.js";
import { listRepos } from "./storage.js";
import type { Analysis, GitState, Session } from "./types.js";

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
      savedAt: session.savedAt,
      actor: session.actor ?? "unknown",
      note: session.note,
    });
  }
  return tasks;
}

export interface Handoff {
  schemaVersion: 1;
  task: string | null;
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
  developerNote: string | null;
  analysis: Analysis | null;
  analysisError: string | null;
  capturedOutputTail: string | null;
  changedFiles: string[];
  diffTruncated: boolean;
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
  };
}

/** Compact agent-readable and human-readable handoff with explicit uncertainty. */
export function formatHandoff(handoff: Handoff): string {
  const out: string[] = [
    `# wherewasi handoff${handoff.task ? `: ${handoff.task}` : ""}`,
    "",
    `Saved: ${handoff.savedAt} by ${handoff.actor} (${handoff.source})`,
    `Repository: ${handoff.repository.savedPath}`,
    `Current location: ${handoff.repository.currentPath}`,
    `Git: ${handoff.repository.savedBranch} ${handoff.repository.savedHead ?? "unknown HEAD"}`,
    `Verification: ${handoff.verification.status}`,
  ];
  for (const reason of handoff.verification.reasons) out.push(`- ${reason}`);
  if (handoff.diffTruncated)
    out.push("- The captured diff was truncated; inspect the current files.");
  if (handoff.developerNote) out.push("", "## Developer note", handoff.developerNote);
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
    'Check the current repository state before continuing. Update the task with `wherewasi pause --tag <task> "what changed and what is next"`.',
  );
  return `${out.join("\n")}\n`;
}
