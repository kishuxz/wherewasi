#!/usr/bin/env python3
"""Synthesise a Claude Code session for the evaluation scenario.

The harness builds its repos under a temp directory, which has no entry in
`~/.claude/projects`, so ingestion never fires and every run records
`transcript: null`. This writes a realistic session at the path the tool
actually looks in, so the with/without pairing measures something.

    session.py <repo-path> <home-dir>

The content is chosen to make the comparison decisive rather than flattering.
It carries two things the diff physically cannot:

  * the symptom the developer is chasing — the collector going quiet about an
    hour in — which appears nowhere in the code
  * two genuinely abandoned attempts, which is the only evidence that can
    justify a non-empty `ruled_out`

So a run with the session available should produce an evidence-backed
`ruled_out`, and a run with `--no-session` should correctly produce `[]`.
That difference is measurable and not a matter of taste.
"""

import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

# realpath, not abspath. On macOS /var is a symlink to /private/var, so the
# path mktemp hands out is not the path `git rev-parse --show-toplevel`
# reports — and the tool encodes the latter. Using abspath here writes the
# session to a directory the tool never looks in, and the whole with/without
# pairing silently measures nothing.
repo = os.path.realpath(sys.argv[1])
home = os.path.realpath(sys.argv[2])

session_id = str(uuid.UUID(int=0xC0FFEE))  # stable, so reruns are comparable
project_dir = os.path.join(home, ".claude", "projects", repo.replace(os.sep, "-"))
os.makedirs(project_dir, exist_ok=True)
out_path = os.path.join(project_dir, f"{session_id}.jsonl")

start = datetime(2026, 8, 17, 3, 0, tzinfo=timezone.utc)
clock = {"t": 0}


def stamp() -> str:
    clock["t"] += 37
    return (start + timedelta(seconds=clock["t"])).isoformat().replace("+00:00", "Z")


records = []


def emit(record_type: str, content, **extra) -> None:
    records.append(
        {
            "type": record_type,
            "sessionId": session_id,
            "uuid": str(uuid.uuid4()),
            "timestamp": stamp(),
            "cwd": repo,
            "gitBranch": "main",
            "version": "2.1.220",
            "userType": "external",
            "isSidechain": False,
            "message": {"role": "user" if record_type == "user" else "assistant", "content": content},
            **extra,
        }
    )


def user(text: str) -> None:
    emit("user", text)


def assistant(*blocks) -> None:
    emit("assistant", list(blocks))


def text(t: str) -> dict:
    return {"type": "text", "text": t}


def thinking(t: str) -> dict:
    return {"type": "thinking", "thinking": t}


def tool_use(name: str, **inp) -> dict:
    return {"type": "tool_use", "id": f"toolu_{uuid.uuid4().hex[:8]}", "name": name, "input": inp}


def tool_result(payload: str) -> None:
    emit("user", [{"type": "tool_result", "content": payload}])


# --- the conversation -------------------------------------------------------

user(
    "The collector goes quiet about an hour into a run. No crash, no error in the "
    "logs, it just stops reporting. Restarting it fixes it for another hour."
)
assistant(
    thinking(
        "An hour is suspiciously round. That smells like a credential lifetime rather "
        "than a leak or a queue filling up — a leak would degrade gradually and a full "
        "queue would usually surface an error."
    ),
    text("An hour is a suspiciously round number. Before I look at the code — what have you already checked?"),
)

user(
    "I checked the sink URL and the DNS resolution from the container, both fine. "
    "I also tried bumping the HTTP timeout from 5s to 30s in case it was a slow "
    "endpoint — no change, still goes quiet at the same point. I reverted that."
)
assistant(
    thinking(
        "So network path and timeout are both ruled out, and the developer reverted the "
        "timeout change, which means it will not show up in the diff. That leaves auth "
        "as the obvious candidate given the one-hour boundary."
    ),
    text(
        "That rules out the transport, then. A fixed one-hour boundary with a healthy "
        "network path points at the sink token expiring rather than anything in the "
        "request path."
    ),
)

assistant(thinking("Let me look at how the token is set and whether anything refreshes it."), tool_use("Read", file_path=f"{repo}/packages/collector/src/index.ts"))
tool_result(
    "import { evaluateRun } from '@checkpoint/core';\nlet sinkToken = '';\n"
    "export function setSinkToken(token: string): void { sinkToken = token; }\n"
    "export function collect(id: string) { if (!sinkToken) throw new Error('no sink token'); }\n"
)
assistant(
    thinking(
        "setSinkToken is called once at startup and nothing ever refreshes it. That is "
        "consistent with the symptom exactly."
    ),
    text("`setSinkToken` is called once at startup and nothing refreshes it. That matches the symptom exactly."),
)

user("That would explain it. Can you add an age check and a refresh?")
assistant(
    thinking("I will add a tokenIssuedAt timestamp and a max age, then call a refresh when it is exceeded."),
    text("Adding a `tokenIssuedAt` timestamp and a max-age check that triggers a refresh."),
    tool_use("Edit", file_path=f"{repo}/packages/collector/src/index.ts"),
)
tool_result("The file has been updated.")

assistant(
    thinking(
        "I have stubbed refreshSinkToken to only update the timestamp. That is not a real "
        "refresh — it will make the age check pass while the token stays stale. I should "
        "flag that this is a placeholder."
    ),
    text(
        "The age check is in. `refreshSinkToken` is a placeholder for now — it bumps the "
        "timestamp but does not actually fetch a new token, so the symptom will persist "
        "until that is filled in."
    ),
)

user("Fine, leave the stub. I also want evaluate renamed to evaluateRun while we're in here.")
assistant(
    thinking(
        "Separate piece of work from the token bug, but the developer asked for it. Rename "
        "in core, then update call sites."
    ),
    text("Renaming in `core` and updating the call sites."),
    tool_use("Edit", file_path=f"{repo}/packages/core/src/index.ts"),
)
tool_result("The file has been updated.")
assistant(text("Updated `cli` and `collector`."), tool_use("Edit", file_path=f"{repo}/packages/cli/src/index.ts"))
tool_result("The file has been updated.")

assistant(thinking("Run the tests and see where we are."), tool_use("Bash", command="pnpm test"))
tool_result(
    "FAIL packages/guard/src/index.ts\n"
    "  error TS2305: Module '@checkpoint/core' has no exported member 'evaluate'.\n"
    "Tests: 2 failed, 1 passed"
)
assistant(
    thinking("guard was missed in the rename and now fails to compile, which blocks the suite."),
    text("`guard` was missed in the rename and no longer compiles, so the suite cannot run."),
)

user("Leave guard for now, I need to step away. The refresh is still the thing I care about.")

# A little trailing tool work, so the window has to make real choices rather
# than trivially containing the whole conversation.
for pattern, note in (
    ("evaluate", "remaining call sites"),
    ("sinkToken", "where the token is read"),
    ("tokenIssuedAt", "where the age is compared"),
):
    assistant(
        thinking(f"Checking {note} before I stop."),
        tool_use("Grep", pattern=pattern, path=repo),
    )
    tool_result(f"packages/guard/src/index.ts:1:import {{ {pattern} }} from '@checkpoint/core';")

with open(out_path, "w", encoding="utf8") as fh:
    for record in records:
        fh.write(json.dumps(record) + "\n")

kinds = {}
for record in records:
    content = record["message"]["content"]
    if isinstance(content, str):
        kinds["user text"] = kinds.get("user text", 0) + 1
    else:
        for block in content:
            kinds[block["type"]] = kinds.get(block["type"], 0) + 1

print(out_path)
print(f"  records={len(records)}  " + "  ".join(f"{k}={v}" for k, v in sorted(kinds.items())))
