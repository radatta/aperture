# Lanes — one branch, one worktree, one session

A **lane** is one feature: one branch, one worktree at `.claude/worktrees/<branch>`, and one Claude session in a tmux
window, all named after the branch. It is born at kickoff with `pnpm lane start` and gone at cleanup with
`pnpm lane end`. `dispatch` is the only hub (`docs/ops/HUB.md`). A side job goes to a background agent, never a new
window. Both commands run from the main checkout (`/workspace`), so main's code always runs them. Code:
`scripts/src/lane/`.

```
pnpm lane start <branch> [--kickoff <file>] [--skip-permissions] [--over-cap "<reason>"]
pnpm lane end <branch> [--force-abandon "<reason>"]
pnpm lane status
```

Exit codes:

- 0: done
- 1: failed midway (says what was rolled back and what is left)
- 2: usage or a bad name
- 3: refused, with nothing changed
- 75: refused for now (cap full, deploy still running): wait or act, then rerun

**Names.** `^[a-z0-9][a-z0-9-]{0,62}$` (the mailroom's rule). Not `main`, `master`, `dev`, `devb`, `test` (the heavy
guard would read `pnpm lane start test` as a suite), or the hub's `hub.json` name. Such a name is safe in a path, a
tmux target and an unquoted zsh word. The window name is the session's board name and its `SendMessage` address
(`board.sh` `me_ident`), so it must be unique.

## Start

It refuses, changing nothing, on any of these:

- a bad name
- a missing, empty or over-256-KiB kickoff
- not running in the main checkout
- no tmux session to open the window in
- tracked changes in the main checkout, or a branch checked out there (untracked paths are only listed)
- a failed fetch
- a branch of that name, locally or on origin
- an existing worktree path or lifecycle record
- a window of that name
- **the cap** (exit 75): it names every active lane and its phase

Then it runs these steps, each registering an undo:

1. Claims the lifecycle record (`O_EXCL`, so two starts can't race).
2. Detaches the main checkout at `origin/main`.
3. Runs `git worktree add --no-track -b <branch> .claude/worktrees/<branch> origin/main`.
4. Checks the worktree's `.git` reads `gitdir: ../../../.git/worktrees/<branch>`, before the install, so a pre-2.48
   git fails fast.
5. Runs `CI=true pnpm install` in the worktree.
6. Copies the kickoff to `<worktree>/localNotes/kickoff.md`.
7. Opens `tmux new-window -d` in the worktree, named `<branch>`, and records the window and pane ids.
8. Types `claude -n <branch> '<constant prompt>'` into that window's shell. The prompt only says "Read
   localNotes/kickoff.md and follow it". **No kickoff text ever reaches an argv**: COI reads every process's argv,
   and a kickoff quoting the safety rules would kill the container. The window starts a shell, not Claude, so
   `tools/coi/tmux-restore.sh save` finds Claude as the shell's child. `--skip-permissions` adds
   `--dangerously-skip-permissions`; it is off unless asked for.
9. Writes the board lane: phase `plan`, step `kickoff sent`, after clearing a past same-name file (`writeLane` would
   carry its PR number on).
10. Waits up to 20 s for Claude's own registry (`~/.claude/sessions/<pid>.json`, never the `.key` files) to show a
    session named `<branch>` in the worktree. This only warns.

A failure in steps 1–8 runs the undos in reverse (kill the window by id, `git worktree remove`, the safe
`git branch -d`, which works because the branch is still at `origin/main`, and drop the record), then names anything
left behind. The script never force-deletes. Steps 9–10 never roll back a live session. Because the install is in
it, a caller gives it a **600 s timeout** or runs it in the background.

**The cap.** `scripts/board/limits.json` → `lanes.maxActive` (5: 2 dev slots, 2 full suites). A lane counts as
**active** when all of these hold:

- it has a worktree under `.claude/worktrees/` on a branch (`board-matrix-*` scratch excluded)
- its lane file isn't `parked`
- it has a live session or a lifecycle record. A live session is a `board/sessions/<pid>.json` that isn't `gone`,
  whose pid is alive and has the same start tick.

So a stale worktree with no session doesn't count. `--over-cap "<reason>"` goes past the cap and keeps the reason in
the lifecycle record (`pnpm lane status` shows it).

## End

Without `--force-abandon`, it goes ahead only when all of these hold:

- `gh pr view <branch>` is `MERGED`
- the PR's head is the local branch head (else those commits would go with the branch)
- main's `Deploy` push run for the merge commit is green. A run cancelled by a later merge is followed to the newer
  run (`deployFor`, `tower/derive.ts`). Still running exits 75; failed or not found exits 3.

`--force-abandon "<reason>"`, on the user's word, skips only those gates. In both modes it refuses when:

- the worktree has uncommitted files (never forced)
- the branch holds a live dev lock (`pnpm bot lock release` first)

Then:

1. Copies the worktree's `localNotes/` to `/workspace/localNotes/archive/<branch>/` and compares the two trees by path,
   size and sha256 (a symlink by its target). A mismatch exits 1 with nothing removed. An existing archive is never
   overwritten: an identical one is reused, anything else goes to `<branch>.<n>/`.
2. Writes `mac-cleanup.txt` (the Mac line) and `lane-end.txt` (PR, merge sha, or the abandon reason) into the archive.
3. Runs `git worktree remove` (never forced; a refusal stops here, and a rerun resumes).
4. Clears the board lane and the lifecycle record.
5. **Prints the maintainer's Mac line, never runs it** (below).
6. Closes the window, **last and by its recorded id only**. That happens only when the tmux server's pid and start
   time match the record and the window still carries the lane's name. Otherwise it closes nothing and says why. A
   window is never looked up by name. Run from the lane's own window, the close is delayed 90 s
   (`tmux run-shell -d 90`) so the session can still send `[merged]`.

A rerun after the worktree is gone skips steps 1–3 and prints the same line.

**The Mac line.** One `&&` chain from `cd <mac-repo>`:

- always `git branch -D <branch>` (hard-blocked for Claude; squash merges make `-d` refuse)
- for a branch admitted to the `dev` environment (`docs/ops/CI-BOT.md` → workflow changes), also the admission's
  DELETE by its id, which the command read, plus the listing that shows it went. When the read failed, it uses
  CI-BOT.md's by-name form instead, which removes nothing for a branch that was never admitted.

It is zsh-safe: every word with `? * [ < ! { }` is single-quoted, and gh runs as `GH_PAGER=cat gh`. The command
writes it with stdout and `fs` only, so no hook sees it. **Relay it by `SendMessage` or point at `mac-cleanup.txt`.
Never paste it into a Bash command**: the force-delete text on a command line is denied by `gh-safety-guard.sh`. For
the same reason, an abandon reason must not quote the delete command.

## State

| What                       | Where                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase (the tower reads)    | `<board>/lanes/<branch>.json` (`docs/ops/TOWER.md` → _Lane files_)                                                                                                                                                 |
| Window identity, the start | `<board>/lifecycle/<branch>.json`: window and pane ids, the tmux server's pid and start time, base sha, kickoff path, over-cap reason. Its own directory, because `writeLane` rebuilds a lane file from known keys |
| The cap                    | `scripts/board/limits.json` → `lanes.maxActive`                                                                                                                                                                    |
| The end record             | `/workspace/localNotes/archive/<branch>/` → `mac-cleanup.txt`, `lane-end.txt`                                                                                                                                      |

**Legacy lanes.** A lane started before these commands has no lifecycle record. `lane end` still archives,
removes and prints, but leaves the window for its owner to close.
