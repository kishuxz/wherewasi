# Contributing

Bug reports are the most useful thing you can send. Read [Filing a bug](#filing-a-bug) — the four questions the form asks are the ones that decide whether a report is diagnosable.

## Running it

Node 20+ and pnpm.

```sh
pnpm install
pnpm test                            # 239 tests, ~800ms, no network
pnpm dev pause "trying something"    # run the CLI from source
pnpm dev resume
```

Use `pnpm dev <args>`, not `pnpm run dev -- <args>`. pnpm consumes a leading option after `--`, so `pnpm run dev -- --version` fails while `pnpm dev --version` works. Options after a subcommand are fine either way.

The full set, in the order CI runs it:

```sh
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

CI runs exactly these on Node 20. If they pass locally they pass there.

### Tests never touch the network

Provider tests run against a stub HTTP server, and `test/helpers/fixture-repo.ts` builds throwaway git repos with controllable mtimes. You do not need an API key to work on this, and a test that requires one will not be merged — a suite that only passes with credentials is a suite most contributors cannot run.

To exercise a real model, point it at a local one and spend nothing:

```sh
ollama pull qwen2.5:7b
WHEREWASI_BASE_URL=http://localhost:11434/v1 WHEREWASI_MODEL=qwen2.5:7b pnpm dev pause "note"
```

## When a hook is not firing, set `WHEREWASI_DEBUG`

Do this first. Automatic capture discards its output on purpose — an error printed into someone's `git checkout` is worse than a capture that did not run — so every failure looks identical to nothing happening. `WHEREWASI_DEBUG` turns all of it loud:

```sh
WHEREWASI_DEBUG=1 git checkout some-branch
```

```
wherewasi: post-checkout a4d77a2f… -> a4d77a2f… (branch-checkout=1)
wherewasi: skipped: last pause for this repo was 2s ago, under the 120s auto floor
wherewasi: capture exited 0
```

It is read at run time by the hook and the shell snippets, so you do not reinstall anything to use it. That matters: it switches the capture from detached-and-discarded to **foreground with output attached**, which is the only way to see a failure that happens before the process can report on itself. A flag checked only inside the CLI would miss most of what goes wrong here.

What it reports:

| situation                       | what you see                                                       |
| ------------------------------- | ------------------------------------------------------------------ |
| hook fired at all               | the trace line, with both HEADs and the branch-checkout flag       |
| a guard declined                | `skipped: file checkout…` / `skipped: previous HEAD is all zeros…` |
| debounced                       | `skipped: last pause … under the 120s auto floor`                  |
| capture ran                     | files captured, branch, and the session path written               |
| analysis failed                 | the provider error verbatim                                        |
| capture threw                   | the error and its stack                                            |
| the binary could not even start | your shell's own error, plus `capture exited 126`                  |

The last two rows are the point. Three real bugs shipped in the first cut of this feature — an `EACCES` on every capture, `git checkout -b` silently skipped, and an `index.lock` collision — and all three were invisible until instrumented by hand. Two of them happened _before_ node started or without invoking it at all, so anything that only changed behaviour inside the CLI would not have found them.

`WHEREWASI_DEBUG` never changes the contract: the hook still exits 0, and `pause --auto` still exits 0.

## The convention

One unit of work per issue, per branch, per PR.

1. **Open an issue first**, titled as the commit will be: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `ci:`. Say what is wrong and why it matters, not what to type.
2. **Branch as `type/slug`** off `main` — `fix/recency-window`, `docs/contributing`.
3. **Commit messages explain the why.** The diff already shows the what. If the subject line is the whole story, the body can be empty; if it isn't, write the body.
4. **PR body**: `Closes #N`, a _What changed_ table, the reasoning behind non-obvious decisions, and a **Verified** section reporting what you actually ran.
5. **Squash merge**, base-first for stacked work.

No AI attribution in commits or PR bodies.

### What "Verified" means

Paste real output. `pnpm test` passing is the floor, not the evidence — the interesting part is what you ran to convince yourself the change does what you claim, including the thing you expected to fail. Negative results belong in the PR too: if you tried an approach and it did not work, that is worth more to the next person than a clean narrative.

If you change anything the model sees — the system prompt, what `buildPrompt` includes, the diff cap — say so explicitly and report the effect on the [evaluation scenarios](#evaluating-a-prompt-change).

## Evaluating a prompt change

Prompt edits cannot be verified by unit tests. They are judged against four captured scenarios on five criteria: does `summary` name the problem rather than restate the diff, is `hypothesis` specific and falsifiable, is `ruled_out` backed by evidence of an abandoned attempt, does `working_set` give a reason per file, is a blocker named where one exists.

Two rules learned the hard way:

- **Never draw few-shot examples from your evaluation scenario.** Weak models copy them verbatim and the result looks like your best run. See the design note in the [README](README.md#design-note-the-prompt-examples-nearly-shipped-a-landmine).
- **Run the weakest model you support, not just the strongest.** Both regressions worth catching were found that way.

## Filing a bug

The [bug form](https://github.com/kishuxz/wherewasi/issues/new?template=bug_report.yml) asks for provider, base URL, model, Node version, and whether `resume` printed the truncation warning. Those four decide whether a report is diagnosable:

- **Provider and base URL** — Groq, OpenAI, Ollama and Anthropic fail differently, and Anthropic is a separate wire format entirely.
- **Model** — below roughly 70B, output degrades into something structurally valid and substantively useless ([#26](https://github.com/kishuxz/wherewasi/issues/26)). That looks exactly like a tool bug.
- **Node version** — the package requires >= 20.
- **The truncation warning** — a narrow `working_set` on a truncated diff is documented behaviour ([#25](https://github.com/kishuxz/wherewasi/issues/25)), not a defect. Without knowing whether the warning appeared, the two are indistinguishable.

**Session files contain your code.** They hold your diff, your note and any piped output — redacted for secrets, but not for source. Do not paste one into a public issue without reading it first. The relevant fragment is almost always enough.

## Scope

The commands are `pause`, `resume`, `list` and `status`, plus the opt-in `install-hook` and `shell-init`. No daemon, no editor plugin, no web UI, no team features, no config file. A PR adding one of those will be declined regardless of quality — please open an issue first if you think a case is genuinely different.
