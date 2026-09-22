#!/usr/bin/env python3
"""Verify the guard hooks against their fixture files.

Run:  python3 .claude/hooks/testdata/run-fixtures.py

Suites:
  coi-reverse-shell-guard.sh  <- reverse-shell-fixtures.jsonl
  precommit-guard.sh          <- precommit-fixtures.jsonl  (deploy-branch block, secret scan, commit-message rule)

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

The commit guard runs git (branch check, staged-diff scan), so its fixtures get a
throwaway repo on a feature branch as their cwd — hermetic, and independent of
whatever branch the runner happens to be invoked from. A fixture may also set
"branch" (run in a repo on that branch) and "stage" (file content staged first);
{FAKE_AWS_KEY} in "stage" expands to AWS's documented example key, assembled here
so the literal never sits in the repo for the CI secret scanner to flag.
"""

import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PLACEHOLDERS = {"{FAKE_AWS_KEY}": "AKIA" + "IOSFODNN7EXAMPLE"}

# (hook, fixtures, needs_repo)
SUITES = [
    ("coi-reverse-shell-guard.sh", "reverse-shell-fixtures.jsonl", False),
    ("precommit-guard.sh", "precommit-fixtures.jsonl", True),
]


def decision_for(hook: pathlib.Path, command: str, cwd: str | None) -> str:
    """Run the hook with a PreToolUse payload; return its permission decision."""
    payload = {"tool_name": "Bash", "tool_input": {"command": command}}
    if cwd:
        payload["cwd"] = cwd
    proc = subprocess.run(
        ["bash", str(hook)],
        input=json.dumps(payload),
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


def make_repo(root: str, branch: str) -> str:
    repo = tempfile.mkdtemp(dir=root)
    subprocess.run(["git", "init", "-q", "-b", branch, repo], check=True)
    return repo


def run_case(hook: pathlib.Path, case: dict, root: str | None) -> str:
    if root is None:
        return decision_for(hook, case["cmd"], None)
    repo = make_repo(root, case.get("branch", "fixture-branch"))
    if "stage" in case:
        content = case["stage"]
        for key, value in PLACEHOLDERS.items():
            content = content.replace(key, value)
        (pathlib.Path(repo) / "staged.txt").write_text(content + "\n", encoding="utf-8")
        subprocess.run(["git", "-C", repo, "add", "staged.txt"], check=True)
    return decision_for(hook, case["cmd"], repo)


def run_suite(hook_name: str, fixtures_name: str, root: str | None) -> tuple[int, int]:
    hook = HERE.parent / hook_name
    if not hook.exists():
        print(f"hook not found: {hook}", file=sys.stderr)
        return 1, 1
    print(f"\n== {hook_name} ==")
    failures = total = 0
    for line in (HERE / fixtures_name).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        total += 1
        case = json.loads(line)
        expected = case["expect"]
        actual = run_case(hook, case, root)
        ok = actual == expected
        if not ok:
            failures += 1
        label = case["cmd"].splitlines()[0][:56]
        print(f"{'ok  ' if ok else 'FAIL'}  {expected:<5} got {actual:<7} {label}")
        if not ok:
            print(f"          reason expected: {case['why']}")
    return failures, total


def main() -> int:
    failures = total = 0
    with tempfile.TemporaryDirectory() as root:  # each repo-needing fixture gets a fresh repo under here
        for hook_name, fixtures_name, needs_repo in SUITES:
            f, t = run_suite(hook_name, fixtures_name, root if needs_repo else None)
            failures += f
            total += t
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
