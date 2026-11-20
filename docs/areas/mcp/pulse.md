# Pulse tracking — Claude names the task, the server times it

The important work happens in Claude (claude.ai projects, Claude Code), and Aperture only knows about it when it is
told. Pulse tracking turns that around: a Claude session sends `pulse` on every reply, naming the task the reply was
for, and the server turns the pulses into work sessions and the task's actual minutes. The client has no clock, so it
sends no time and decides nothing; every number lives server-side. First test: one claude.ai project (recruiting), for
a week, with the paste-in block in [pulse-instructions.md](pulse-instructions.md). Success is the week's calibration
telling the maintainer something true.

Code: the decision is pure and shared (`packages/shared/src/pulse.ts`), the Lambda's `PulseService`
(`lambdas/src/pulse.ts`) and the stub (`app/src/data/stubClient.ts`) run it over their stores, and the shared contract
suite holds the two to the same behaviour. The tool: `lambdas/src/mcp/pulseTools.ts`.

## The tool

`pulse {taskId, note?, done?}` → `{task, counted, reason?, opened, sessionMin, taskActualMin, pulses, closed?, done?,
needs?, message?}`. RPC `pulseTask(input)`.

- **A pulse on an unstarted task starts it** (backlog or planned → in_progress, through the app's own transition, so
  the estimate lock freezes as a Start would freeze it).
- **Pulses inside the window extend the session**, crediting exactly the gap since the last pulse.
- **A gap past the window ends the session** at its last pulse plus the grace; the next pulse opens a new one on the
  same task. A break ends a session, never the task.
- **One open session per user.** A pulse for task B ends A's session now (with the time since A's last pulse, never
  more than the grace) and opens B's.
- **`done: true`** finishes the task when its done gate allows: the session ends with its grace (the last reply is
  read too) and the task goes done with what was tracked. A done with nothing live on the task opens nothing: after
  the task's own window, its old session settles with its grace (which counts toward the gate); after a switch or in
  a new thread, it adds nothing. Refused, it is an ordinary pulse — the session stays open — and `needs` says
  why: `estimate` (no estimate: Claude asks, sets one with `update_task`, pulses done again), `actual` (under a minute
  tracked: the user's own number goes through `complete_task`), `app` (a timer or a sitting times the task: finish it
  in Aperture, which stops it). `complete_task` is unchanged: it needs `actualMin`, and a typed actual still replaces
  what was tracked.
- **Refused before any write:** an unknown id or another user's (`Not found`), a done or cancelled task (`Task is
already …`), a parent opening a session (`pulse the part being worked on`), and bad arguments (a param error).
- **Missed pulses are tolerated by design.** claude.ai has no timer or hook, so "every reply" is the cadence: a missed
  pulse is a slightly shorter session, never an error, and a pulse never needs the one before it.

## How it's stored

- **A pulse session is a `PomodoroSession` row with `source: 'pulse'`, written `completed` from birth** in its day
  bucket (`sess#<day>#<id>`) and rewritten in place as pulses extend it. It never touches `sess#running#`, so the app's
  timer (which adopts running rows and prompts on stale ones) never sees it; the export, the `wasWork` snapshot and
  `listSessionsForDay` read it like any session. Its minutes are always `endedAt − startedAt`.
- **Time is credited once it has passed, and never taken back.** While a session runs it is credited to its last
  pulse (`endedAt` = the last pulse), so the task's `actualAccruedMin` holds exactly that. The session's tail — the
  time since its last pulse, at most the grace — is credited when the next pulse (for any task) or a timer start on
  its task settles it; a gap past the window settles it with the whole grace. A done credits the grace at once. There
  is no close step, no cron and no write on read; the cost is that a session's last few minutes stay uncredited until
  the next pulse. Every delta is ≥ 0, so a typed actual or an app Done is never eroded: a tail settled onto a task
  finished meanwhile is not credited (the row keeps it, as a timer stopped on a finished task does).
- **One state row, `pulsestate`**, holds the open session (`OpenPulse`); every pulse changes it with a conditional
  write (`repo.casUpdate`), so two pulses at once are serialised — the loser re-reads and plans on the winner. The
  session row is a pure function of it (so a category's work-flag backfill updates the open session's `wasWork` in
  the state row too), written unconditionally: two pulses at once (two tabs) can land their rows
  out of order, which the session's next pulse rewrites; a stale row on a session's very last pulse stays (the
  drift-check follow-up).
- **A task's minutes move by a conditional delta** (`repo.accrueTaskMinutes`): an app write landing meanwhile (a Done,
  an edit) is re-read and kept, never flattened; a task finished meanwhile keeps its actual.
- **Write order:** the task's start, the state row, each changed session row, each task's minutes, then a done. A
  crash between them only under-counts (every credit is ≥ 0), by at most one window plus the grace; the next pulse in
  the session rewrites its row from the state row.
- **Cost:** a steady-state pulse (extending a session on a plain task) is one MCP invocation, about 6 read units (the
  task and the state row, each read twice, its category, the running timers, settings) and 3–10 write units (the state
  and session rows each carry up to 20 notes, the task row). Two reads grow with history, not pulses: a pulse that
  opens a session reads the task list (the parent check, consistent), and a pulse on a Roll rep reads the sitting
  heads. Usage-priced, no standing charge, no new resource
  ([arch/INFRA.md](../../arch/INFRA.md) §11).

## Numbers

All server-side, in `packages/shared/src/pulse.ts`, so the first week's check retunes them with no schema change and
no re-paste:

| constant           | value                                                 | why                                                                     |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `PULSE_WINDOW_MIN` | by life area: recruiting 20, school 25, others 15 min | silent stretches (a mock, homework on paper) must not split a session   |
| `PULSE_GRACE_MIN`  | 3 min                                                 | reading the last reply; a one-exchange session is worth about this much |
| `PULSE_NOTE_MAX`   | 140 characters                                        | one line                                                                |
| `PULSE_NOTES_KEPT` | 20 per session                                        | the newest; enough to read what a session was                           |

The window follows the task's category's life area (`areaOf`; no category reads as personal), not a Category field: one
constant to move, no UI. A per-category override is a follow-up if the area proves too coarse.

## Interplay — never double-counted

- **A running work timer on the task times it.** A pulse on that task counts nothing (`counted: false, reason:
'timer'`), at any heartbeat age: a timer on a locked phone credits the whole gap on its next beat, so a freshness test
  would double-count. A timer on another task is its own clock; the pulse counts.
- **A timer started on a task with an open pulse session settles that session now** (`startSession`, both impls,
  best-effort: a failure is logged and the next pulse, blocked by the timer, settles it). A timer forgotten and left
  stale blocks pulse time on that one task until its keep/discard — an under-count, never a double count. The timer
  read is strongly consistent; the one race left — a pulse that read "no timer" opening its session just after a
  timer start found nothing to settle — overlaps the timer by at most the grace, settled at the next pulse. A sitting
  Start that attaches a rep pulsed just before has the same bound: it doesn't settle the pulse session, so the two
  overlap by at most the grace, until the next pulse (blocked by the sitting) settles it.
- **LeetCode sittings time their reps.** A pulse on a task that any sitting (ended ones too) names as its rep counts
  nothing (`reason: 'sitting'`), and `done` answers `needs: 'app'`: the rep's time is its sittings', and it is
  finished with Done in Aperture, which sets its actual from them. Sittings and Rolls are unchanged; a rep with no
  sitting is a plain task, and a done through `pulse` runs the same transition (Roll
  momentum, sitting ends) as the app's.
- A blocked pulse also settles any open pulse session (the work moved to the timed task), and changes nothing on its
  own task — it doesn't start a backlog one.

## Privacy of notes

A note is a few plain words on what a reply covered, written by Claude from the same conversation, so nothing new is
disclosed. Stored only on the session row in the user's own partition (newest 20, one line, cut at 140 characters —
a pulse is never refused over its note, which would lose the time); shown nowhere in the app and in no MCP read;
never logged. They leave the table only in the user's own export and the API's `listSessionsForDay`. The instructions
ask for no code, quotes or personal details. The dev check sends synthetic notes and never prints one.

## Approval

On claude.ai, project instructions the user pasted in to ask for pulses are their standing approval for `pulse`; the
tool's description says so, and that anywhere else (Claude Code included) every call is asked first. In Claude Code, `pulse` is an ordinary write under CLAUDE.md's every-write rule
(no standing approval). claude.ai prompts each custom-connector tool by default ("Ask each time"), and per its
connector docs a destructive tool always prompts; `pulse` sets the MCP annotations `destructiveHint: false`,
`readOnlyHint: false`, `openWorldHint: false` (omitted, the spec reads a write as destructive). Whether that plus
**Always allow** runs every pulse with no prompt is unproven until tried — a run-only fact (the devcheck's
`prompt-free` row, _Needs you_). Setting it: claude.ai → Settings → Connectors → Aperture → the tool list → `pulse` →
Always allow; reconnect first after the deploy that adds the tool ([index.md](index.md) → _A session's tool list is
fixed when it connects_).

## Proof

Contract: `packages/shared/src/contractTests.ts` → _pulses_ (stub and Lambda). Pure: `packages/shared/src/pulse.test.ts`.
The table, the races and ownership: `lambdas/src/backend.pulse.test.ts`. The tool: `lambdas/src/mcp/pulseTools.test.ts`. Dev:
`scripts/src/devcheck/scenarios/pulse-tracking.ts`, as the dev test user through dev's `/mcp` (its window-lapse step is
a real 15.5-min wait, slow tier).

## Deferred

The morning ritual's gone-quiet prompt (done / keep going / drop) and a stale timer blocking pulses; moving
misattributed minutes by their notes; the over-scope split offer at about twice the estimate; Claude Code hook pulses;
"brb"/"back" pause pulses; annotations on the other tools; a drift check of a task's actual against the sum of its
sessions; a per-category window override; pulse sessions in `get_day`.
