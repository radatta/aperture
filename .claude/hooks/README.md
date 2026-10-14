# Hooks — read before adding one

**Any hook that touches git or repo file paths MUST resolve the session's working directory via the
shared helper — never `cd` to `CLAUDE_PROJECT_DIR`.**

## Why

`CLAUDE_PROJECT_DIR` points at the **project root (the main checkout)** and stays there for the life of
the session. In a **git worktree** session (e.g. `.claude/worktrees/<name>`), that's the *wrong tree* —
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

## Testing

`python3 .claude/hooks/testdata/run-fixtures.py` runs every guard against its fixture file
(`reverse-shell-fixtures.jsonl`, `grep-guard-fixtures.jsonl`, `precommit-fixtures.jsonl`,
`gh-safety-fixtures.jsonl`), checks each guard is registered in `settings.json` under its expected
matchers, and exits non-zero on a mismatch. Run it after
touching a guard. A guard can fail **silently** — `precommit-guard`'s secret scan never worked from the day it was
added (#4, 2026-08-09) until the fixtures caught it: a hard-wrapped regex made `grep` error out, and the
`if` read that as "no match" — so a guard change isn't done until a fixture proves both its deny and its
allow.
