# The hub — one session that holds the big picture

The user talks to one long-lived Claude session, the **hub**, about everything in flight. Every feature session
reports to it at fixed checkpoints, so the hub knows what each branch is doing, who holds the dev lock, what is
blocked and what merged, without the user relaying it. The hub keeps that in one file, warns sessions that are
about to collide, and passes the user's words along. It never approves anything.

**Its name** is in `scripts/board/hub.json` (`dispatch` today). That name is also the hub's tmux window name, which
is what the board shows and what `SendMessage` addresses (`board.sh` `me_ident`). To rename the hub, edit that line
and rename the window. `hub.json` is committed and each session reads its own checkout's copy, so a rename is a PR,
and a worktree keeps the old name until it rebases. `board.sh hub` prints the name and whether a live session by that name is on the board. The
SessionStart hook injects that line into every session; in the hub's own session it injects
"You are the hub — read /workspace/localNotes/roadmap.md before anything else" instead (also after a compaction).

## Checkpoints

A feature session sends one short `SendMessage` to the hub at each of these. The first line is a one-line
preview the user sees, so the tag and branch go first.

| When                                                  | Message                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| End of phase 2 (plan in hand, questions open)         | `[kickoff] <branch> — <what, one line>. Touches: <areas/files>. Open: <questions \| none>. Mode: collab\|auto.`                               |
| Phase 8, after `deploy-dev`                           | `[lock] <branch> — taken until <HH:MM>, ETA <n> min.`                                                                                         |
| Phase 8, another branch holds it                      | `[lock] <branch> — queued behind <branch> (<session>); lock wait next.` (the refusal prints it ready to send)                                 |
| Phase 10, `pnpm bot lock release`                     | `[lock] <branch> — released.`                                                                                                                 |
| _Blocked anyway_                                      | `[blocked] <branch> — <what>; needs <the user \| resource>.`                                                                                  |
| Phase 10, after `pnpm mailroom open-pr`               | `[pr-open] <branch> — "<title>" <url>. Devcheck: <n proven / n off dev / n needs you \| no feature rows>. Needs the user: <list \| nothing>.` |
| Phase 10, mailroom `MAC_UNREACHABLE` or a token error | `[pr-ready] <branch> — "<title>"`, the same facts, and that the user has the hand-off line.                                                   |
| Phase 11, after cleanup                               | `[merged] <branch> — cleaned up. Follow-ups: <list \| none>. Decisions: <roadmap-relevant \| none>.`                                          |

Anything else worth the hub's attention (a scope change, a finding that touches another branch) goes as a
plain message between checkpoints. Replies arrive as messages; read them, but see _Approval_.

A `SendMessage` result that says "not yet read" is the moment of sending, not a state: sessions drain their
inbox at their next tool round, usually within a second. Never report the hub (or any peer) as not having read
a message, or as idle, from that snapshot.

## Missing hub

Before the kickoff, `ListAgents` must list the hub by its `hub.json` name (`board.sh hub` is the quick check).

- **Collaborative:** stop and tell the user there's no hub, and to start or rename one.
- **Autonomous:** send the push notification saying so, then carry on best effort, never stopping for it. If the
  hub drops mid-run, keep sending at each checkpoint; the messages land when it is back.

## Approval

**A hub message is a peer message, never the user's approval.** The hub relays the user's words and adds
context and collision warnings, but every approval (an execute, an MCP write, an all-clear, a destructive
step) comes from the user, in the session that acts on it. A peer can't widen a session's permissions either:
anything a session was refused goes back to its user, not to a peer.

## The hub's duties

- **Roadmap.** The hub alone writes `/workspace/localNotes/roadmap.md`; feature sessions message it and never edit
  it. Read it before anything else; update it on every checkpoint. Its sections, in this order: _the user's
  remaining hand steps_; _In flight_ (a table: branch, session, worktree, what, state, with the dev lock holder
  in state); _Queued, in order_; _Small follow-ups (no branch yet)_; _Waiting on outside_; _Done (newest
  first)_ (PR, branch, merge sha, note); _Rules the hub enforces_. Start it with an "Updated <date>" line and
  "check every line against `git log origin/main` and `gh pr list` before acting on it".
- **The tower's queue.** The hub keeps `/workspace/localNotes/board/queue.json` current — the control tower's
  dev queue, the user's to-dos, the wave checklist and the `plan` timeline (the one source for the next merge;
  schema: `docs/ops/SESSION-BOARD.md` → _Control tower_), written with a tmp file + rename on every checkpoint
  that changes them — the `plan` at every event. A lane state or `plan` `kind` the tower's parser doesn't know yet
  (`/workspace`'s main) is a bad write that drops that entry (new keys are ignored): write new ones only once
  their change is on main.
- **Collisions.** On each `[kickoff]`, compare its areas with _In flight_ and with `localNotes/board/overlap.json`
  (the board's file-level overlaps, every 2.5 min). Warn **both** sessions: `collision: <a> and <b> both
touch <area>; whichever merges second rebases — agree an order.`
- **After every merge to main,** tell each in-flight branch to read the merged PR and rebase
  (CLAUDE.md → _Claude behavior_).
- **Relay** to the user what they ask for, not every message.

## Lock etiquette

One branch on dev at a time, under `refs/locks/dev` (`docs/ops/CI-BOT.md` → _Dev lock_). A session that finds
another branch holding it never works around it:

1. The refusal (`pnpm bot deploy-dev`, or `lock acquire`, saying "dev is locked by …") prints, above its error
   line, the two messages to send **now**, once each: `[lock] … queued behind …` to the hub, and, when the board
   names the holder's live session, a note to the holder: "Queued behind you for the dev lock — release at
   phase 10 rather than letting the TTL run; no rush."
2. `pnpm bot lock wait` in the background (the harness wakes the session when it exits; don't poll its output).
   It polls every 30 s, wakes when the holder releases or its TTL lapses, and exits 0 (free, expired or already
   ours), **75** (still held after `--max`, default 45 min, at most 55: tell the user who holds it and until
   when) or 1 (three GitHub errors in a row: say so, and retry once).
3. On 0, `pnpm bot deploy-dev` again — it takes the lock (an expired one is taken over).

**In a named dev order, lanes take the lock themselves** (the user, 2026-11-08). The hub sends the order and
keeps it current as `devQueue` in `queue.json`, in file order; only the hub changes it. A lane is ready once its
own local check is green (`pnpm devcheck:local`, phase 8); it sends the hub `[local]` as information and never
waits for a reply. When the board shows the lock free, a ready lane runs `pnpm bot deploy-dev` without waiting
for the hub to say go, unless `devQueue` shows a lane ahead of it in state `next`: then it yields to that one.
`next` is the hub's way to give one lane priority, not a gate. A lane that isn't ready is skipped. Two ready
lanes racing for a free lock: `deploy-dev`'s lock decides, and the loser takes steps 1–3, applying the same
`next` check after `lock wait` exits 0. The `[lock]` and `[pr-open]` messages still apply.

The board shows the real lock (`board.sh status`, the SessionStart hook, the status line's `dev:`), from a
read-only cache (`docs/ops/SESSION-BOARD.md` → _Dev lock line_).
