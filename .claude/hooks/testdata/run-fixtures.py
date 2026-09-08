#!/usr/bin/env python3
"""Verify coi-reverse-shell-guard.sh against reverse-shell-fixtures.jsonl.

Run:  python3 .claude/hooks/testdata/run-fixtures.py

WHY THIS EXISTS AS A FILE-DRIVEN RUNNER, and not as an inline shell loop:
COI's monitor matches its reverse-shell patterns against every process's argv.
Putting a fixture like `nc -e ...` on a command line — even purely as test data —
is itself a CRITICAL match, and CRITICAL kills the container. That is exactly how
the third kill on 2026-09-07 happened: a test harness for this very hook.

So the fixtures live in a file, are read into this process's memory, and reach the
hook over STDIN. No flagged string ever appears in any process's argv:
  argv here          -> ["python3", "<this file>"]
  argv of the hook   -> ["bash", "<hook path>"]
Both are clean. Keep it that way — do not "simplify" this into a shell one-liner.
"""

import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
HOOK = HERE.parent / "coi-reverse-shell-guard.sh"
FIXTURES = HERE / "reverse-shell-fixtures.jsonl"


def decision_for(command: str) -> str:
    """Run the hook with a PreToolUse payload; return its permission decision."""
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
    proc = subprocess.run(
        ["bash", str(HOOK)],
        input=payload,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return f"ERROR(rc={proc.returncode}): {proc.stderr.strip()[:120]}"
    out = proc.stdout.strip()
    if not out:
        return "allow"  # silent pass-through
    try:
        return json.loads(out)["hookSpecificOutput"]["permissionDecision"]
    except (ValueError, KeyError) as exc:
        return f"ERROR(unparsable): {exc}"


def main() -> int:
    if not HOOK.exists():
        print(f"hook not found: {HOOK}", file=sys.stderr)
        return 2

    failures = 0
    total = 0
    for line in FIXTURES.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        total += 1
        case = json.loads(line)
        expected = case["expect"]
        actual = decision_for(case["cmd"])
        ok = actual == expected
        if not ok:
            failures += 1
        label = case["cmd"].splitlines()[0][:56]
        print(f"{'ok  ' if ok else 'FAIL'}  {expected:<5} got {actual:<7} {label}")
        if not ok:
            print(f"          reason expected: {case['why']}")

    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
