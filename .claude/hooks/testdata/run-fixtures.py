#!/usr/bin/env python3
"""Verify the guard hooks against their fixture files.

Run:  python3 .claude/hooks/testdata/run-fixtures.py

Suites:
  coi-reverse-shell-guard.sh  <- reverse-shell-fixtures.jsonl
  coi-grep-guard.sh           <- grep-guard-fixtures.jsonl  (Grep payloads: "input" instead of "cmd")
  precommit-guard.sh          <- precommit-fixtures.jsonl  (deploy-branch block, secret scan, commit-message rule)
  gh-safety-guard.sh          <- gh-safety-fixtures.jsonl  (destructive git, deploy-branch pushes, bot CLI, gh auth)
  mcp-dev-ledger.sh           <- mcp-ledger-fixtures.jsonl (aperture-dev delete guard + create/delete recording)
  board-heavy-guard.sh        <- board-heavy-fixtures.jsonl (session board: offer / measured-edge deny)
  secrets-read-guard.sh       <- secrets-read-fixtures.jsonl  (Read/Grep/Glob payloads; "tool" per case)
  compaction hooks            <- compaction-fixtures.jsonl  (precompact-handoff.sh against stub-claude.sh,
                                 post-compact-summary.sh, post-compact-context.sh; each case names its "hook")
  board-hub-nudge.sh check    <- hub-nudge-fixtures.jsonl  (the hub self-check's matcher: one synthetic turn per
                                 case on stdin, its prompt and reply through the environment)
  board-heartbeat.sh idle     <- handoff-fixtures.jsonl  (the self-compact hand-off against a temp main repo and a
                                 stub self-compact.sh: which copy runs, and that it never fails or delays Stop)

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
{SECRETS_PARENT}, {DEEP_PARENT}, {DECOY_DIR}, {PLAIN_DIR} and the rest of SECRET_DIRS anywhere in "input" or "cwd"
expand to fresh temp dirs holding synthetic `.secrets` dirs (at the root and under `cdk/`; only at a worktree's depth;
only under pruned trees; none; …), {LINK_PARENT} to a symlink to a {SECRETS_PARENT}; {PAD_200K} in "input" too;
{PAD_200K} in "stage" expands to ~200 KB of filler (a diff past the 64 KiB pipe buffer);
{FAKE_AWS_KEY} in "stage" expands to AWS's documented example key, assembled here
so the literal never sits in the repo for the CI secret scanner to flag.
"ids": true gives the throwaway repo the real identifiers.json, scripts/src/identifiers{,-scan}.ts (the
personal-identifier block) and scripts/src/commit-identity.ts (the commit-identity block), and "stage_ids" stages that config; "write" puts a file in the tree unstaged
(at "write_path"); "stage_path" names the staged file (default staged.txt). {ID_NAME}, {ID_MAILBOX},
{ID_HOME}, {ID_FOLDER}, {ID_DEV_ACCOUNT}, {ID_DOMAIN} and {ID_LOGIN} in "stage", "cmd", "identity" or "env" expand from identifiers.json, so
this file carries no identifier itself (docs/ops/IDENTIFIERS.md); {ID_FOLDER} is synthetic, matching the throwaway repo's
own .local/mac-root.
Every throwaway repo is configured as the maintainer's GitHub login with its noreply address (the commit-identity
block), and the hook never inherits this process's GIT_AUTHOR_*/GIT_COMMITTER_*. A repo-suite case may set "identity"
({"name", "email"} overriding that config), "head_author" ({"name", "email"}: a first commit by that author, for
--amend), "env" (extra environment for the hook, e.g. GIT_COMMITTER_EMAIL) and "ids_patch" (merged into the copied
identifiers.json; null deletes a key, e.g. maintainer.github, to prove the hook fails open).
"""

import fcntl
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
PLACEHOLDERS = {"{FAKE_AWS_KEY}": "AKIA" + "IOSFODNN7EXAMPLE", "{PAD_200K}": "\n".join(["padding line"] * 16000)}
REPO_ROOT = HERE.parent.parent.parent
_IDS = json.loads((REPO_ROOT / "identifiers.json").read_text(encoding="utf-8"))
ID_PLACEHOLDERS = {
    "{ID_NAME}": _IDS["maintainer"]["name"].split()[0],
    "{ID_MAILBOX}": _IDS["email"]["contact"].split("@")[0],
    "{ID_FOLDER}": "Alpha" + "/" + "Beta",
    "{ID_HOME}": "/" + "Users/someone/repo",
    "{ID_DEV_ACCOUNT}": _IDS["aws"]["devAccountId"],
    "{ID_DOMAIN}": _IDS["domains"]["dev"],
    "{ID_LOGIN}": _IDS["maintainer"]["github"],
}
# The identity every throwaway repo commits as: public (identifiers.json → maintainer.github), never a real mailbox.
IDENTITY = {"name": _IDS["maintainer"]["github"], "email": _IDS["maintainer"]["github"] + "@users.noreply.github.com"}


def expand_ids(s: str) -> str:
    for key, value in ID_PLACEHOLDERS.items():
        s = s.replace(key, value)
    return s

# Matchers each guard must be registered under in .claude/settings.json — a fixture with "tool":"Monitor"
# proves nothing if the Monitor entry is gone, since the guards never read tool_name.
REGISTERED = {
    "mcp-dev-ledger.sh": ("mcp__aperture-dev__delete_task", "mcp__aperture-dev__update_task"),
    "coi-reverse-shell-guard.sh": ("Bash", "Monitor"),
    "coi-grep-guard.sh": ("Grep",),
    "precommit-guard.sh": ("Bash", "Monitor"),
    "gh-safety-guard.sh": ("Bash", "Monitor"),
    "board-heavy-guard.sh": ("Bash",),
    "secrets-read-guard.sh": ("Read", "Grep", "Glob"),
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

# Non-PreToolUse hooks: script -> its (event, matcher or None, args) triples. "" never matches a real matcher, so None
# means "no matcher". A command's first word names the script, the rest are its args (`board-heartbeat.sh idle`).
REGISTERED_EVENTS = {
    # the self-compact hand-off rides its Stop entry, and runs only on `idle` (handoff-fixtures.jsonl)
    "board-heartbeat.sh": (("UserPromptSubmit", None, "working"), ("Stop", None, "idle")),
    "precompact-handoff.sh": (("PreCompact", None, ""),),
    "post-compact-summary.sh": (("PostCompact", None, ""),),
    "post-compact-context.sh": (("SessionStart", "compact", ""),),
}

# (hook, fixtures, tool, needs_repo[, "board"]) — "board": each case gets a fresh temp board + fake cgroup
SUITES = [
    ("coi-reverse-shell-guard.sh", "reverse-shell-fixtures.jsonl", "Bash", False),
    ("coi-grep-guard.sh", "grep-guard-fixtures.jsonl", "Grep", False),
    ("precommit-guard.sh", "precommit-fixtures.jsonl", "Bash", True),
    ("gh-safety-guard.sh", "gh-safety-fixtures.jsonl", "Bash", True),
    ("mcp-dev-ledger.sh", "mcp-ledger-fixtures.jsonl", "mcp__aperture-dev__delete_task", True),
    ("board-heavy-guard.sh", "board-heavy-fixtures.jsonl", "Bash", False, "board"),
    ("secrets-read-guard.sh", "secrets-read-fixtures.jsonl", "Read", False),
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
    try:  # a hook that hangs fails its case instead of the run (Claude Code would time it out and run the tool)
        proc = subprocess.run(
            ["bash", str(hook)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return "ERROR(timeout 30 s)", ""
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


def make_repo(root: str, branch: str, identity: dict | None = None) -> str:
    repo = tempfile.mkdtemp(dir=root)
    subprocess.run(["git", "init", "-q", "-b", branch, repo], check=True)
    for key, value in {**IDENTITY, **(identity or {})}.items():
        subprocess.run(["git", "-C", repo, "config", f"user.{key}", expand_ids(value)], check=True)
    return repo


def patch(base: dict, change: dict) -> dict:
    """`change` merged into `base`, recursively; a None value deletes the key."""
    out = dict(base)
    for k, v in change.items():
        if v is None:
            out.pop(k, None)
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = patch(out[k], v)
        else:
            out[k] = v
    return out


def hook_env(extra: dict | None) -> dict:
    """This process's environment minus any identity override, plus the case's own "env"."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_AUTHOR_", "GIT_COMMITTER_"))}
    env.update({k: expand_ids(v) for k, v in (extra or {}).items()})
    return env


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
    # Dead slots: a wrapper that is gone — pid 4194303 (pid_max - 1, in practice never in use) with a start tick
    # of 1, which no live process has (sb_alive checks both). A running job to no reader.
    for i in range(case.get("runningDead", 0)):
        slot = {"v": 1, "pid": 1, "class": cls, "label": cls, "wrapperPid": 4194303,
                "wrapperStart": "1", "startedAt": "2026-10-29T00:00:00Z"}
        (tmp / f"board/leases/heavy/1-dead-{i}.json").write_text(json.dumps(slot, separators=(",", ":")), encoding="utf-8")
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


# Placeholder -> the dirs (path inside it -> synthetic file names) its throwaway dir gets.
SECRET_DIRS = {
    "{SECRETS_PARENT}": {".secrets/ci-bot": ("app.env",), ".secrets": ("devcheck.dev.state.json",),
                         "cdk/.secrets": ("device-token.dev",), "src": ("a.ts",)},
    "{DEEP_PARENT}": {".claude/worktrees/w/cdk/.secrets": ("device-token.dev",)},  # depth 5, like a worktree's
    "{DEPTH6_DIR}": {"a/b/c/d/e/.secrets": ("x.dev",)},  # the walk's deepest
    "{DEPTH7_DIR}": {"a/b/c/d/e/f/.secrets": ("x.dev",)},  # one past it: the known limit
    "{PKG_PARENT}": {"pkg/.secrets": ("x.dev",)},  # under a subdir name no checkout has (relative-path cases)
    "{CASED_DIR}": {"x/y/.SECRETS": ("x.dev",)},  # upper case on a case-sensitive disk: -iname must find it
    # only under trees the deep walk prunes, each past the shallow walk's depth 2
    "{DECOY_DIR}": {"node_modules/x/.secrets": ("a.env",), ".git/x/.secrets": ("a.env",),
                    "dist/x/.secrets": ("a.env",), "cdk.out/x/.secrets": ("a.env",)},
    "{FILE_DIR}": {"": (".secrets",)},  # a FILE named .secrets at depth 1, no dir: the walks look for dirs
    "{PLAIN_DIR}": {},
}


def run_case(hook: pathlib.Path, tool: str, case: dict, root: str | None, scratch: str, board: bool = False) -> tuple[str, str]:
    tool = case.get("tool", tool)
    tool_input = case["input"] if "input" in case else {"command": expand_ids(case["cmd"])}
    raw = json.dumps(tool_input)
    cwd = case.get("cwd")
    if any(p in raw + (cwd or "") for p in [*SECRET_DIRS, "{LINK_PARENT}"]):
        # Throwaway dirs (a space in the name on purpose) for guards that look for a `.secrets` dir on disk, each
        # holding synthetic one-line files only; {LINK_PARENT} is a symlink to {SECRETS_PARENT}. Under `scratch`,
        # so they go when the run ends.
        dirs = {p: tempfile.mkdtemp(prefix=f"{p.strip('{}').split('_')[0].lower()} with space ", dir=scratch) for p in SECRET_DIRS}
        for p, secret_dirs in SECRET_DIRS.items():
            for rel, files in secret_dirs.items():
                d = pathlib.Path(dirs[p]) / rel
                d.mkdir(parents=True, exist_ok=True)
                for name in files:
                    (d / name).write_text("synthetic\n", encoding="utf-8")
        dirs["{LINK_PARENT}"] = tempfile.mktemp(prefix="link with space ", dir=scratch)
        os.symlink(dirs["{SECRETS_PARENT}"], dirs["{LINK_PARENT}"])
        for p, d in dirs.items():
            raw = raw.replace(p, d)
            cwd = cwd.replace(p, d) if cwd else cwd
        tool_input = json.loads(raw)
    if "{PAD_200K}" in raw:  # a field past the 64 KiB pipe buffer (the SIGPIPE fail-open)
        tool_input = json.loads(raw.replace("{PAD_200K}", json.dumps(PLACEHOLDERS["{PAD_200K}"])[1:-1]))
    if board:
        return decision_for(hook, tool, tool_input, None, case.get("payload"), env=board_env(case, root))
    if root is None:
        if hook.name == "secrets-read-guard.sh":
            # A hostile launch environment: no UTF-8 locale (the hook must set its own for the case-fold cases) and
            # extglob forced on (the hook must switch it off for the extglob case).
            env = {k: v for k, v in os.environ.items() if not k.startswith("LC_") and k != "LANG"}
            env.update(LANG="C", BASHOPTS="extglob")
            return decision_for(hook, tool, tool_input, cwd, case.get("payload"), env=env)
        return decision_for(hook, tool, tool_input, cwd, case.get("payload"))
    repo = make_repo(root, case.get("branch", "fixture-branch"), case.get("identity"))
    if "head_author" in case:
        who = case["head_author"]
        author = {"GIT_AUTHOR_NAME": expand_ids(who["name"]), "GIT_AUTHOR_EMAIL": expand_ids(who["email"])}
        subprocess.run(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "base"], check=True, env=hook_env(author))
    if case.get("ids"):
        shutil.copy2(REPO_ROOT / "identifiers.json", pathlib.Path(repo) / "identifiers.json")
        if "ids_patch" in case:
            patched = pathlib.Path(repo) / "identifiers.json"
            patched.write_text(json.dumps(patch(json.loads(patched.read_text(encoding="utf-8")), case["ids_patch"])), encoding="utf-8")
        src = pathlib.Path(repo) / "scripts" / "src"
        src.mkdir(parents=True)
        for name in ("identifiers.ts", "identifiers-scan.ts", "mac-root.ts", "commit-identity.ts"):
            shutil.copy2(REPO_ROOT / "scripts" / "src" / name, src / name)
        # A synthetic Mac root, so the projects-folder rule exists here ({ID_FOLDER}); excluded, not committed.
        local = pathlib.Path(repo) / ".local"
        local.mkdir()
        (local / "mac-root").write_text("/" + "Users/someone/Alpha/Beta/repo\n", encoding="utf-8")
        with open(pathlib.Path(repo) / ".git" / "info" / "exclude", "a", encoding="utf-8") as f:
            f.write(".local/\n")
        if case.get("stage_ids"):
            subprocess.run(["git", "-C", repo, "add", "identifiers.json"], check=True)
    if "stage" in case:
        content = expand_ids(case["stage"])
        for key, value in PLACEHOLDERS.items():
            content = content.replace(key, value)
        staged = pathlib.Path(repo) / case.get("stage_path", "staged.txt")
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_text(content + "\n", encoding="utf-8")
        subprocess.run(["git", "-C", repo, "add", str(staged.relative_to(repo))], check=True)
    if "write" in case:
        # Written, not staged: what a `git add … && git commit` in the same command will stage.
        (pathlib.Path(repo) / case.get("write_path", "unstaged.txt")).write_text(
            expand_ids(case["write"]) + "\n", encoding="utf-8"
        )
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
    decision = decision_for(hook, tool, tool_input, repo, case.get("payload"), env=hook_env(case.get("env")))
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


def run_suite(hook_name: str, fixtures_name: str, tool: str, root: str | None, scratch: str, board: bool = False) -> tuple[int, int]:
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
        actual, reason = run_case(hook, tool, case, root, scratch, board)
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
    for h, pairs in REGISTERED_EVENTS.items():
        homes.setdefault(h, set()).update(event for event, _, _ in pairs)
    for event, entries in settings["hooks"].items():
        for entry in entries:
            for h in entry["hooks"]:
                name = pathlib.PurePath(h["command"].split()[0]).name
                if name in homes and event not in homes[name]:
                    failures += 1
                    total += 1
                    print(f"FAIL  {name} also registered under {event}")
    # settings.json runs each hook by path, so a lost exec bit fails every run silently — and the suites
    # below run hooks via `bash <hook>`, so they'd never notice.
    for hook_name in dict.fromkeys([*REGISTERED, *REGISTERED_POST, *REGISTERED_EVENTS]):
        total += 1
        ok = os.access(HERE.parent / hook_name, os.X_OK)
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'}  {hook_name} is executable")
    # Per script and event: exactly the expected (matcher, args) registrations, so a second, wrong one (`working` on
    # Stop beside `idle`) fails too.
    for hook_name, pairs in REGISTERED_EVENTS.items():
        for event in dict.fromkeys(e for e, _, _ in pairs):
            total += 1
            want = {(m, a) for e, m, a in pairs if e == event}
            got = {
                (entry.get("matcher"), " ".join(h["command"].split()[1:]))
                for entry in settings["hooks"].get(event, [])
                for h in entry["hooks"]
                if pathlib.PurePath(h["command"].split()[0]).name == hook_name
            }
            ok = got == want
            failures += not ok
            print(f"{'ok  ' if ok else 'FAIL'}  {hook_name} on {event}: {sorted(map(str, got)) if not ok else 'as expected'}")
    return failures, total


# --- Compaction hooks (compaction-fixtures.jsonl) ---
# Each case runs one hook in a fresh repo with a PreCompact/PostCompact/SessionStart payload, `claude` on
# PATH replaced by stub-claude.sh, and asserts on exit code, stdout, the hook's log, the stub's recorded argv
# and the files left in localNotes/handoffs/. The stub never reaches the network.
SID = "4cee5162-0000-4000-8000-000000000000"
# Must print nothing (compaction reads their stdout) unless a case sets "stdout_exact": a lane's block, which a case
# with "worktree" (and "lane_file") sets up (lane_repo); {LANEFILE} in it expands to that lane file's path. A case
# with "each_phase" runs once per lane phase in scripts/src/board/tower/lanes.ts (PHASES), {PHASE} expanding to it, so
# the hook's phase list can't drift from the tower's.

SILENT = {"precompact-handoff.sh", "post-compact-summary.sh"}


def disallowed_unscoped(argv: list[str]) -> list[str]:
    """--disallowedTools entries without a (scope): a bare tool name removes the tool and misses the prompt cache."""
    if "--disallowedTools" not in argv:
        return []
    rest = argv[argv.index("--disallowedTools") + 1 :]
    rules = rest[: next((i for i, a in enumerate(rest) if a.startswith("--")), len(rest))]
    return [r for r in rules if "(" not in r]


def lane_repo(root: str, case: dict) -> tuple[str, str]:
    """A lane's layout: a repo at <tmp>/m/.claude/worktrees/<worktree> on "branch" (default: the worktree's name),
    and "lane_file" (an object, or raw text) at <tmp>/m/localNotes/board/lanes/<branch>.json. Returns the repo and
    that lane file's path, which the hook prints."""
    base = pathlib.Path(os.path.realpath(tempfile.mkdtemp(dir=root))) / "m"
    repo = base / ".claude" / "worktrees" / case["worktree"]
    repo.mkdir(parents=True)
    branch = case.get("branch") or case["worktree"]
    subprocess.run(["git", "init", "-q", "-b", branch, str(repo)], check=True)
    for key, value in IDENTITY.items():
        subprocess.run(["git", "-C", str(repo), "config", f"user.{key}", value], check=True)
    lane_file = base / "localNotes" / "board" / "lanes" / f"{branch}.json"
    if "lane_file" in case:
        lane_file.parent.mkdir(parents=True)
        lf = case["lane_file"]
        lane_file.write_text(lf if isinstance(lf, str) else json.dumps(lf), encoding="utf-8")
    return str(repo), str(lane_file)


def compaction_case(hook: pathlib.Path, case: dict, root: str) -> list[str]:
    if "worktree" in case:
        repo, lane_file = lane_repo(root, case)
    else:
        repo, lane_file = make_repo(root, case.get("branch") or "fixture-branch"), ""
    git = ["git", "-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.com"]
    if case.get("branch") == "":
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "init"], check=True)
        subprocess.run([*git, "checkout", "-q", "--detach"], check=True)
    handoffs = pathlib.Path(repo) / "localNotes" / "handoffs"
    handoffs.mkdir(parents=True)
    stamps = {  # log lines carry `date -Is` stamps; freshness is judged from them
        "{NOW}": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "{OLD}": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(time.time() - 7200)),
    }
    for f in case.get("setup", []):
        path = handoffs / f["name"]
        content = f["content"]
        for key, value in stamps.items():
            content = content.replace(key, value)
        path.write_text(content + "\n", encoding="utf-8")
        if "age_min" in f:
            old = time.time() - 60 * f["age_min"]
            os.utime(path, (old, old))

    stub_dir = tempfile.mkdtemp(dir=root)
    if not case.get("no_claude"):
        shutil.copy(HERE / "stub-claude.sh", pathlib.Path(stub_dir) / "claude")
        os.chmod(pathlib.Path(stub_dir) / "claude", 0o755)
    gh = pathlib.Path(stub_dir) / "gh"  # post-compact-context.sh calls gh; never let a fixture reach GitHub
    gh.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    os.chmod(gh, 0o755)
    argv_file = pathlib.Path(stub_dir) / "argv.txt"
    transcript = pathlib.Path(stub_dir) / "transcript.jsonl"
    if case.get("transcript", True):
        transcript.write_text("{}\n", encoding="utf-8")

    cwd = os.path.join(repo, case["subdir"]) if "subdir" in case else repo
    os.makedirs(cwd, exist_ok=True)
    payload = {"session_id": case.get("session_id", SID), "transcript_path": str(transcript), "cwd": cwd}
    if "trigger" in case:
        payload["trigger"] = case["trigger"]
    if "custom" in case:
        payload["custom_instructions"] = case["custom"]
    if "summary" in case:
        payload["compact_summary"] = case["summary"]
    env = {k: v for k, v in os.environ.items() if k not in ("APERTURE_HANDOFF_FORK", "GH_REPO", "GH_TOKEN")}
    path = env["PATH"]
    if case.get("no_claude"):  # drop every PATH dir holding a real claude; HOME hides ~/.local/bin/claude
        path = ":".join(d for d in path.split(":") if not os.access(os.path.join(d, "claude"), os.X_OK))
        env["HOME"] = stub_dir
    env.update(PATH=f"{stub_dir}:{path}", APERTURE_HANDOFF_TIMEOUT="2", STUB_ARGV_FILE=str(argv_file))
    env.update(case.get("stub", {}), **case.get("env", {}))
    held = None
    if case.get("hold_lock"):  # flock(2), the same lock flock(1) takes in the hook
        held = open(handoffs / f".lock-{SID[:8]}", "w")
        fcntl.flock(held, fcntl.LOCK_EX)
    try:
        proc = subprocess.run(["bash", str(hook)], input=json.dumps(payload), capture_output=True, text=True, env=env)
    finally:
        if held:
            held.close()

    problems = []
    if proc.returncode != 0:
        problems.append(f"exit {proc.returncode}: {proc.stderr.strip()[:120]}")
    if "stdout_exact" in case:  # a lane's block: exactly these lines, nothing else
        want = "".join(line.replace("{LANEFILE}", lane_file) + "\n" for line in case["stdout_exact"])
        if proc.stdout != want:
            problems.append(f"stdout {proc.stdout[:200]!r}, want {want[:200]!r}")
    elif (case.get("stdout_empty") or case["hook"] in SILENT) and proc.stdout.strip():
        problems.append(f"stdout not empty: {proc.stdout.strip()[:80]}")
    if case.get("stderr_empty") and proc.stderr.strip():
        problems.append(f"stderr not empty: {proc.stderr.strip()[:80]}")
    problems += [f"stdout lacks {x!r}" for x in case.get("stdout", []) if x not in proc.stdout]
    problems += [f"stdout has {x!r}" for x in case.get("stdout_absent", []) if x in proc.stdout]
    if "called" in case and argv_file.exists() != case["called"]:
        problems.append(f"stub called={argv_file.exists()}, expected {case['called']}")
    argv = argv_file.read_text(encoding="utf-8") if argv_file.exists() else ""
    problems += [f"argv lacks {x!r}" for x in case.get("argv", []) if x not in argv]
    argv_lines = [line for line in argv.splitlines() if not line.startswith("instructions: ")]
    argv_only = "\n".join(argv_lines)
    problems += [f"unscoped deny rule {r!r}" for r in disallowed_unscoped(argv_lines)]
    problems += [f"argv has {x!r}" for x in case.get("argv_absent", []) if x in argv_only]
    log_path = handoffs / "precompact.log"
    log = log_path.read_text(encoding="utf-8") if log_path.exists() else ""
    problems += [f"log lacks {x!r} (log: {log.strip()[-120:]!r})" for x in case.get("log", []) if x not in log]
    problems += [f"log has {x!r}" for x in case.get("log_absent", []) if x in log]
    problems += [f"no file {g}" for g in case.get("exists", []) if not list(handoffs.glob(g))]
    problems += [f"left behind {g}" for g in case.get("absent", []) if list(handoffs.glob(g))]
    for g, needles in case.get("contains", {}).items():
        text = "".join(f.read_text(encoding="utf-8") for f in handoffs.glob(g))
        problems += [f"{g} lacks {x!r}" for x in needles if x not in text]
    return problems


def lane_phases() -> list[str]:
    src = (REPO_ROOT / "scripts" / "src" / "board" / "tower" / "lanes.ts").read_text(encoding="utf-8")
    body = src.split("export const PHASES = [", 1)[1].split("]", 1)[0]
    return [w.strip().strip("'\"") for w in body.split(",") if w.strip()]


def run_compaction_suite(root: str) -> tuple[int, int]:
    print("\n== compaction hooks ==")
    failures = total = 0
    cases = []
    for line in (HERE / "compaction-fixtures.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        case = json.loads(line)
        if case.get("each_phase"):
            for ph in lane_phases():
                cases.append(json.loads(line.replace("{PHASE}", ph)))
        else:
            cases.append(case)
    if len(lane_phases()) != 11:  # the hook's case list names 11; a new phase needs it added there too
        failures += 1
        print(f"FAIL  lanes.ts PHASES has {len(lane_phases())} phases, the lane block's list 11")
    for case in cases:
        total += 1
        problems = compaction_case(HERE.parent / case["hook"], case, root)
        failures += bool(problems)
        print(f"{'FAIL' if problems else 'ok  '}  {case['hook']:<24} {case['why'][:64]}")
        for problem in problems:
            print(f"          {problem}")
    return failures, total


# --- Hub self-check (hub-nudge-fixtures.jsonl) ---
# board-hub-nudge.sh check: a case's turn (its "tools" as assistant tool_use lines, or "lines", or "raw" text) on
# stdin, TURN_PROMPT / TURN_REPLY in the environment, and the ids it prints compared with "expect" in order. A case
# with "log" runs with HUB_NUDGE_LOG=1 on a temp board: its history lines' {check, match}, in order, and the prompt's
# own text nowhere in them.


def hub_nudge_turn(case: dict) -> str:
    if "raw" in case:
        return case["raw"]
    lines = case.get("lines")
    if lines is None:
        lines = [
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": t["name"], "input": t["input"]}]}}
            for t in case.get("tools", [])
        ]
    return "".join(json.dumps(line) + "\n" for line in lines)


def run_hub_nudge_suite() -> tuple[int, int]:
    print("\n== board-hub-nudge.sh ==")
    failures = total = 0
    for line in (HERE / "hub-nudge-fixtures.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        total += 1
        case = json.loads(line)
        env = {**os.environ, "TURN_PROMPT": case.get("prompt", ""), "TURN_REPLY": case.get("reply", "")}
        board = tempfile.mkdtemp(prefix="hub-nudge-")
        if "log" in case:
            env.update(HUB_NUDGE_LOG="1", HUB_NUDGE_SESSION="dispatch", APERTURE_BOARD_DIR=board)
        r = subprocess.run(
            ["bash", str(HERE.parent / "board-hub-nudge.sh"), "check"],
            input=hub_nudge_turn(case), capture_output=True, text=True, env=env, timeout=20,
        )
        got = [x for x in r.stdout.splitlines() if x]
        problems = [f"rc={r.returncode} {r.stderr.strip()[:120]}"] if r.returncode or r.stderr else []
        problems += [] if got == case["expect"] else [f"want {case['expect']}, got {got}"]
        if "log" in case:
            text = "".join(f.read_text(encoding="utf-8") for f in pathlib.Path(board, "history").glob("nudges-*.jsonl"))
            rows = [json.loads(x) for x in text.splitlines() if x]
            logged = [{"check": x["check"], "match": x["match"]} for x in rows]
            problems += [] if logged == case["log"] else [f"log {logged}, want {case['log']}"]
            problems += [f"row lacks t/session: {x}" for x in rows if not x.get("t") or x.get("session") != "dispatch"]
            problems += ["the prompt's text was logged"] if "private words" in text else []
        shutil.rmtree(board, ignore_errors=True)
        failures += bool(problems)
        print(f"{'FAIL' if problems else 'ok  '}  {case['why'][:88]}")
        for problem in problems:
            print(f"          {problem}")
    return failures, total


# --- Self-compact hand-off (handoff-fixtures.jsonl) ---
# board-heartbeat.sh against a temp "main" repo: this checkout's heartbeat and scripts/board/ committed, with a stub
# self-compact.sh that records "<who> <argv>" to $STUB_MARK, then hangs or fails per $STUB_MODE. A fake cgroup and a
# temp board (board_env). The hook's parent is a process named `claude` (a bash copy) whose pid names the flag. Keys:
# "state" (idle | working), "flag" (write <board>/self-compact/<pid>.req), "mode" (STUB_MODE: hang | fail),
# "stop_hook_active" (in the payload), "payload_raw" (the payload's text instead), "inherit_git" (GIT_DIR or
# GIT_COMMON_DIR set in the hook's env to an unrelated repo), "main" (dirty: lib.sh edited; untracked / untracked-lib: the script / lib.sh
# never committed; deleted: removed from the tree; hidden: removed under
# skip-worktree; hidden-edit / hidden-lib: the script / lib.sh edited under skip-worktree, where `git diff` reads
# clean; filtered: lib.sh edited behind a clean filter that strips the edit; replaced: lib.sh edited and HEAD replaced
# (refs/replace/) by a commit holding the edit; other-dirty: board.sh edited, which the script never runs), "from_worktree" (run the hook from a lane
# worktree whose own stub differs), "ran" (main's stub ran, as `stop <pid>`, stdin /dev/null, no git config env), "max_sec" (the hook's wall
# time).
STUB_SELF_COMPACT = (
    "#!/bin/bash\nprintf '%s %s stdin=%s gitcfg=%s\\n' {who} \"$*\" \"$(readlink /proc/self/fd/0)\" \"${{GIT_CONFIG_GLOBAL-unset}}${{GIT_CONFIG_NOSYSTEM-unset}}\" >>\"$STUB_MARK\"\n"
    'case "${{STUB_MODE:-}}" in hang) exec /bin/sleep 30 ;; fail) exit 1 ;; esac\n'
)


def handoff_case(case: dict, root: str) -> list[str]:
    tmp = pathlib.Path(os.path.realpath(tempfile.mkdtemp(dir=root)))
    main = tmp / "main"
    shutil.copytree(REPO_ROOT / "scripts" / "board", main / "scripts" / "board")
    (main / ".claude" / "hooks").mkdir(parents=True)
    shutil.copy(HERE.parent / "board-heartbeat.sh", main / ".claude" / "hooks" / "board-heartbeat.sh")
    script = main / "scripts" / "board" / "self-compact.sh"
    script.write_text(STUB_SELF_COMPACT.format(who="main"), encoding="utf-8")
    os.chmod(script, 0o755)
    (main / ".gitignore").write_text(".claude/worktrees/\n", encoding="utf-8")
    git = ["git", "-C", str(main), "-c", "user.name=fixture", "-c", "user.email=fixture@example.com"]
    subprocess.run(["git", "init", "-q", "-b", "main", str(main)], check=True)
    held = {"untracked": script, "untracked-lib": main / "scripts" / "board" / "lib.sh"}.get(case.get("main", ""))
    if held:
        held.rename(tmp / "held")
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-q", "-m", "init"], check=True)
    if held:
        (tmp / "held").rename(held)
    elif case.get("main") == "dirty":
        with open(main / "scripts" / "board" / "lib.sh", "a", encoding="utf-8") as f:
            f.write("# edited\n")
    elif case.get("main") == "deleted":
        script.unlink()
    elif case.get("main") == "hidden":
        subprocess.run([*git, "update-index", "--skip-worktree", "scripts/board/self-compact.sh"], check=True)
        script.unlink()
    elif case.get("main") == "hidden-edit":
        subprocess.run([*git, "update-index", "--skip-worktree", "scripts/board/self-compact.sh"], check=True)
        script.write_text(STUB_SELF_COMPACT.format(who="edited"), encoding="utf-8")
    elif case.get("main") == "hidden-lib":
        subprocess.run([*git, "update-index", "--skip-worktree", "scripts/board/lib.sh"], check=True)
        with open(main / "scripts" / "board" / "lib.sh", "a", encoding="utf-8") as f:
            f.write("# edited\n")
    elif case.get("main") == "filtered":  # main's own clean filter maps the edit away, so git diff reads clean
        subprocess.run([*git, "config", "filter.fx.clean", "sed /edited/d"], check=True)
        (main / ".git" / "info").mkdir(exist_ok=True)
        (main / ".git" / "info" / "attributes").write_text("scripts/board/lib.sh filter=fx\n", encoding="utf-8")
        with open(main / "scripts" / "board" / "lib.sh", "a", encoding="utf-8") as f:
            f.write("# edited\n")
    elif case.get("main") == "replaced":
        first = subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
        with open(main / "scripts" / "board" / "lib.sh", "a", encoding="utf-8") as f:
            f.write("# edited\n")
        subprocess.run([*git, "add", "scripts/board/lib.sh"], check=True)
        tree = subprocess.run([*git, "write-tree"], check=True, capture_output=True, text=True).stdout.strip()
        second = subprocess.run(
            [*git, "commit-tree", tree, "-p", first, "-m", "edited"], check=True, capture_output=True, text=True
        ).stdout.strip()  # plumbing: no commit hooks
        subprocess.run([*git, "replace", first, second], check=True)
    elif case.get("main") == "other-dirty":
        with open(main / "scripts" / "board" / "board.sh", "a", encoding="utf-8") as f:
            f.write("# edited\n")
    hooks = main / ".claude" / "hooks"
    cwd = main
    if case.get("from_worktree"):
        cwd = main / ".claude" / "worktrees" / "lane-x"
        subprocess.run([*git, "worktree", "add", "-q", "-b", "lane-x", str(cwd)], check=True)
        (cwd / "scripts" / "board" / "self-compact.sh").write_text(STUB_SELF_COMPACT.format(who="worktree"), encoding="utf-8")
        hooks = cwd / ".claude" / "hooks"

    env = board_env(case, str(tmp))
    local_git = subprocess.run(["git", "rev-parse", "--local-env-vars"], capture_output=True, text=True).stdout.split()
    for k in ("TMUX_PANE", "APERTURE_HANDOFF_FORK", "STUB_MODE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", *local_git):
        env.pop(k, None)
    if case.get("inherit_git"):  # an inherited repo variable pointing elsewhere: main must still be this script's
        other = tmp / "other"
        subprocess.run(["git", "init", "-q", str(other)], check=True)
        env[case["inherit_git"]] = str(other / ".git")
    mark = tmp / "mark"
    env.update(STUB_MARK=str(mark), **({"STUB_MODE": case["mode"]} if "mode" in case else {}))
    claude = tmp / "bin" / "claude"
    claude.parent.mkdir()
    shutil.copy("/bin/bash", claude)
    os.chmod(claude, 0o755)
    go, payload = tmp / "go", tmp / "payload.json"
    body = {"session_id": SID, "cwd": str(cwd), "hook_event_name": "Stop", "stop_hook_active": case.get("stop_hook_active", False)}
    payload.write_text(case.get("payload_raw") or json.dumps(body), encoding="utf-8")
    # `; exit $?` keeps bash from exec'ing the hook in place of the `claude` process (its pid names the flag).
    wrapper = 'while [ ! -e "$1" ]; do /bin/sleep 0.02; done; bash "$0" "$2" <"$3"; exit $?'
    proc = subprocess.Popen(
        [str(claude), "-c", wrapper, str(hooks / "board-heartbeat.sh"), str(go), case.get("state", "idle"), str(payload)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if case.get("flag"):
        flags = pathlib.Path(env["APERTURE_BOARD_DIR"]) / "self-compact"
        flags.mkdir(parents=True)
        (flags / f"{proc.pid}.req").write_text("1 1 1 2026-11-19T10:00:00Z\n", encoding="utf-8")
    start = time.time()
    go.touch()
    try:
        out, err = proc.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        return ["the hook did not return in 20 s"]
    took = time.time() - start
    problems = []
    if proc.returncode != 0:
        problems.append(f"exit {proc.returncode}")
    if out or err:
        problems.append(f"output {(out + err)[:120]!r}")
    if took > case.get("max_sec", 5):
        problems.append(f"took {took:.1f} s, max {case.get('max_sec', 5)}")
    end = time.time() + (3 if case["ran"] else 1.5)  # a detached run that wrongly happens shows up within this
    while time.time() < end and not (case["ran"] and mark.exists()):
        time.sleep(0.05)
    got = mark.read_text(encoding="utf-8") if mark.exists() else ""
    want = f"main stop {proc.pid} stdin=/dev/null gitcfg=unsetunset\n" if case["ran"] else ""
    if got != want:
        problems.append(f"stub ran {got!r}, want {want!r}")
    return problems


def run_handoff_suite(root: str) -> tuple[int, int]:
    print("\n== board-heartbeat.sh hand-off ==")
    failures = total = 0
    for line in (HERE / "handoff-fixtures.jsonl").read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        total += 1
        case = json.loads(line)
        problems = handoff_case(case, root)
        failures += bool(problems)
        print(f"{'FAIL' if problems else 'ok  '}  {case['why'][:88]}")
        for problem in problems:
            print(f"          {problem}")
    return failures, total


def main() -> int:
    failures, total = check_registration()
    with tempfile.TemporaryDirectory() as root:  # each repo-needing fixture gets a fresh repo under here
        for hook_name, fixtures_name, tool, needs_repo, *opts in SUITES:
            board = "board" in opts
            f, t = run_suite(hook_name, fixtures_name, tool, root if needs_repo or board else None, root, board)
            failures += f
            total += t
        f, t = run_compaction_suite(root)
        failures += f
        total += t
        f, t = run_handoff_suite(root)
        failures += f
        total += t
    f, t = run_hub_nudge_suite()
    failures += f
    total += t
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
