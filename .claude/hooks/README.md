# Hooks — read before adding one

**Any hook that touches git or repo file paths MUST resolve the session's working directory via the
shared helper — never `cd` to `CLAUDE_PROJECT_DIR`.**

## Why

`CLAUDE_PROJECT_DIR` points at the **project root (the main checkout)** and stays there for the life of
the session. In a **git worktree** session (e.g. `.claude/worktrees/<name>`), that's the _wrong tree_ —
a hook that `cd`s to `CLAUDE_PROJECT_DIR` reads the main checkout's branch, staged diff, and files, not
the ones the session is actually editing. This shipped a real bug: `precommit-guard` scanned the wrong
staged diff for secrets; `main-branch-guard` checked the wrong branch.

The session's real directory (the worktree root) arrives on the hook's **stdin JSON as `.cwd`** — that
is the documented, correct source (Claude Code hooks docs). `_hook-common.sh`'s `hook_cd` reads it and
falls back to `CLAUDE_PROJECT_DIR` then `$(pwd)`, so it can never behave worse than the old code.

## The rule (template)

Right after the hook reads its stdin, before any git/path work:

```bash
INPUT=$(cat)
source "${BASH_SOURCE[0]%/*}/_hook-common.sh"; hook_cd "$INPUT" || exit 0
```

Then run `git`/path commands against the **current directory** (no `cd "$CLAUDE_PROJECT_DIR"`, no
`$REPO`). `${BASH_SOURCE[0]%/*}` locates the sibling helper; this relies on `settings.json` invoking
hooks by absolute path (`${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>.sh`), which it does for all of them.

A hook that does no git and touches no repo paths (e.g. a pure command-pattern matcher) doesn't need it —
but when in doubt, add it; it's fail-open and cheap.

## COI guards — Bash and Grep

`coi-reverse-shell-guard.sh` (Bash, and Monitor — its `command` is a shell line too) and
`coi-grep-guard.sh` (Grep — `rg`'s argv is a command line COI inspects too) deny text COI pauses or kills the container on. Both source `_coi-patterns.sh`, so they
can't drift, and both are narrowed to what COI really fires on: over-blocking makes Claude timid. The
rules: `docs/ops/COI-SANDBOX.md` → *Container killed*; re-derive them from
`localNotes/code-on-incus/APERTURE-ANALYSIS.md` on every COI upgrade. Implementation constraint (builtins
only, deny text over stdin): the Bash guard's header.

## MCP dev ledger

`mcp-dev-ledger.sh` (PreToolUse on `aperture-dev` `delete_task` and `update_task`, PostToolUse on its create/split/update/delete
tools) records every task id an `aperture-dev` create returns and denies a delete of any id it never recorded,
or of a recorded parent holding a part it didn't record (the server's delete cascades into parts) — the
enforcement behind CLAUDE.md's standing approval for dev cleanup. Fails closed (no ledger, no jq, no event name
→ deny; an attach it can't record is denied too); the PostToolUse half never blocks. It finds the ledger from
its own location, never the session's cwd. Format: `docs/ops/DEV-CHECK.md` → *Ledgers*.

## Bot and secrets guards

`gh-safety-guard.sh` also walls the bot CLI (`docs/ops/CI-BOT.md`): `pnpm bot push` aimed at
`main`/`master`/`dev`, any `pnpm bot` force flag, `gh pr merge|review`, and any Bash line touching `.secrets/` except a bare `ls`/`stat`.
Its push checks see through git's global options (`git -C dir push`, `git -c k=v push`) and deny
`--all`/`--mirror`. `secrets-read-guard.sh` (Read, Grep, Glob) denies those tools a path into `.secrets/`, and a
Grep whose glob could re-admit the gitignored dir (`*`, `*.pem`, `*.env`, brace globs) where a `.secrets` sits
within reach; a Grep *pattern* is content, so searching the repo for the text stays allowed. Both are second walls — the CLI
refuses on its own, and the ruleset is the real one.

## Testing

`python3 .claude/hooks/testdata/run-fixtures.py` runs every guard against its fixture file
(`reverse-shell-fixtures.jsonl`, `grep-guard-fixtures.jsonl`, `precommit-fixtures.jsonl`,
`gh-safety-fixtures.jsonl`, `mcp-ledger-fixtures.jsonl`, `board-heavy-fixtures.jsonl`,
`secrets-read-fixtures.jsonl`), the compaction hooks against `compaction-fixtures.jsonl` with `claude` stubbed by
`stub-claude.sh` (docs/ops/COMPACTION-HANDOFF.md), checks each hook is registered in `settings.json` under its
expected event and matcher, and exits non-zero on a mismatch. Run it after
touching a guard. A guard can fail **silently** — `precommit-guard`'s secret scan never worked from the day it was
added (#4, 2026-08-09) until the fixtures caught it: a hard-wrapped regex made `grep` error out, and the
`if` read that as "no match" — so a guard change isn't done until a fixture proves both its deny and its
allow.

## Board hooks

The shared-container session board (`docs/ops/SESSION-BOARD.md`) runs on four hooks. They call
`scripts/board/` **relative to their own location** (so a worktree's hooks run that worktree's board code),
exit 0 silently outside the container (no cgroup `memory.stat` — Mac, CI), and never put a command into argv.

| Hook                               | Event                       | Does                                                                                                                                                              |
| ---------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board-session.sh`                 | SessionStart (every source) | registers the session, starts the sampler if none runs, injects headroom / the real dev lock / the hub (or the hub's roadmap reminder) / this branch's file overlaps|
| `board-heartbeat.sh working\|idle` | UserPromptSubmit / Stop     | refreshes the session's state, branch and name (git + tmux, ~5 ms) in one jq write                                                                                 |
| `board-heavy-guard.sh`             | PreToolUse Bash             | heavy command (a segment that starts a runner — not `cat`/`grep`/a heredoc that only mentions one) not under `heavy.sh` → allow + a one-line offer; **deny only** with `limits.json` `enforce:true` and the predicted load past the measured hard line or the class's concurrency cap full (records a `denied` barrier event) |
| `board-session-end.sh`             | SessionEnd                  | marks the session gone, drops its heavy slots                                                                                                                     |

`board-heavy-fixtures.jsonl` covers the guard (offer / allow / deny / fail-open); a fixture may set `cgroup`
(fake cgroup files; `null` = absent), `limits` (patched `limits.json`, e.g. `enforce` or `concurrency`) or `limitsRaw` (its literal text),
`running` + `runningClass` (other sessions' live slots — default class `test`) and `nudged` (classes already offered this session) — the
runner gives each case a fresh temp board. `"nudge"` in a fixture means allowed with `additionalContext`.
