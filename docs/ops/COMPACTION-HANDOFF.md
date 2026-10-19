# Compaction handoff

Every compaction writes a handoff first. A `PreCompact` hook forks the session and runs the `handoff`
skill in the fork; the file lands in `localNotes/handoffs/` and the post-compact hook injects it into
the compacted context. Compaction is lossy and occasionally generative (the skill's _Why this exists_);
the handoff keeps the decisions, dead ends and open questions the summary drops.

1. **Compaction starts** (manual `/compact`, idle, or context full). `PreCompact` runs
   `precompact-handoff.sh`, which runs `claude -p --resume <sid> --fork-session "/handoff session=<sid> …"`.
   The fork writes `localNotes/handoffs/handoff-<date>-<branch>-<sid8>.md`; the hook appends one line to
   `localNotes/handoffs/precompact.log`.
2. **Compaction runs**, after the hook returns.
3. **`PostCompact`** — `post-compact-summary.sh` saves the summary itself to
   `localNotes/handoffs/compact-<date>-<sid8>.md`.
4. **`SessionStart` (`compact`)** — `post-compact-context.sh` injects live git/PR/CI state and this
   session's handoff (first 150 lines).

| File                                                                  | Role                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.claude/hooks/precompact-handoff.sh`                                 | forks, logs, never blocks                                               |
| `.claude/skills/handoff/SKILL.md`                                     | what the fork writes; compaction-only (no `session=` → it refuses)      |
| `.claude/hooks/post-compact-summary.sh`                               | saves `compact_summary` — free, and the only audit trail of the summary |
| `.claude/hooks/post-compact-context.sh`                               | finds the handoff by session id, else by branch                         |
| `.claude/hooks/testdata/compaction-fixtures.jsonl` + `stub-claude.sh` | fixtures, run by `run-fixtures.py` (`.claude/hooks/README.md`)          |

## When it fires

`PreCompact` has no matcher, so it runs on `manual` and `auto`. **Idle compaction and context-full
compaction both report `auto`** — the hook can't tell them apart. Idle compaction (Claude Code ≥ 2.1.299,
server-gated) needs 200k+ tokens and fires after ~54 min idle. Measured 2026-10-18: `PreCompact` fired
with `trigger: auto`, `custom_instructions: null`; compaction followed 76 s later at 206,326 tokens.

## What you control

- **`/compact <instructions>`** — compaction follows them, and the hook writes them to
  `localNotes/handoffs/.instructions-<sid8>.txt` for the fork (deleted after). Never argv: user-typed
  text on a command line is COI's kill surface (CLAUDE.md → COI container).
- **"For the handoff: …" in the chat** — the fork is a copy of the conversation, so it sees it. Reliable
  since the last compaction; before that, only if the summary kept it. Use `/compact <instructions>` for
  anything that must land.
- **Typing `/handoff`** writes nothing — it says to use `/compact`.

## The fork

The exact command is in the hook. What each choice is for:

- **`--resume <sid> --fork-session`** — a copy; the parent is untouched. It finds the transcript from a
  worktree cwd even when the session was started at `/workspace`.
- **Cache** — no `--model` (resume restores it), `--settings`, `--append-system-prompt`, `--bare` or
  `--tools`, same cwd. A bare tool name in `--disallowedTools`, `--tools`, or `--permission-prompts`
  removes tools from the request, and the tool array is the front of the cached prefix.
- **`--permission-mode dontAsk`** — unlisted tools are denied without a prompt. A resumed `-p` session
  does **not** inherit the parent's mode; it starts from this flag, else `defaultMode` from settings —
  which is `bypassPermissions` in the container, where allow rules are ignored. Deny rules bind in every
  mode, so the scoped `--disallowedTools` list (push, commit, add, stash, checkout, switch, reset,
  rebase, `gh pr create/merge/close`, `rm`) is the second lock. The repo's guard hooks run in the fork too.
- **`Edit(localNotes/handoffs/**)`** is the only write surface. `Write(...)` rules are accepted but
  never consulted — `Edit` rules govern the Write tool.
- **`--no-session-persistence`** — no fork transcript on disk (verified with `--fork-session`). Each fork
  still leaves a ~20 KB `~/.claude/projects/<cwd>/<fork-id>/tool-results/` dir (the `load-context.sh`
  output); left alone rather than `rm -r` from a hook.
- **`--max-turns 20 --max-budget-usd 2`** — runaway stops, not targets.
- **Recursion** — the fork runs with `APERTURE_HANDOFF_FORK=1`; both compaction hooks exit on it.

**Timeout:** inner `timeout 480` (override: `APERTURE_HANDOFF_TIMEOUT`), settings `timeout: 600` as the
backstop, so the log line is always written. Compaction waits for it.

**Failure** never blocks compaction: the hook exits 0 and prints nothing whatever happens. The log line
carries `rc` (124 = timed out); a failed fork keeps `localNotes/handoffs/.fork-<sid8>-<ts>.err`; the
post-compact hook falls back to the newest handoff for the branch. Skips log `skip reason=` (`fork`,
`bad-session-id`, `no-transcript`, `no-claude`, `locked`). Detached HEAD still gets one, named `detached`.

## Log

`localNotes/handoffs/precompact.log`, one line per compaction:

```
2026-10-19T14:02:11-07:00 trigger=manual sid=4cee5162 branch=precompact-handoff rc=0 dur=41s fork=… turns=6 cache_read=… cache_new=… out=… denials=0 error=false file=handoff-…-4cee5162.md
```

`denials` > 0 means the skill asked for something the allowlist refuses — fix the skill or the list.
The json's `total_cost_usd` is **cumulative over the resumed session's whole history** (a 1-turn fork
reported $4.56), so the log carries tokens, not dollars.

## Cost and measurements

Measured, Claude Code 2.1.302–2.1.303, Opus, from a ~120–140k-token session:

| Run (date)                             | Turns | Time | Cache read | Cache write  | Notes                                                                       |
| -------------------------------------- | ----- | ---- | ---------- | ------------ | --------------------------------------------------------------------------- |
| bare fork, "ok" (2026-10-18)           | 1     | —    | 141,862    | 1,771        | before the flag set existed                                                 |
| full flag set, "ok" (2026-10-19)       | 1     | 4 s  | 107,891    | 14,176 (1 h) | no transcript left                                                          |
| permission probe (2026-10-19)          | 8     | 17 s | 737,331    | 17,242       | denied: `git stash` (deny rule), `touch` (unlisted), Write outside handoffs |
| real handoff via the hook (2026-10-19) | 9     | 40 s | 732,007    | 25,240       | 3,891 output tokens, 0 denials, `/compact` instructions honoured            |

Inferred from those tokens, not billed: a handoff is roughly **$0.20–0.50** at list price, mostly cache
reads at 0.05× plus any cache write. **Unexplained:** the ~14k-token write on 2026-10-19 against ~1.8k
the day before — the fork's prefix diverges from the parent's somewhere near the end of the transcript.
The `cache_new` field in the log will show whether it's typical. On idle compaction the cache may have
expired; the fork then pays the write compaction would have paid anyway, and compaction reads it.

## Testing

- `python3 .claude/hooks/testdata/run-fixtures.py` — the compaction suite runs the hook against a stub
  `claude` (no network, no cost).
- Live: a session must be **started from the directory whose `.claude/settings.json` has the hooks** —
  `${CLAUDE_PROJECT_DIR}` is the launch directory, so a session started at `/workspace` doesn't see a
  worktree's unmerged hooks. Run `/compact`, then check the log line (`rc=0`, `denials=0`, `file=`), the
  handoff, the `compact-*` file, and that the compacted context shows the handoff.
