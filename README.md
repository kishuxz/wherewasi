# wherewasi

**Save and restore your mental context across interruptions.**

Existing tools save your files and your tabs. None of them save _why_ those files were open, or what you'd already ruled out. That reasoning state is the expensive part — and it's the part that evaporates when someone taps you on the shoulder.

```sh
npx wherewasi pause "expired tokens still pass"
```

---

## Local-first. Read this part.

Your code does not go anywhere. Concretely:

- **Everything is stored on your machine**, under `~/.wherewasi/`. Nothing is uploaded, synced, or backed up.
- **Nothing is ever written into your repo.** Not a dotfile, not a `.gitignore` entry, nothing. Storage lives in your home directory only.
- **There is no server, no daemon, no telemetry, no account, no background process.** The binary runs when you type it and exits.
- **Exactly one network call is ever made**: a single request to the Anthropic API during `pause`, to turn the captured state into a summary. That's the entire network surface. `resume` and `list` make no network calls at all.
- **Secrets are stripped before that call** — key prefixes (`sk-`, `ghp_`, `AKIA`, …) and `password`/`secret`/`token`/`api_key` assignments are redacted from the diff, the note, and any piped output. The redaction is applied to the stored file too, so it also holds when you never set a key. ([Tests](test/redact.test.ts).)
- **No key? It still works.** Without `ANTHROPIC_API_KEY` there are zero network calls, and `resume` prints your raw captured state instead.

You can verify all of the above: it's under 1000 lines in [`src/`](src/).

---

## Install

```sh
npx wherewasi pause          # zero install, zero config
```

Or keep it on `$PATH`:

```sh
npm install -g wherewasi
```

Optional, for the reasoning reconstruction:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

There is no config file and no settings. That's deliberate.

---

## Demo

```console
$ pnpm test 2>&1 | wherewasi pause "expired tokens still pass"
  reconstructing context…

  ✓ Context saved. You were tracking down why expired sessions still authenticate.
    ~/.wherewasi/sessions/463e7d89baf9/2026-01-15T14-22-08.410Z.json  ·  capture 24ms, total 2.1s

# ... two hours of meetings ...

$ wherewasi resume

← where you were  2 hours ago · fix/session-expiry

  You were tracking down why expired sessions still authenticate. You had just
  rewritten verify() to compare against t.exp, and the failing test says an
  expired token is still accepted. You appeared to be mid-way through
  confirming the unit mismatch.

  Hypothesis
    verify() compares a seconds-based `exp` claim against a millisecond
    Date.now(), so every token looks far in the future.

  Already ruled out
    ✗ A missing null guard — you tried `if (!t) return false;` and left it
      commented out because the test still failed

  Working set
    src/auth.js — the verify() comparison you were editing when the test failed
    src/config.js — defines ttl = 3600, the seconds-based value feeding exp

  Next step
    Multiply t.exp by 1000 (or compare Date.now()/1000) and re-run
    auth.test.js to confirm the expired-token case now fails closed.

  Your note
    expired tokens still pass

$ wherewasi resume --open      # reopen the working set in $EDITOR
```

---

## Commands

### `wherewasi pause [note]`

Captures, in order:

|       |                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| git   | current branch, `git diff`, `git diff --staged` (8000 chars each), `git log --oneline -10`, `git status --short`          |
| files | everything modified in the last 2 hours under the repo, excluding `node_modules/`, `dist/`, `.git/`, newest first, top 15 |
| note  | the optional freeform argument                                                                                            |
| stdin | piped input, if any                                                                                                       |

The git commands run concurrently; capture completes in tens of milliseconds. The note and the piped output are the highest-signal inputs — `pnpm test 2>&1 | wherewasi pause "auth failing"` gives the model the failure _and_ your read on it.

### `wherewasi resume [--open]`

Prints the most recent pause for this repo — summary, hypothesis, ruled-out list, working set with reasons, next step, and how long ago you saved it. `--open` opens the working-set files in `$EDITOR`, skipping any that no longer exist.

### `wherewasi list`

Recent pauses for this repo: when, branch, first line of the summary.

---

## Where things are stored

```
~/.wherewasi/sessions/<sha256(repo path)[0..12]>/<ISO timestamp>.json
```

One JSON file per pause, holding the raw captured state plus the analysis. Repos are bucketed by a hash of their absolute path, so `resume` in one repo never shows you another one's context. Delete a directory to forget a repo; delete `~/.wherewasi` to forget everything.

---

## Without an API key

`pause` captures and stores everything exactly as it would otherwise — it just skips the one network call. `resume` then prints the raw state (note, working tree, recently touched files, recent commits, tail of any captured output) and tells you what a key would add. The tool is useful without one; it's better with one.

---

## What this deliberately isn't

No daemon. No background process. No editor plugin. No web UI. No team features. No config file. No settings.

If it isn't `pause`, `resume`, or `list`, it isn't in here.

---

## Development

```sh
pnpm install
pnpm test        # capture, storage, redaction, formatting, API request shape
pnpm build
pnpm dev pause "trying something"
```

Node 20+, TypeScript, ESM. The Anthropic call uses `claude-sonnet-4-6`.

MIT.
