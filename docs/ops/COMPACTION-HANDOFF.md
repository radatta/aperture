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
server-gated) needs 200k+ tokens (read from the 2.1.302 binary) and fired after ~54 min idle (measured).
Measured 2026-10-18: `PreCompact` fired with `trigger: auto`, `custom_instructions: null`; compaction
followed 76 s later at 206,326 tokens.

**Context-full is unmeasured, and probably degrades** (inference): the fork resumes a transcript already
at the compaction threshold and adds the skill and tool output, so it may compact itself — writing the
handoff from a summary — or overflow (`rc` ≠ 0). A `skip reason=fork` log line just before the parent's
line is the fork compacting.

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
  worktree cwd even when the session was started at `/workspace` (measured).
- **Cache** — no `--model` (resume restores it), `--settings`, `--append-system-prompt`, `--bare` or
  `--tools`, same cwd. A bare tool name in `--disallowedTools`, `--tools`, or `--permission-prompts`
  removes tools from the request, and the tool array is the front of the cached prefix.
- **`--permission-mode dontAsk`** — unlisted tools are denied without a prompt. A resumed `-p` session
  does **not** inherit the parent's mode; it starts from this flag, else `defaultMode` from settings —
  which is `bypassPermissions` in the container, where allow rules are ignored (Claude Code permissions
  docs). Deny rules bind in every mode, so the scoped `--disallowedTools` list (push, commit, add, stash,
  checkout, switch, reset, rebase, `gh pr create/merge/close`, `rm`) is the second lock. The repo's
  guard hooks run in the fork too. The lock assumes no settings file adds allow rules of its own —
  today `~/.claude/settings.json` sets only `defaultMode`. The stakes: the user-scope `aperture` (prod)
  and `aperture-dev` MCP tools are in the fork's tool array, and only `dontAsk` with no allow rule for
  them keeps them out.
- **Allowlist** — the skill's commands plus `git diff`, `head`, `tail`, `grep`, `ls`, `date`, Read/Grep/Glob.
  `git log`/`git diff --output=<path>` writes a file, hence `Bash(git log *--output*)` and its `diff`
  twin in the deny list. Measured 2026-10-19: `--output=` denied on both, and `head x > file` denied
  (output redirection isn't covered by `Bash(head *)`).
- **`Edit(localNotes/handoffs/**)`** is the only write surface. `Write(...)` rules are accepted but
  never consulted — `Edit` rules govern the Write tool.
- **`--no-session-persistence`** — no fork transcript on disk (verified with `--fork-session`). Each fork
  still leaves a ~20 KB `~/.claude/projects/<cwd>/<fork-id>/tool-results/` dir (the `load-context.sh`
  output); left alone rather than `rm -r` from a hook.
- **`--max-turns 20 --max-budget-usd 2`** — runaway stops, not targets.
- **Recursion** — the fork runs with `APERTURE_HANDOFF_FORK=1`; `precompact-handoff.sh` and
  `post-compact-summary.sh` exit on it (`post-compact-context.sh` still runs if the fork compacts).
- **Repo root** — all three hooks `cd` to `git rev-parse --show-toplevel`, so a session that `cd`'d into
  `app/` still writes and finds handoffs at the root, and the fork starts where the session was launched.

**Timeout:** inner `timeout 480` (override: `APERTURE_HANDOFF_TIMEOUT`, kept under 585 so `timeout -k 15`
finishes inside it), settings `timeout: 600` as the backstop, so the log line is written. Compaction waits
for it. If Claude Code kills the hook anyway, the fork (its own process group under `timeout`) can
outlive it and write its handoff after compaction, with no log line.

**Failure** never blocks compaction: the hook exits 0 and prints nothing whatever happens. The log line
carries `rc` (124 = timed out) and `subtype` (`error_max_turns` / `error_max_budget_usd` name a runaway
stop); a fork that wrote to stderr keeps `localNotes/handoffs/.fork-<sid8>-<ts>.err` (pruned once more
than 7 whole days old). The post-compact hook injects a handoff only when the log's last line for the
session names it and is under 10 min old;
otherwise it surfaces the newest handoff for the branch by path. Skips log `skip reason=` (`fork`,
`bad-session-id`, `no-transcript`, `no-claude`, `locked`). Detached HEAD still gets one, named `detached`.

## Log

`localNotes/handoffs/precompact.log`, one line per compaction:

```
2026-10-19T14:02:11-07:00 trigger=manual sid=4cee5162 branch=precompact-handoff rc=0 dur=41s fork=… subtype=success turns=6 cache_read=… cache_new=… out=… denials=0 error=false file=handoff-…-4cee5162.md
```

`denials` > 0 means the skill asked for something the allowlist refuses — fix the skill or the list.
The json's `total_cost_usd` is **cumulative over the resumed session's whole history** (a 1-turn fork
reported $4.56), so the log carries tokens, not dollars. `--max-budget-usd 2` didn't stop a 9-turn fork
of that session, so it appears not to use the cumulative figure — `subtype` will show if it ever does.

## Cost and measurements

Measured, Claude Code 2.1.302–2.1.303, Opus, from a ~120–140k-token session:

| Run (date)                                  | Turns | Time | Cache read | Cache write  | Notes                                                                                       |
| ------------------------------------------- | ----- | ---- | ---------- | ------------ | ------------------------------------------------------------------------------------------- |
| bare fork, "ok" (2026-10-18)                | 1     | —    | 141,862    | 1,771        | before the flag set existed                                                                 |
| full flag set, "ok" (2026-10-19)            | 1     | 4 s  | 107,891    | 14,176 (1 h) | no transcript left                                                                          |
| permission probe (2026-10-19)               | 8     | 17 s | 737,331    | 17,242       | denied: `git stash` (deny rule), `touch` (unlisted), Write outside handoffs                 |
| `--output` / redirect probe (2026-10-19)    | 6     | 20 s | 435,639    | 23,330       | denied: `git log`/`git diff --output=`, `head … > file`; plain `git log`/`git diff` allowed |
| real handoff via the hook (2026-10-19)      | 9     | 40 s | 732,007    | 25,240       | 3,891 output tokens, 0 denials, `/compact` instructions honoured                            |
| real `/compact`, fresh session (2026-10-30) | 4     | 25 s | 207,087    | 8,033        | 1,908 output tokens, 0 denials; chat note and `/compact` instructions both landed           |

Inferred from those tokens: a handoff is roughly **$0.20–0.50** at API list price, mostly cache reads
at 0.05× plus any cache write. Not billed as such — the fork uses the session's own login (claude.ai
subscription here), so it draws subscription usage; an `ANTHROPIC_API_KEY` in the environment would
bill that key instead, since the fork inherits it. **Unexplained:** the 14–29k-token writes on
2026-10-19 (a long, many-times-compacted session) against ~1.8k on 2026-10-18 and 8k on 2026-10-30 —
the fork's prefix diverges from the parent's somewhere near the end of the transcript. The `cache_new`
field in the log will show what's typical. On idle compaction the cache may have
expired; the fork then pays the write compaction would have paid anyway, and compaction reads it.

## Testing

- `python3 .claude/hooks/testdata/run-fixtures.py` — the compaction suite runs the hook against a stub
  `claude` (no network, no cost).
- Live: a session must be **started from the directory whose `.claude/settings.json` has the hooks** —
  `${CLAUDE_PROJECT_DIR}` is the launch directory, so a session started at `/workspace` doesn't see a
  worktree's unmerged hooks. Run `/compact`, then check the log line (`rc=0`, `denials=0`, `file=`), the
  handoff, the `compact-*` file, and that the compacted context shows the handoff. Done 2026-10-30 in a
  session started in the worktree: a "for the handoff" chat word and a `/compact` instruction word both
  reached the handoff, `PostCompact` carried `compact_summary` (until then docs-only), and the compacted
  session's context opened with "Handoff written just before this compaction".
