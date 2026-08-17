# wherewasi

[![CI](https://github.com/kishuxz/wherewasi/actions/workflows/ci.yml/badge.svg)](https://github.com/kishuxz/wherewasi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/wherewasi)](https://www.npmjs.com/package/wherewasi)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/kishuxz/wherewasi/blob/main/LICENSE)

Returning to a task after an interruption costs about 23 minutes for knowledge workers, and more for developers, because what you lose isn't your place in a file — it's a mental model of the code, the data flow, and the hypothesis you were testing. Every other tool saves your files and your tabs; none of them save _why_ those files were open or what you'd already ruled out. `wherewasi` captures that reasoning state before you walk away and hands it back when you return.

```sh
npx wherewasi pause "auth token refresh still failing"
```

---

## What it actually looks like

Real output, verbatim, from a half-finished symbol rename across a TypeScript monorepo — three packages migrated, a fourth missed, a debug print left mid-investigation, and a broken build:

```console
$ pnpm test 2>&1 | wherewasi pause "auth token refresh still failing"
  reconstructing context via openai-compatible…

  ✓ Context saved. You were trying to get the collector's auth token refresh logic to work.
    ~/.wherewasi/sessions/a974b03ce715/2026-08-17T04-20-11.000Z.json  ·  capture 24ms, total 4261ms
```

Then, after the interruption:

```console
$ wherewasi resume

← where you were  6 minutes ago · main

  You were trying to get the collector's auth token refresh logic to work
  before the build can succeed

  Hypothesis
    You suspect the token-age check and the placeholder refreshSinkToken
    implementation aren't correctly updating the token, causing the refresh to
    never actually happen

  Working set
    packages/guard/src/index.ts — guard build fails because @checkpoint/core no longer exports the member evaluate, blocking the test run
    packages/collector/src/index.ts — contains the token-age check, refreshSinkToken stub, and debug logging you added to investigate the refresh failure

  Next step
    Add an export alias in packages/core/src/index.ts (e.g., `export const
    evaluate = evaluateRun;`) or update guard imports to use evaluateRun so
    the guard package can build again

  Your note
    auth token refresh still failing
```

Nothing in that diff said _why_ the rename was happening. The note said the goal; the tool connected it to the evidence and, separately, noticed the build was broken in a package that has nothing to do with the goal.

---

## It reads your Claude Code session

The obvious objection to this tool is _"I'm already in a Claude Code session — I'll just ask it to write me a handoff doc."_ That is fair, and the answer is not to compete with it. Claude Code **witnessed** your reasoning. `wherewasi` only ever saw the residue: a diff, some mtimes. So it reads the session instead of guessing at it, and keeps the automatic triggering a handoff doc does not have.

`resume` tells you which kind of answer you are holding:

```
← where you were  6 minutes ago · main · token-refresh
  reconstructed from your Claude Code session — 8 turn(s)
```

versus

```
  inferred from the diff
```

### Exactly what is read

Reading an AI conversation is a bigger step than reading a diff, so here is all of it, plainly:

|                    |                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Where from**     | `~/.claude/projects/<encoded repo path>/<session>.jsonl` — the newest session whose records match this repo                 |
| **What**           | up to 8 recent turns of **your messages and the assistant's replies**, capped at 1,500 characters per turn and 4,500 total  |
| **Never**          | `thinking` blocks, tool calls, tool output, or any session belonging to another repo                                        |
| **Where it goes**  | into the one `pause` request, to the endpoint you configured — the same call the diff already goes to                       |
| **What is stored** | provenance only: source, session id, turn count. **The turns are never written to disk.**                                   |
| **Redaction**      | the same secret-stripping as the diff, applied to every turn — people paste keys into chat far more casually than into code |

Two separate switches, because "read my session" and "read the model's reasoning" are different questions:

```sh
wherewasi pause --no-thinking     # read the session, leave the reasoning out
wherewasi pause --no-session      # read nothing

export WHEREWASI_NO_THINKING=1    # persist either one
export WHEREWASI_NO_SESSION=1
```

`--no-thinking` gives the whole budget back to speech rather than leaving a hole in it.

The first time a transcript is actually ingested, `pause` says so once, rather than leaving it to this file to be read.

And the strongest form: point `WHEREWASI_BASE_URL` at a local model and your conversation never leaves the machine at all — see [zero network calls](#or-make-it-zero-network-calls).

Claude Code only for now. No Cursor, no others.

---

## Local-first. Read this part.

Your code does not go anywhere. Concretely:

- **Everything is stored on your machine**, under `~/.wherewasi/`. Nothing is uploaded, synced or backed up.
- **Nothing is ever written into your repo.** Not a dotfile, not a `.gitignore` entry. Storage lives in your home directory only.
- **No server, no daemon, no telemetry, no account.** The binary runs and exits. Nothing is resident. If you opt into [automatic capture](#capturing-without-remembering-to), a `pause` is spawned detached by your git hook or shell and exits the same way — still no daemon, still nothing running between captures.
- **Exactly one network call**, during `pause`, to whichever inference endpoint you configured. `resume` and `list` make none.
- **Secrets are stripped before that call, and again before the file is written** — `sk-`, `gh*_`, `AKIA`, `Bearer`, and `password`/`secret`/`token`/`api_key` assignments. Applied to the diff, your note, any piped output, and every ingested session turn. ([Tests](https://github.com/kishuxz/wherewasi/blob/main/test/redact.test.ts).)
- **No key? It still works.** `pause` captures and stores everything; `resume` prints the raw state.

### Or make it zero network calls

Point it at a local model and nothing leaves the machine at all:

```sh
export WHEREWASI_BASE_URL=http://localhost:11434/v1
export WHEREWASI_MODEL=qwen2.5:7b     # ollama pull qwen2.5:7b
wherewasi pause "still chasing the token refresh"
```

No API key is required for a local endpoint. This is verified, not theoretical — but read the model-size floor under **Known limits** first, because a 7B model produces noticeably weaker analysis.

---

## Install

```sh
npx wherewasi pause          # zero install
```

Or keep it on `$PATH`:

```sh
npm install -g wherewasi
```

### Then point it at a model

`pause` and `resume` work immediately with no key — you get the files and the diff. The reasoning above needs a model behind it, and there are two ways to get one.

**Fully local. No key, no account, nothing leaves your machine:**

```sh
ollama pull qwen2.5:7b
export WHEREWASI_BASE_URL=http://localhost:11434/v1
export WHEREWASI_MODEL=qwen2.5:7b
```

**Hosted, if you want the sharper analysis** — any OpenAI-compatible endpoint; the default is Groq's free tier running a 120B model:

```sh
export WHEREWASI_API_KEY=...
```

Both are real options, and the tradeoff is honest: a 7B local model is noticeably weaker than a 120B hosted one (see [Known limits](#known-limits)). Pick privacy or pick quality — the tool does not care, and `pause` tells you how to set either up the first time you run it without a key.

---

## Configuring the model

Three environment variables. Defaults get you running on Groq's free tier.

| variable             | default                          | notes                             |
| -------------------- | -------------------------------- | --------------------------------- |
| `WHEREWASI_API_KEY`  | —                                | not required for a local endpoint |
| `WHEREWASI_BASE_URL` | `https://api.groq.com/openai/v1` | any OpenAI-compatible endpoint    |
| `WHEREWASI_MODEL`    | `openai/gpt-oss-120b`            |                                   |

Anything speaking OpenAI chat-completions works with no code change:

```sh
# OpenAI
WHEREWASI_BASE_URL=https://api.openai.com/v1     WHEREWASI_MODEL=gpt-4o
# Together
WHEREWASI_BASE_URL=https://api.together.xyz/v1   WHEREWASI_MODEL=...
# OpenRouter
WHEREWASI_BASE_URL=https://openrouter.ai/api/v1  WHEREWASI_MODEL=...
# DeepSeek
WHEREWASI_BASE_URL=https://api.deepseek.com/v1   WHEREWASI_MODEL=deepseek-chat
# Ollama — fully local, no key
WHEREWASI_BASE_URL=http://localhost:11434/v1     WHEREWASI_MODEL=qwen2.5:7b
```

**Anthropic** uses a different wire format and is selected automatically by its base URL, or explicitly with `WHEREWASI_PROVIDER=anthropic`:

```sh
WHEREWASI_BASE_URL=https://api.anthropic.com  WHEREWASI_MODEL=claude-sonnet-4-6
```

`GROQ_API_KEY` and `ANTHROPIC_API_KEY` still work if the newer names are unset.

There is no config file, and there won't be. `.env` is not loaded automatically — `set -a; source .env; set +a`.

---

## Commands

### `wherewasi pause [note] [--since <when>] [--tag <name>]`

Captures, in order:

|       |                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------- |
| git   | branch, `git diff`, `git diff --staged` (8000 chars each), `git log --oneline -10`, `git status --short` |
| files | files modified since your last pause, git-changed ones first, top 40                                     |
| note  | the optional freeform argument                                                                           |
| stdin | piped input, if any                                                                                      |

git is the primary signal because it's time-independent. The mtime scan supplements it, anchored to your previous pause rather than a fixed window — `--since 30m`, `--since 1d`, or an ISO timestamp overrides it; with no prior pause it falls back to 2 hours.

The highest-signal invocation pipes a failure in:

```sh
pnpm test 2>&1 | wherewasi pause "auth failing"
```

### `wherewasi resume [tag] [--open]`

Prints the most recent pause: summary, hypothesis, ruled-out list, working set with reasons, next step, and how long ago. `--open` opens the working set in `$EDITOR`, skipping files that no longer exist.

### Several investigations at once

Parallel agents and worktrees mean one repo often has more than one thing in flight. Tag a pause and ask for it back by name:

```sh
wherewasi pause --tag token-refresh "the refresh never fires"
wherewasi pause --tag grid-layout   "collapses under 400px"

wherewasi resume token-refresh
```

```console
$ wherewasi list

  WHEN      BRANCH  TAG            SUMMARY
  just now  main                   (no analysis) untagged, just stepping away
  just now  main    grid-layout    (no analysis) the grid collapses at 400px
  just now  main    token-refresh  (no analysis) chasing the refresh
```

A tagged pause anchors its file scan to your last pause **with the same tag**. Anchoring to the globally-latest pause would be wrong here — it belongs to the other investigation, and would give this one a window far too short. Asking for a tag that does not exist tells you which ones do.

### `wherewasi status`

`resume` and `list` are both scoped to one repo. Neither can answer _"what am I in the middle of?"_, because with several worktrees and a couple of agents running, that question spans repos.

```console
$ wherewasi status

  collector-api  just now · main · token-refresh  from session
    ~/conductor/workspaces/collector-api
    You were trying to get the collector auth token refresh working.
    blocked: packages/guard/src/index.ts — guard build fails because core no longer exports evaluate, blocking the test run

  grid-ui  2 weeks ago · main  stale
    ~/conductor/workspaces/grid-ui
    You were fixing the responsive grid collapse.

  doomed-worktree  3 days ago · main  directory gone
    ~/conductor/workspaces/doomed-worktree
    (no analysis) half-done migration

  1 repo no longer exists on disk. Remove with wherewasi status --prune.
```

Newest first, anything past a week flagged `stale`, and the blocker taken from the `working_set` the analysis already recorded rather than worked out again.

Ephemeral worktrees mean saved context routinely outlives its directory — that is normal, so it is marked rather than treated as an error:

```sh
wherewasi status --all      # every session, not just the latest per repo
wherewasi status --json     # for scripting
wherewasi status --prune    # drop context for repos that are gone (asks first; --yes to skip)
```

### `wherewasi list`

Recent pauses for this repo: when, branch, first line of the summary. Automatic captures are marked `⟳`, so the pause you deliberately made stays findable.

---

## Capturing without remembering to

The obvious flaw in a tool you have to run _before_ an interruption is that you do not see the interruption coming. Two opt-in integrations remove the dependency. Neither is on unless you turn it on.

```sh
wherewasi install-hook                  # capture on branch switch
eval "$(wherewasi shell-init zsh)"      # capture when the shell exits
```

`bash` and `zsh` take that `eval` line in `~/.bashrc` / `~/.zshrc`. fish uses its own syntax, in `~/.config/fish/config.fish`:

```fish
wherewasi shell-init fish | source
```

`install-hook` writes a git `post-checkout` hook into the current repo. `shell-init` prints a snippet for your `~/.zshrc`, `~/.bashrc`, or `~/.config/fish/config.fish` — it writes nothing itself. Both print exactly what they will do first, and both come back out:

```sh
wherewasi install-hook --dry-run        # print the hook, write nothing
wherewasi install-hook --uninstall      # remove it
wherewasi shell-init zsh --uninstall    # print the line to delete
```

**It will not slow your commands down.** The capture is detached and its output discarded, so `git checkout` returns immediately — measured at ~9.5ms without the hook and ~17ms with it, all of which is forking a subshell rather than waiting for anything. It cannot fail your checkout either: the hook exits 0 unconditionally, and `pause --auto` exits 0 whatever happens.

**It will not fight your other git commands.** Captures read git state with `GIT_OPTIONAL_LOCKS=0`, so they never take `.git/index.lock`. Without that, a capture triggered by one checkout can make your _next_ git command fail with `Unable to create index.lock` — which it did, before this was fixed.

**It will not clobber an existing hook.** If `.git/hooks/post-checkout` exists and wherewasi did not write it, install refuses and tells you. Uninstall likewise removes only its own.

**It will not spam.** Automatic captures for a repo are debounced to one per two minutes, so closing four terminals or switching branches three times in a row costs one capture, not four. Deliberate `wherewasi pause` is never debounced.

Two honest limits. `post-checkout` runs _after_ the switch, so the branch recorded is the one you landed on, not the one you left. And a capture triggered by shell exit has no note and nothing piped in, so it is working from the diff alone — which is the weakest evidence this tool takes. Automatic capture is a safety net for the times you forget; a deliberate `pause` with a note is still worth much more.

---

## It separates your attention from your agent's output

An agent that rewrites 60 files in eight seconds leaves 60 fresh mtimes. By mtime alone that is indistinguishable from eight seconds of very focused human attention — and it buries the four files you were actually reasoning about.

`wherewasi` tags clusters of files written together in time and weights them down.

Here is a real capture from a repo where three files were edited by hand over twenty minutes and then an agent generated thirty more in under a second, read back from the stored session:

```console
window: {"from":"2026-08-17T02:59:41.464Z","source":"fallback","bulkCount":30}
files: 33  |  git-changed: 3  |  bulk-tagged: 30

  packages/collector/src/otel.ts              [git]
  packages/guard/src/index.ts                 [git]
  packages/collector/src/index.ts             [git]
  packages/examples/src/generated/gen30.ts    [mtime] [bulk]
  packages/examples/src/generated/gen29.ts    [mtime] [bulk]
  …
  packages/examples/src/generated/gen2.ts     [mtime] [bulk]
  packages/examples/src/generated/gen1.ts     [mtime] [bulk]
```

The thirty machine-written files landed on top of the working set and did not displace it. What reaches the model is this — five bulk files as a sample, the rest as a count, and a note on how to read the tags:

```
<recently_touched_files>
packages/collector/src/otel.ts   2026-08-17T04:48:41.000Z  [git-changed]
packages/guard/src/index.ts      2026-08-17T04:41:41.000Z  [git-changed]
packages/collector/src/index.ts  2026-08-17T04:37:41.000Z  [git-changed]
packages/examples/src/generated/gen30.ts  2026-08-17T04:59:41.395Z  [mtime-only] [bulk-edit]
…
… and 25 more files from the same bulk edit
</recently_touched_files>

<reading_the_file_list>
Files tagged bulk-edit were written together in seconds — a codemod, a formatter,
or an agent — so they show attention far less reliably than files touched
individually. Weight them below the rest. Files tagged git-changed are the
strongest signal; mtime-only files may just have been read or rebuilt.
</reading_the_file_list>
```

Sending all thirty would pay the most tokens for the least signal, which is the opposite of what tagging them was for. Storage still keeps all of them for `resume --open`.

A cluster is 15+ files within 120 seconds. Bulk files are tagged, never dropped — a codemod you ran on purpose is real context.

**The tag is not evidence of authorship.** Bursts are detected by density in time alone, so a file you edited by hand inside the same 120-second window as a codemod gets swept into the group. The git signal contains the damage — git-changed files sort first regardless of the tag — but if you hand-edit in the middle of a bulk rewrite, expect your file to carry `[bulk]`.

---

## Known limits

Measured, not hypothetical. Each links the open issue tracking it.

### Blocked-build detection depends on piping something in

`working_set` flags files that block your next step — a package that fails to compile, the source of a failing test — even when they have nothing to do with your hypothesis. That detection works off the output you pipe in. Run `wherewasi pause` with no piped command output and a broken build in a file you didn't touch will not be mentioned, because nothing in the diff reveals it. Pipe your test command in and it will. ([#42](https://github.com/kishuxz/wherewasi/issues/42))

### Large diffs shrink the working set — but they now say so

Diffs are capped at 8000 characters each. On a large diff, hunks past the cut are invisible to the model, and `working_set` narrows accordingly — in testing, from 4 entries to 2. Inference quality held; _coverage_ dropped.

This used to be silent, which was the dangerous part. `resume` now says so directly:

```
  ⚠ The unstaged diff was truncated at 8000 chars — anything past the cut
  was not analysed, so this working set may be incomplete.
```

The coverage loss itself is still real — the warning tells you to go look, it doesn't recover the hunks. ([#25](https://github.com/kishuxz/wherewasi/issues/25))

### The free-tier request ceiling is real

A big diff plus piped test output can exceed a hosted free tier's per-request token cap and return **HTTP 413**, which — unlike a 429 — retrying never clears. `pause` degrades to storing raw state and says so. If you hit it often, use an endpoint with a larger cap. Prompt length competes with your diff for the same budget, which is why the system prompt is kept tight. ([#25](https://github.com/kishuxz/wherewasi/issues/25))

### Below roughly 70B parameters, output degrades

Same prompt, same repo, an 8B model returned bare filenames with no reasons and a vague next step, plus a hypothesis that was confidently wrong. Structurally valid, substantively useless — and nothing fails, so a bad session looks exactly like a good one. Use a larger model where you can. ([#26](https://github.com/kishuxz/wherewasi/issues/26))

---

## Design note: the prompt examples nearly shipped a landmine

The system prompt uses worked examples to show what a good `summary` and `hypothesis` look like. The first version drew those examples from the scenario the prompt was being tested against — a plausible and, it turns out, dangerous choice.

Running the identical prompt through a small model returned this:

> **summary:** "You were chasing why the collector's auth token stops working about an hour in."
> **hypothesis:** "You suspected the refresh fires but the exporter keeps a client built with the old credentials, so the new token is never used."

Both byte-identical to the prompt's own examples. It looked like the best output of the entire evaluation. It was pure copying — and it only looked correct because the example happened to describe the repository under test. Pointed at any other codebase, the same prompt would have produced a fluent, confident analysis of a bug that does not exist.

It was caught by a model-tier sweep run for an unrelated reason, and confirmed by string-matching the output against the prompt source rather than by reading it, because reading it produced admiration rather than suspicion.

Two changes followed. Examples are now drawn from an **unrelated imaginary project** — a PDF exporter — so copying them produces something obviously absurd in a real repository instead of something plausibly right. And output is now checked against the prompt at runtime: an analysis reproducing an example verbatim is rejected with a message naming the model, rather than stored. ([Test](https://github.com/kishuxz/wherewasi/blob/main/test/analyze.test.ts).)

The general lesson is worth stating plainly, because it is easy to repeat: **few-shot examples drawn from your evaluation scenario make weak models look strong on that scenario and only that scenario.** If your examples resemble your test case, your evaluation is measuring recall, not reasoning.

---

## Storage

```
~/.wherewasi/sessions/<sha256(repo path)[0..12]>/<ISO timestamp>.json
```

One JSON file per pause, holding the raw captured state plus the analysis. Repos are bucketed by a hash of their absolute path, so `resume` never shows you another project's context. Delete a directory to forget a repo; delete `~/.wherewasi` to forget everything.

---

## What this deliberately isn't

No daemon. No background process. No editor plugin. No web UI. No team features. No config file. No settings.

If it isn’t `pause`, `resume`, `list` or `status`, it isn’t in here.

---

## Development

```sh
pnpm install
pnpm test        # 218 tests: capture, storage, redaction, formatting, hooks, transcripts, status, both provider wire formats
pnpm build
```

Node 20+, TypeScript, ESM. No test requires an API key or touches the network.

[CONTRIBUTING.md](https://github.com/kishuxz/wherewasi/blob/main/CONTRIBUTING.md) covers the branch and PR convention, how prompt changes are evaluated, and what a diagnosable bug report contains.

MIT.
