#!/usr/bin/env python3
"""Print each with/without-session pair side by side.

    score.py <out-dir>

Deliberately does not compute a verdict. The five criteria are judgements —
does `summary` name the problem rather than restate the diff, is `hypothesis`
falsifiable — and a script that scored them would be measuring keyword
matching. This lays the pairs out so a person can score them, and mechanically
checks only the things that are genuinely mechanical.
"""

import json
import os
import sys

out = sys.argv[1] if len(sys.argv) > 1 else "eval/out"


def load(name):
    path = os.path.join(out, f"{name}.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf8") as fh:
        return json.load(fh)


def show(label, session):
    if session is None:
        print(f"  {label:22} (missing)")
        return
    analysis = session.get("analysis")
    transcript = session.get("transcript")
    provenance = (
        f"{transcript['turns']} turns / {transcript['thinkingTurns']} reasoning"
        if transcript
        else "no session"
    )
    print(f"  {label:22} [{provenance}]")
    if not analysis:
        print(f"    (no analysis) {str(session.get('analysisError'))[:90]}")
        return
    print(f"    summary    {analysis['summary']}")
    print(f"    hypothesis {analysis['hypothesis']}")
    print(f"    ruled_out  {analysis['ruled_out'] or '[]'}")
    for entry in analysis["working_set"]:
        print(f"    working    {entry}")
    print(f"    next_step  {analysis['next_step']}")


PAIRS = [
    ("1-bare", "no note, no stdin"),
    ("2-note", "note only"),
    ("3-piped", "piped test output + note"),
    ("4-trunc", "truncated diff + piped + note"),
]

for stem, description in PAIRS:
    print("=" * 78)
    print(f"{stem} — {description}")
    print("=" * 78)
    with_session = load(f"{stem}-session")
    without = load(f"{stem}-nosession")
    show("with session", with_session)
    print()
    show("--no-session", without)

    # The one genuinely mechanical signal: the session carries two abandoned
    # attempts (sink URL / DNS, and an HTTP timeout that was reverted) that
    # appear nowhere in the diff. Only a run that read it can cite them.
    if with_session and without:
        a = (with_session.get("analysis") or {}).get("ruled_out") or []
        b = (without.get("analysis") or {}).get("ruled_out") or []
        blob = " ".join(a).lower()
        cited = any(k in blob for k in ("dns", "timeout", "sink url", "network"))
        print()
        print(f"    ruled_out  with={len(a)}  without={len(b)}")
        print(f"    cites diff-invisible evidence: {'YES' if cited else 'no'}")
    print()
