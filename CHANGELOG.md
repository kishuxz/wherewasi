# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] - 2026-08-17

First release.

### Added

- **`pause [note] [--since <when>]`** — captures branch, unstaged and staged diffs (8000 chars each), `git log --oneline -10`, `git status --short`, files modified since your last pause (git-changed first, top 40), an optional note, and piped stdin. Sends it to an inference endpoint once and stores the reconstructed reasoning.
- **`resume [tag] [--open]`** — prints the summary, hypothesis, ruled-out list, working set with a reason per file, next step, and how long ago. `--open` opens the working set in `$EDITOR`, skipping files that no longer exist and refusing paths outside the repo.
- **`list`** — recent pauses for this repo: when, branch, first line of the summary. Automatic captures are marked.
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
- **Prompt-contamination guard.** An analysis reproducing one of the system prompt's worked examples verbatim is rejected with a message naming the model, instead of being stored as a confident analysis of software that does not exist.

### Notes

- Sessions are stored under `~/.wherewasi/sessions/<hash of repo path>/`, bucketed per repo. Nothing is ever written into your repository.
- No daemon, no telemetry, no account, no config file. `resume` and `list` make no network calls.
- Requires Node 20+.
- Known limits are documented in the [README](https://github.com/kishuxz/wherewasi#known-limits), each linking the open issue tracking it.

[unreleased]: https://github.com/kishuxz/wherewasi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kishuxz/wherewasi/releases/tag/v0.1.0
