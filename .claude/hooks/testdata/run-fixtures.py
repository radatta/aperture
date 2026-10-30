#!/usr/bin/env python3
"""Verify the guard hooks against their fixture files.

Run:  python3 .claude/hooks/testdata/run-fixtures.py

Suites:
  coi-reverse-shell-guard.sh  <- reverse-shell-fixtures.jsonl
  coi-grep-guard.sh           <- grep-guard-fixtures.jsonl  (Grep payloads: "input" instead of "cmd")
  precommit-guard.sh          <- precommit-fixtures.jsonl  (deploy-branch block, secret scan, commit-message rule)
  gh-safety-guard.sh          <- gh-safety-fixtures.jsonl  (destructive git, deploy-branch pushes, gh auth)
  mcp-dev-ledger.sh           <- mcp-ledger-fixtures.jsonl (aperture-dev delete guard + create/delete recording)
  board-heavy-guard.sh        <- board-heavy-fixtures.jsonl (session board: offer / measured-edge deny)

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

The commit and gh-safety guards run git (branch check, staged-diff scan), so their fixtures get a
throwaway repo on a feature branch as their cwd — hermetic, and independent of
whatever branch the runner happens to be invoked from. A fixture may also set
"branch" (run in a repo on that branch) and "stage" (file content staged first);
outside a repo suite, "cwd" (the payload's session cwd) and "tool" (override the
suite's tool name, e.g. Monitor, which carries a shell command like Bash);
"reason" (a substring the deny reason must contain, so a deny can't pass via the wrong arm);
"payload" (extra top-level payload keys, e.g. hook_event_name and tool_response for a PostToolUse case);
"ledger" (lines pre-written to the repo's MCP ledger; a string is written raw, e.g. a corrupt line), "expect_ledger" ("op:id" lines that must be in it
after the hook ran) and "ledger_count" (its exact line count after);
{FAKE_AWS_KEY} in "stage" expands to AWS's documented example key, assembled here
so the literal never sits in the repo for the CI secret scanner to flag.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PLACEHOLDERS = {"{FAKE_AWS_KEY}": "AKIA" + "IOSFODNN7EXAMPLE"}

# Matchers each guard must be registered under in .claude/settings.json — a fixture with "tool":"Monitor"
# proves nothing if the Monitor entry is gone, since the guards never read tool_name.
REGISTERED = {
    "mcp-dev-ledger.sh": ("mcp__aperture-dev__delete_task", "mcp__aperture-dev__update_task"),
    "coi-reverse-shell-guard.sh": ("Bash", "Monitor"),
    "coi-grep-guard.sh": ("Grep",),
    "precommit-guard.sh": ("Bash", "Monitor"),
    "gh-safety-guard.sh": ("Bash", "Monitor"),
    "board-heavy-guard.sh": ("Bash",),
}

# PostToolUse registrations, checked the same way.
REGISTERED_POST = {
    "mcp-dev-ledger.sh": (
        "mcp__aperture-dev__create_task",
        "mcp__aperture-dev__create_tasks",
        "mcp__aperture-dev__split_task",
        "mcp__aperture-dev__update_task",
        "mcp__aperture-dev__delete_task",
    ),
}

# (hook, fixtures, tool, needs_repo[, "board"]) — "board": each case gets a fresh temp board + fake cgroup
SUITES = [
    ("coi-reverse-shell-guard.sh", "reverse-shell-fixtures.jsonl", "Bash", False),
    ("coi-grep-guard.sh", "grep-guard-fixtures.jsonl", "Grep", False),
    ("precommit-guard.sh", "precommit-fixtures.jsonl", "Bash", True),
    ("gh-safety-guard.sh", "gh-safety-fixtures.jsonl", "Bash", True),
    ("mcp-dev-ledger.sh", "mcp-ledger-fixtures.jsonl", "mcp__aperture-dev__delete_task", True),
    ("board-heavy-guard.sh", "board-heavy-fixtures.jsonl", "Bash", False, "board"),
]


def decision_for(
    hook: pathlib.Path, tool: str, tool_input: dict, cwd: str | None, extra: dict | None = None,
    env: dict | None = None,
) -> tuple[str, str]:
    """Run the hook with a PreToolUse payload (plus `extra` keys, and `env` for the process); return its
    permission decision and reason."""
    payload = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input, **(extra or {})}
    if cwd:
        payload["cwd"] = cwd
    proc = subprocess.run(
        ["bash", str(hook)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0:
        return f"ERROR(rc={proc.returncode}): {proc.stderr.strip()[:120]}", ""
    out = proc.stdout.strip()
    if not out:
        return "allow", ""  # silent pass-through
    try:
        hso = json.loads(out)["hookSpecificOutput"]
        if "permissionDecision" not in hso and hso.get("additionalContext"):
            return "nudge", hso["additionalContext"]  # allowed, with advice attached (board-heavy-guard's offer)
        return hso["permissionDecision"], hso.get("permissionDecisionReason", "")
    except (ValueError, KeyError) as exc:
        return f"ERROR(unparsable): {exc}", ""


def make_repo(root: str, branch: str) -> str:
    repo = tempfile.mkdtemp(dir=root)
    subprocess.run(["git", "init", "-q", "-b", branch, repo], check=True)
    return repo


def claude_ancestor() -> str:
    """The pid the hook will resolve as its session (nearest `claude` ancestor), or "none" outside one."""
    pid = os.getpid()
    for _ in range(32):
        try:
            if pathlib.Path(f"/proc/{pid}/comm").read_text().strip() == "claude":
                return str(pid)
            pid = int(pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
        if pid <= 1:
            break
    return "none"


def own_start() -> str:
    """This process's start time (field 22 of /proc/self/stat), as sb_alive compares it."""
    return pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19]


def board_env(case: dict, root: str) -> dict:
    """A fresh board dir, fake cgroup (idle unless the case overrides files) and limits.json per case."""
    tmp = pathlib.Path(tempfile.mkdtemp(dir=root))
    cg = tmp / "cg"
    cg.mkdir()
    gib = 1073741824
    files = {
        "memory.stat": f"anon {2 * gib}\nfile 0\n",
        "memory.high": f"{18 * gib}\n",
        "pids.current": "300\n",
        "pids.max": "4096\n",
        **case.get("cgroup", {}),
    }
    for name, value in files.items():
        if value is not None:  # null = the file is absent (e.g. no memory.stat: not in the container)
            (cg / name).write_text(value, encoding="utf-8")
    limits = json.loads((HERE.parents[2] / "scripts/board/limits.json").read_text(encoding="utf-8"))
    limits.update(case.get("limits", {}))
    (tmp / "limits.json").write_text(case.get("limitsRaw", json.dumps(limits)), encoding="utf-8")
    (tmp / "board/leases/heavy").mkdir(parents=True)
    # Other sessions' live heavy slots. Their wrapper is this runner's own live process, so the board's gc
    # (sb_alive: pid + start time) keeps them — a dead wrapper's slot would be dropped before the cap counts it.
    cls = case.get("runningClass", "test")
    for i in range(case.get("running", 0)):
        slot = {"v": 1, "pid": 1, "class": cls, "label": cls, "wrapperPid": os.getpid(),
                "wrapperStart": own_start(), "startedAt": "2026-10-29T00:00:00Z"}
        (tmp / f"board/leases/heavy/1-{i}.json").write_text(json.dumps(slot, separators=(",", ":")), encoding="utf-8")
    if "nudged" in case:  # classes this session was already offered heavy.sh for
        (tmp / "board/sessions").mkdir(parents=True)
        (tmp / f"board/sessions/{claude_ancestor()}.nudged").write_text(
            "".join(c + "\n" for c in case["nudged"]), encoding="utf-8"
        )
    # Not the caller's HEAVY_* (edge.sh / matrix.sh export them): they'd bypass the cap under test.
    env = {k: v for k, v in os.environ.items() if not k.startswith("HEAVY_")}
    env.update(APERTURE_BOARD_DIR=str(tmp / "board"), APERTURE_BOARD_LOCK=str(tmp / "lock"),
               APERTURE_CGROUP_DIR=str(cg), APERTURE_LIMITS_JSON=str(tmp / "limits.json"))
    return env


def run_case(hook: pathlib.Path, tool: str, case: dict, root: str | None, board: bool = False) -> tuple[str, str]:
    tool = case.get("tool", tool)
    tool_input = case["input"] if "input" in case else {"command": case["cmd"]}
    if board:
        return decision_for(hook, tool, tool_input, None, case.get("payload"), env=board_env(case, root))
    if root is None:
        return decision_for(hook, tool, tool_input, case.get("cwd"), case.get("payload"))
    repo = make_repo(root, case.get("branch", "fixture-branch"))
    if "stage" in case:
        content = case["stage"]
        for key, value in PLACEHOLDERS.items():
            content = content.replace(key, value)
        (pathlib.Path(repo) / "staged.txt").write_text(content + "\n", encoding="utf-8")
        subprocess.run(["git", "-C", repo, "add", "staged.txt"], check=True)
    ledger = pathlib.Path(repo) / "localNotes" / "devcheck" / "mcp-ledger.dev.jsonl"
    if "ledger" in case:
        ledger.parent.mkdir(parents=True)
        # A string entry is written raw — that's how a fixture plants a corrupt line.
        ledger.write_text(
            "".join((e if isinstance(e, str) else json.dumps(e)) + "\n" for e in case["ledger"]), encoding="utf-8"
        )
    if hook.name == "mcp-dev-ledger.sh":
        # It finds its ledger from its own location, so run a copy that lives in this throwaway repo — the real
        # ledger is never touched, and the cwd in the payload can point anywhere.
        hooks = pathlib.Path(repo) / ".claude" / "hooks"
        hooks.mkdir(parents=True)
        for name in (hook.name, "_hook-common.sh"):
            shutil.copy2(hook.parent / name, hooks / name)
        hook = hooks / hook.name
    decision = decision_for(hook, tool, tool_input, repo, case.get("payload"))
    if "expect_ledger" in case or "ledger_count" in case:
        lines = ledger.read_text(encoding="utf-8").splitlines() if ledger.exists() else []
        parsed = []
        for x in lines:
            try:
                parsed.append(json.loads(x))
            except ValueError:
                pass
        have = {f"{e.get('op')}:{e.get('id')}" for e in parsed if isinstance(e, dict)}
        missing = [x for x in case.get("expect_ledger", []) if x not in have]
        if missing:
            return f"ledger-missing {','.join(missing)}", ""
        if "ledger_count" in case and len(lines) != case["ledger_count"]:
            return f"ledger-count {len(lines)}", ""
    return decision


def run_suite(hook_name: str, fixtures_name: str, tool: str, root: str | None, board: bool = False) -> tuple[int, int]:
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
        actual, reason = run_case(hook, tool, case, root, board)
        ok = actual == expected and case.get("reason", "") in reason
        if not ok:
            failures += 1
        label = (case.get("cmd") or json.dumps(case["input"])).splitlines()[0][:56]
        print(f"{'ok  ' if ok else 'FAIL'}  {expected:<5} got {actual:<7} {label}")
        if not ok:
            print(f"          reason expected: {case['why']}")
    return failures, total


def check_registration() -> tuple[int, int]:
    settings = json.loads((HERE.parent.parent / "settings.json").read_text(encoding="utf-8"))
    print("\n== settings.json registration ==")
    failures = total = 0
    for event, registered in (("PreToolUse", REGISTERED), ("PostToolUse", REGISTERED_POST)):
        found: dict[str, set[str]] = {}
        for entry in settings["hooks"].get(event, []):
            tools = set(entry.get("matcher", "").split("|"))
            for h in entry["hooks"]:
                found.setdefault(pathlib.PurePath(h["command"]).name, set()).update(tools)
        for hook_name, matchers in registered.items():
            for m in matchers:
                total += 1
                ok = m in found.get(hook_name, set())
                failures += not ok
                print(f"{'ok  ' if ok else 'FAIL'}  {hook_name} on {event} {m}")
    # A hook under an event it isn't registered for is dead config — the trace a bad settings.json merge leaves.
    homes: dict[str, set[str]] = {}
    for event, registered in (("PreToolUse", REGISTERED), ("PostToolUse", REGISTERED_POST)):
        for h in registered:
            homes.setdefault(h, set()).add(event)
    for event, entries in settings["hooks"].items():
        for entry in entries:
            for h in entry["hooks"]:
                name = pathlib.PurePath(h["command"].split()[0]).name
                if name in homes and event not in homes[name]:
                    failures += 1
                    total += 1
                    print(f"FAIL  {name} also registered under {event}")
    return failures, total


def main() -> int:
    failures, total = check_registration()
    with tempfile.TemporaryDirectory() as root:  # each repo-needing fixture gets a fresh repo under here
        for hook_name, fixtures_name, tool, needs_repo, *opts in SUITES:
            board = "board" in opts
            f, t = run_suite(hook_name, fixtures_name, tool, root if needs_repo or board else None, board)
            failures += f
            total += t
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
