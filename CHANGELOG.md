# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MCP `update_task` appends an explicit agent checkpoint using the `checkpointId` from `get_handoff`; stale updates fail, and simultaneous writes to the same task are serialized across linked worktrees.
- First hosted analysis previews its exact prompt in an interactive terminal and requires endpoint-specific approval; headless and automatic captures save raw state until approved. `pause --local-only` and `WHEREWASI_LOCAL_ONLY=1` suppress hosted analysis.
- `privacy [--fix-permissions]` audits and optionally tightens modes of existing checkpoint files and directories, skipping symlinks.
- `mcp [--repo <path>]` serves local task discovery, handoff reading, and guarded updates over stdio, so Claude Code and Codex can continue the same tagged checkpoint.
- `switch <branch> [note] [--tag <task>] [--create]` saves the departing task before invoking `git switch`.
- `handoff [tag] [--json]` exports a versioned task checkpoint for humans and coding agents. Tagged checkpoints can be read from linked worktrees, with Git revision and tracked-change verification.
- `pause --actor human|claude-code|codex` records who explicitly saved a checkpoint.

### Changed

- Large diffs now sample file sections across the full change and report omitted file counts in `resume` and `handoff`.
- Redaction now covers common database connection URLs, private-key blocks, and credential-file paths in stored checkpoints and model prompts.
- Use Commander 14 so the installed package actually supports the advertised Node 20 minimum.
- Model-generated working-set paths must appear in captured file, diff, note, session, or command-output evidence; unsupported paths cause a raw-state fallback.
- `install-hook` now honors repo-local `core.hooksPath` and refuses to write into a shared hooks directory outside the repository. The post-checkout capture is described as arrival state, separate from the before-switch checkpoint.
- Claude Code conversation access now requires `--with-session` or `WHEREWASI_WITH_SESSION=1`. Assistant reasoning requires the separate `--with-thinking` choice. The first-use notice appears before analysis.
- Session files are published atomically with private permissions. Captures in the same millisecond no longer overwrite each other.

## [0.1.0] - 2026-08-17

First release.

### Added

- **`pause [note] [--since <when>]`** — captures branch, unstaged and staged diffs (8000 chars each), `git log --oneline -10`, `git status --short`, files modified since your last pause (git-changed first, top 40), an optional note, and piped stdin. Sends it to an inference endpoint once and stores the reconstructed reasoning.
- **`resume [tag] [--open]`** — prints the summary, hypothesis, ruled-out list, working set with a reason per file, next step, and how long ago. `--open` opens the working set in `$EDITOR`, skipping files that no longer exist and refusing paths outside the repo.
- **`list`** — recent pauses for this repo: when, branch, first line of the summary. Automatic captures are marked.
- **`status`** — every repo with saved context in one view: most recent pause and age, tag, one-line summary, and what the investigation is blocked on, taken from the `working_set` already recorded. Newest first, stale after 7 days, repos whose directory is gone marked rather than erroring. `--all`, `--json`, and `--prune` (confirms first; `--yes` to skip).
- **Claude Code session ingestion.** `pause` reads up to 8 recent turns of the session for this repo and weights them above the diff, because the session is the developer stating intent while the diff is only residue. Tool traffic is excluded; the assistant's reasoning is included but capped tighter and cut first when the budget bites; every turn is redacted; only provenance is stored, never the turns. `resume` says whether an analysis was reconstructed from a session or inferred from the diff. Opt out of the reasoning alone with `--no-thinking` / `WHEREWASI_NO_THINKING`, or of the whole thing with `--no-session` / `WHEREWASI_NO_SESSION`.
- **`WHEREWASI_DEBUG`** — automatic capture is silent by design; setting this runs it in the foreground with output attached and names every reason it declined, including failures that happen before the process can report on itself. Read at run time, so nothing needs reinstalling.
- **`pause --tag <name>` and `resume <tag>`** — name one investigation among several in a repo, and ask for it back. Tags appear in `list`. A tagged pause anchors its file scan to the last pause with the same tag, not to the globally-latest one.
- **`install-hook`** — opt-in git `post-checkout` hook capturing on branch switch. Prints the hook before writing, refuses to overwrite one it did not write, and has `--dry-run` and `--uninstall`.
- **`shell-init [bash|zsh|fish]`** — opt-in snippet capturing when the shell exits. Writes nothing itself; `--uninstall` prints the line to remove.
- **`pause --auto`** — the mode both integrations use: silent, always exits 0, and debounced to one capture per repo per two minutes.
- **Any OpenAI-compatible endpoint** via `WHEREWASI_BASE_URL` and `WHEREWASI_MODEL` — Groq (default), OpenAI, Together, OpenRouter, DeepSeek, Ollama. Anthropic is selected by base URL or `WHEREWASI_PROVIDER=anthropic`, since its wire format differs.
- **A fully local path.** A local base URL requires no API key, so with Ollama the tool makes no network calls at all.
- **Works with no key.** `pause` still captures and stores everything; `resume` prints the raw state.
- **Secret redaction** applied to the diff, your note and any piped output — before the network call and again before the file is written, so it holds on the keyless path too. Covers `sk-`/`sk_` keys, `gh*_` and `github_pat_` tokens, AWS access key IDs, `Bearer` tokens, and `password`/`secret`/`token`/`api_key` assignments.
- **Bulk-edit detection.** Files written together in a burst — a codemod, a formatter, an agent — are tagged so the model weights them below files you touched individually.
- **Truncation is visible.** `resume` says when a diff was cut at the cap and that the working set may be incomplete, rather than presenting a partial view as a complete one.
- **Semantic validation of the analysis.** Parsing checked that a response was shaped like an analysis, not that it meant anything, and three failures reached users through that gap. Output is now rejected when `summary`, `hypothesis` or `next_step` is empty, when a `working_set` entry contains a JSON fragment the model serialised into its own answer, or when an entry holds a glob or prose where a file path belongs. Rejection degrades exactly like the other guards: raw state stored, reason named, nothing corrupt persisted.
- **Prompt-contamination guard.** An analysis reproducing one of the system prompt's worked examples verbatim is rejected with a message naming the model, instead of being stored as a confident analysis of software that does not exist.

### Notes

- Sessions are stored under `~/.wherewasi/sessions/<hash of repo path>/`, bucketed per repo. Nothing is ever written into your repository.
- No daemon, no telemetry, no account, no config file. `resume` and `list` make no network calls.
- Requires Node 20+.
- Known limits are documented in the [README](https://github.com/kishuxz/wherewasi#known-limits), each linking the open issue tracking it.

[unreleased]: https://github.com/kishuxz/wherewasi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kishuxz/wherewasi/releases/tag/v0.1.0
