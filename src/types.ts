export interface GitState {
  /** false when the command was run outside a git work tree */
  isRepo: boolean;
  branch: string;
  /** `git diff` output, truncated to DIFF_LIMIT chars */
  diff: string;
  /** `git diff --staged` output, truncated to DIFF_LIMIT chars */
  stagedDiff: string;
  /** `git log --oneline -10` */
  log: string;
  /** `git status --short` */
  status: string;
  diffTruncated: boolean;
  stagedDiffTruncated: boolean;
}

export interface RecentFile {
  /** repo-relative, POSIX separators */
  path: string;
  mtime: string;
  /** git also reports this path as changed — the stronger signal of the two */
  inGit?: boolean;
  /** part of a cluster of files written together, likely a bulk or agent edit */
  bulk?: boolean;
}

/** How the mtime scan window was chosen, so `resume` can be honest about it. */
export interface RecencyWindow {
  /** ISO timestamp; files modified after this were considered */
  from: string;
  source: "last-pause" | "fallback" | "explicit";
  /** number of files tagged as part of a bulk edit */
  bulkCount: number;
}

export interface CapturedState {
  /** absolute path used as the storage identity for this repo */
  repoPath: string;
  git: GitState;
  recentFiles: RecentFile[];
  /** absent on sessions written before the window became configurable */
  window?: RecencyWindow;
  note: string | null;
  /** piped stdin, if any */
  input: string | null;
}

export interface Analysis {
  summary: string;
  hypothesis: string;
  ruled_out: string[];
  /** each entry formatted `path — why it matters` */
  working_set: string[];
  next_step: string;
}

export interface Session extends CapturedState {
  version: 1;
  savedAt: string;
  analysis: Analysis | null;
  /** human-readable reason the analysis is missing */
  analysisError: string | null;
}
