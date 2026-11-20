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
| `.claude/hooks/precompact-handoff.sh`                                 | a lane's block (_Lane block_), then forks, logs, never blocks           |
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
line is the fork compacting. Unmeasured as of 2026-11-04: 9 logged runs, no `skip reason=fork`, no `rc=124`;
every `auto` line so far was idle compaction (places-shortcuts: last activity 02:56, hook 03:50 — the
measured ~54 min).

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
  `~/.claude/settings.json` holds some 20 keys (2026-11-04) but no `permissions.allow`; a COI restart
  rebuilds it from the Mac copy, so re-check when it changes. The stakes: the user-scope `aperture` (prod)
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

**Failure** never blocks compaction: the hook exits 0 and prints nothing but a lane's block (_Lane block_) whatever happens. The log line
carries `rc` (124 = timed out) and `subtype` (`error_max_turns` / `error_max_budget_usd` name a runaway
stop); `localNotes/handoffs/.fork-<sid8>-<ts>.err` is kept when the fork wrote to stderr, or printed a
result and either exited non-zero or marked it `is_error` — stderr first, then the result JSON; a silent
timeout leaves nothing (pruned once more than 7 whole days old). The post-compact hook injects a handoff only when the log's last line for the
session names it and is under 10 min old;
otherwise it surfaces the newest handoff for the branch by path. Skips log `skip reason=` (`fork`,
`bad-session-id`, `no-transcript`, `no-claude`, `locked`). Detached HEAD still gets one, named `detached`.

## Lane block

In a lane, `precompact-handoff.sh` prints five lines before it forks. A `PreCompact` hook's stdout on exit 0 becomes
instructions for the summary, for `manual` and `auto` alike (Claude Code hooks docs; cut at 10,000 characters per hook
since 2.1.314), so the compacted lane keeps where it stands:

```
This session is the feature lane on branch <branch>.
Lane phase: <phase>.
Lane status file: <path>
Keep in the summary: the step in progress, open review findings, unanswered asks quoted word for word, any [hold] in force, each relayed approval with its exact scope, any pending claude-edit patch, and the next step.
After compaction, re-read docs/ops/FEATURE-WORKFLOW.md before acting.
```

A lane is a toplevel at `<main>/.claude/worktrees/<name>`, `<name>` and its branch each `^[a-z0-9][a-z0-9-]{0,62}$`
and neither named as the hub (`scripts/board/hub.json`), with a lane file at `<main>/localNotes/board/lanes/<branch>.json`
(the default board's; so not an agent's or a scratch worktree); anywhere else, in the fork included, the hook prints
nothing, and a fork it skips later (a held lock, no `claude`) still leaves the block printed. Only three values come
from outside, each checked: the branch, the phase (one of the board's phase words, else `unknown`) and the lane file's
path (`[A-Za-z0-9_./-]` only). No free text from the lane file reaches the summary. The block is inline in the hook,
not a `scripts/board/` helper: a helper would run the branch's own copy, and its text feeds the summary.

## Self-compact (lanes, off)

A lane can compact itself at a point where it waits anyway, so the next stretch starts from a short context: cost per
turn rises with context (the 2026-11-19 work-units analysis). The lane's last tool call is
`bash scripts/board/self-compact.sh request`; the Stop hook then types `/compact` into the lane's own empty input box.
It is the second constant exception to the pane rule (`docs/ops/HUB.md` → _Approval_), never a go.

**Off unless** main's committed `scripts/board/limits.json` says `lanes.selfCompact: true` (read with `git cat-file blob HEAD:`,
never the working copy or a branch's), and `<board>/self-compact/off` is absent: any session can create that file to stop
it at once. It ships `false`.

- **`request`** refuses, with one line and exit 1, unless: not the handoff fork; the switch is on; a `claude` ancestor
  has a board record for that process with a `lastPromptAt`; `TMUX_PANE` is `%<n>` and is that session's own pane
  (`board.sh` `me_ident`'s rule); the toplevel is `<main>/.claude/worktrees/<name>` with a lane-shaped branch, a lane
  file written in the last 10 min and a clean tree; not the hub (branch, worktree or record name); the box is on
  screen and empty. It runs mid-turn, under the working footer, so it reads no busy markers: `send` does. Then it writes `<board>/self-compact/<pid>.req`: `1 <start tick> <epoch> <lastPromptAt>`.
- **The hand-off** (`.claude/hooks/board-heartbeat.sh idle`, after the board write): only with a flag for this
  session's pid, and not on a Stop a stop hook continued (`stop_hook_active`: the request lapses, since the next Stop follows a new
  prompt and skips as `prompted`), it runs **main's
  committed** `scripts/board/self-compact.sh stop <pid>`, only when that file and the `lib.sh` it sources hash, on
  disk, to main's `HEAD` blobs (`git hash-object --no-filters` against `HEAD:`, with no replace refs and global and system git config off for those
  two calls; not
  `git diff`: an empty diff proves nothing about a missing path, and a skip-worktree flag hides an edit), detached
  (`setsid -f`, `timeout -k 1 10`, stdio on `/dev/null`, exit ignored), so it can never fail or delay Stop. With no flag a Stop costs
  one `stat`. No `settings.json` change: it rides the registered Stop entry.
- **`stop`** prints nothing, reads no stdin, always exits 0: sweeps flags, claims and write leftovers over 15 min
  old, claims the flag by `mv` (a second Stop finds nothing), then re-checks the same pid and tick, no prompt since
  the request (`lastPromptAt` unchanged), a flag at most 10 min old, the record's `cwd` (`[A-Za-z0-9_./-]`), the lane
  boundary and the pane, and spawns `send` detached.
- **`send`**: 2 s, then the guard (switch, process, pane, board `idle`, no prompt since), box empty and not busy, and
  not past 8 s since it started (else `late`: nothing typed rather than the 20 s timeout between text and Enter),
  `send-keys -l /compact`; 0.5 s, the guard again, and `Enter` only if the box shows exactly `/compact` (else no
  further key, so a guard failing in that 0.5 s leaves `/compact` unsent in the box for the user to see). Run by hand
  it skips `stop`'s lane and hub checks: it gains nothing over a raw `tmux send-keys`.
- **The box** (measured on 2.1.329, 2026-11-19, `tmux capture-pane`): the `❯` line directly above the bottom-most
  `─` rule; anything else there (a dialog, a multi-line draft) reads as no box, so an older box in the scrollback
  never stands in. Busy: `esc to interrupt` (a foreground turn), `background agent` or `to manage` (a background agent
  running: no `esc to interrupt` then), read only below the box and in the 5 lines above it, so a quoted marker in the
  conversation doesn't count.
- **Log**: `<board>/self-compact.log`, one line per event — `request`, `refuse`, `claim`, `spawn`, `sent`, `skip` —
  `<time> <event> pid=<n> branch=<b> reason=<word>`.

Measured upstream on 2.1.329 (a peer project's trials, 2026-11-19), unmeasured here: Stop doesn't fire after `/compact`,
and neither does UserPromptSubmit; a peer message does fire it and wakes the compacted session. So a compacted lane
waits for its next message: `request` belongs only where the lane waits for the hub anyway.

Unmeasured anywhere, run-only at the switch flip: whether UserPromptSubmit fires for a message queued mid-turn and for
a turn a finished background task starts (if not, `lastPromptAt` misses it and the dirty-tree and busy checks are the
only cover); the box with the slash menu open after typing.

Accepted residuals: the heartbeat already runs the branch's own `scripts/board/lib.sh` and `board.sh` (the hand-off adds
no branch code: main's script re-derives everything); any session can write the board dir, so a forged flag reaches
main's `stop`, which re-checks it all; the busy markers are screen text; "main's committed" means main's `HEAD`, not
`origin/main`, so a `/workspace` left on another commit runs that commit's script and switch.

**Turning it on**, one PR: re-measure the box and busy shapes on the installed version; `selfCompact: true`; add to
`docs/ops/FEATURE-WORKFLOW.md` → _Lane status and checkpoints_: "Where the lane now waits for the hub — after an
`[ask-maintainer]` it holds for, and after `[pr-open]` — with the lane file just written, the tree clean and no
background task or agent running, its last tool call may be `bash scripts/board/self-compact.sh request`; a refusal
changes nothing." Then watch the first run: `request`, `claim`, `spawn`, `sent` once; the summary carries the block; a
hub message wakes the lane.

## Log

`localNotes/handoffs/precompact.log`, one line per compaction:

```
2026-10-19T14:02:11-07:00 trigger=manual sid=4cee5162 branch=precompact-handoff rc=0 dur=41s fork=… subtype=success turns=6 cache_read=… cache_new=… out=… denials=0 error=false file=handoff-…-4cee5162.md
```

`denials` > 0 means the skill asked for something the allowlist refuses — fix the skill or the list.
`error=true` adds `err="…"` when the result has text: its first 160 characters, stripped to `[A-Za-z0-9 ._:/-]`, placed
before `file=` because the post-compact hook anchors on `file=…md` at end of line. The one failure so far
(places-shortcuts, 2026-11-04 03:50 PST: `trigger=auto rc=1 dur=5s turns=1 cache_read=0 error=true
file=none`) left an empty stderr, so its `.err` was pruned and the cause — most likely the claude.ai usage
limit that session had hit at 01:01 — is unprovable; with `err=` the next one names itself. No retry:
compaction waits for the hook, and a usage-limit refusal would fail again. There is no standing check of
this log — read it when a compacted context opens with "Handoff available" (a path) instead of "Handoff
written just before this compaction".
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
bill that key instead, since the fork inherits it. **`cache_new` is 25–35k on every real run** — the 8
successes logged 2026-10-31 → 11-04: 36–65 s, 3–5 turns, cache_read 1.03–2.64 M, cache_new 25.5–32.2k,
out 3.3–4.9k, 0 denials. A worktree's first compaction and one session's fifth read alike (32.2k → 26.5k
→ 25.5k → 27.1k → 31.3k), so it is not many-compactions drift or prefix divergence (1.5–3 % of the read):
it is the fork's own work — the 8 KB handoff skill, `load-context.sh`'s 15 KB index, git status/log/diff
output, its Reads, the written file. The 8k of 2026-10-30 was a near-empty session. Rule: 25–35k is
normal; look only above ~50k. On idle compaction the cache may have expired; the fork then pays the
write compaction would have paid anyway, and compaction reads it.

## Testing

- `python3 .claude/hooks/testdata/run-fixtures.py` — the compaction suite runs the hook against a stub
  `claude` (no network, no cost), the lane block's stdout checked exactly; the hand-off suite runs the heartbeat
  against a stub `self-compact.sh` (hangs, failures, main's copy dirty or missing).
- `scripts/src/board/self-compact.test.ts` — `request`, `stop` and `send` against a temp main, board and tmux shim.
- Live: a session must be **started from the directory whose `.claude/settings.json` has the hooks** —
  `${CLAUDE_PROJECT_DIR}` is the launch directory, so a session started at `/workspace` doesn't see a
  worktree's unmerged hooks. Run `/compact`, then check the log line (`rc=0`, `denials=0`, `file=`), the
  handoff, the `compact-*` file, and that the compacted context shows the handoff. Done 2026-10-30 in a
  session started in the worktree: a "for the handoff" chat word and a `/compact` instruction word both
  reached the handoff, `PostCompact` carried `compact_summary` (until then docs-only), and the compacted
  session's context opened with "Handoff written just before this compaction".
