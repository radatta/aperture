# Right Now + Coming Up (the daytime home)

**Area:** home · **Branch:** `now-focus`

**Status: built 2026-09-19** (branch `now-focus`, off `main` at #21 Bulk Add Tasks). Gate green:
typecheck · lint · tests (app 240 · lambdas 102 · shared 79 · cdk 25) · headless UI + workflow pass
(opus, both themes + 390px, all three interactions) · code-review (opus: 0 blocking, 0 should-fix, 2
recorded nits). **Dev-validated in daily use** (confirmed 2026-09-26; the estimate-vs-actual count-up
and the plan-derived focus wanted a real morning→day→night before being trusted). Frontend-only — no RPC, no shared-type, no lambda
changes.

A daytime home that answers **"what's happening right now?"** at a glance, and surfaces the few things
that make today a win. Replaces the old `TodayTasksCard` + `FocusCard`. Part of the "Now / Focus /
Rolls" epic (full context: `localNotes/now-focus-rolls-epic.md`); this is PR 2 of 3.

Permanent design-of-record: §3 is the decision log, §5 the build record. Where this doc and the code
disagree, fix whichever is wrong and say so here.

---

## 1. Why

The trigger: a task you've _started_ (`in_progress`) was buried in the backlog list — the one thing you
most need to see was the hardest to find. And the deeper problem, in Rahul's words, is _"cognitive
overload of having to do everything, a growing todo list in my face."_ For a student juggling ~1 HW per
class plus labs, errands, and deadline-free wants (LeetCode, study), the stress isn't the tasks — it's
holding them all at once.

The fix is to only ever show the **tight plane** during the day: what you're doing now, the few that
count, and a calm radar of what's coming — while everything captured and every deadline stays in a
drawer the system watches _for_ you. That trust ("I can put it down and it'll resurface") is the point.

## 2. What it is

Two cards, always shown, fixed order (no collapse, no time-of-day reorder):

- **Right now** — the daytime hero.
  - **Hero**: the in-progress task, big, with a calm **count-up vs its estimate** ("12m of ~45m",
    "started 9:40 AM"). Never a countdown, never red, never a bar.
  - **Big 3 (Focus)**: the top three of today's plan (by `taskPlans.order`). The rest of today drops to
    a lighter **Also today** lane.
  - Finishing the hero returns a gentle **"what's next?"** prompt — never an auto-loaded next task.
  - Cold-start "Start 25-min focus / Take a break" footer (inherited from the old FocusCard).
- **Coming up** — a gentle, capped, soonest-first **deadline radar** (from `dueDay`), flat and quiet,
  with a "+N more this week" link to the (future) full dues view. You plan _from_ it; it never scolds.

```
Daytime home
  Day shape          (from PR-C: longest free stretch + fragment count)
  Right now
    ┌ hero: Rewrite the onboarding section    12m of ~45m · started 9:40 AM   [Focus] [Done]
    ├ Finish the problem set        60m   [Start]
    ├ Clear the email backlog       20m   [Start]
    └ Also today
        Skim the lecture notes            [Focus this]
        Tidy the desk                     [Focus this]
  Coming up
    Fix the flaky CI test     was due yesterday
    Draft the project proposal   due Wed
    Submit the lab report        due Fri
    +1 more this week →
  Time budget        hours spent vs planned
```

Elapsed is honest and live: `actualAccruedMin` (closed sessions) **+** the running work timer's active
seconds, which aren't on the task yet. A count-_up_ — it keeps climbing calmly past the estimate, no
colour flip, no "you're over" nudge.

## 3. Decision log

**D1 — Big 3 is plan-derived; no new field.** The top three of today's plan (`taskPlans.order`) _are_
the focus; the hero is whichever is `in_progress`. _Rejected:_ a dedicated focus flag / entity — plan
order already encodes "what I chose for today", and a new field is model weight + a second source of
truth. (The MIT/"Big 3" method: 1–3 is the validated cap, and the _act of choosing_ is the value.)

**D2 — Hero = in-progress, focus-preferred, with an off-plan fallback.** The hero is the in-progress
Big-3 task; if none of the Big 3 is running, it falls back to any in-progress task (shown in Also-today,
tagged "not planned today"). _Rejected:_ hero strictly from the Focus tier (the fable plan's first
cut) — that would show "pick one to start" while a task is genuinely running, re-burying the exact thing
this feature exists to surface.

**D3 — Done stays in its slot; no auto-advance, no promotion.** Completing #2 does not pull #4 up, and
finishing the hero doesn't auto-load the next. _Rejected:_ the Motion-style conveyor belt — it's
relentless, and keeping done tasks in place is what makes "Big 3 done" a real, visible win. (Complice:
no auto-advance, no guilt carryover.)

**D4 — Count-up, flat, no bar.** Elapsed-vs-estimate is plain text that climbs past 100% unchanged.
_Rejected:_ `MiniBar`/`DeltaBar` on the hero — MiniBar flips gold at the estimate, which is precisely a
live "you're running over" nudge, and Leroy (2009) found time-pressure worsens attention residue into
the next task. The gap belongs in the _night_ reflection, not as a daytime scold.

**D5 — Elapsed includes the live running timer.** `actualAccruedMin` only bumps when a session closes,
so a naive read under-reports mid-work. We add the running work timer's `activeSec` on top (added to
`RunningTimer`). _Rejected:_ showing raw accrued (wrong while you're actively working the hero).

**D6 — Two tiers: Focus vs Also today.** The Big 3 stay sacred; smalls/errands live in a lighter lane.
_Rejected:_ one flat list — the Big 3 would silently become a junk drawer.

**D7 — Radar is capped, gentle, and de-duplicated.** ≤3 soonest-first, then "+N more this week"; no red,
no overdue tally; excludes anything already on the tight plane (today's plan + in-progress).
_Revisited 2026-10-05:_ a **timed** task's row (here, and the Right-now hero/rows) takes the deadline
urgency colour — gold edge ≤6h, gold fill ≤1h, red once past ([due-dates.md](../tasks/due-dates.md) D5
revisited); Right-now rows also show its "due today 4pm" phrase. The hero's count-up stays flat — the
colour is about the deadline, never the estimate. Still no tally.
_Rejected:_ the full dues list on the home — that's pr-d's grouped-by-course _deep view_, and PRODUCT §3
caps the home at ~5 elements. This is the glance; pr-d is the drill-down.

**D8 — "Make it a focus" (promote) is how you choose the Big 3.** There is **no reorder UI anywhere**
(`order` is only set at `addToDay` = append), so without this the Big 3 would just be "the first three
you happened to pull in." "Focus this" on an Also-today row renumbers the day's plan (`promote`, via the
existing `upsertPlan`) so the chosen task lands in the last focus slot. _Rejected:_ leaving focus
un-choosable (undercuts the whole "the act of choosing is the product").

**D9 — Radar is daytime-only (not morning).** _Rejected:_ also rendering it in the morning home —
morning is already at PRODUCT §3's ≤5-element cap (capture + 4 cards). The mode-pin lets you open Daytime
at any hour, so you're never _locked out_ of the radar by the clock; it just isn't duplicated onto a
full morning. (Revisit if morning loses a card.)

**D10 — Subsumes both `TodayTasksCard` and `FocusCard`.** Right now carries what both did (today's list
plus the pomodoro focus launch). _Rejected:_ keeping either — that duplicates the plan and pushes daytime
past 5 elements.

**D11 — Timed tasks are a "By time" tier, never a Big-3 slot (2026-10-30, parts v2b).** A task due today
at a time is on Today by its time ([lenses.md](../tasks/lenses.md) D13), not by choice, so it doesn't
take a slot the plan pass chose: the Big 3 stay plan rows, and timed rows sit in their own tier above
Also today, by clock, with no "Make it a focus" (`promote` moves plan rows only). The hero can be a
started timed task. A day with only timed tasks isn't "Nothing planned". _Rejected:_ one merged list,
timed first — every "submit by 4pm" would take a chosen slot.

## 4. Where it lives

- `app/src/modules/home/rightNow.ts` — pure derivations: `rightNow(rows, allTasks)` (focus / byTime /
  also-today / hero / nextPrompt, over `todayRows`), `liveElapsedMin(task, timers)`, `promote(rows, taskId)`.
- `app/src/modules/home/comingUp.ts` — `comingUp(tasks, today, excludeIds)` (capped radar + overflow).
- `app/src/pages/Home/RightNowCard.tsx`, `ComingUpCard.tsx` — the two cards. `CardLink` moved into
  `HomeCard.tsx` to share it.
- `app/src/modules/tasks/DoneForm.tsx` — lifted out of `TaskCard` so the hero's "Done" reuses the exact
  calibration path, with an added `initialActualMin` (prefill the live elapsed).
- `app/src/modules/pomodoro/{pomodoro-context,PomodoroProvider}.tsx` — `RunningTimer.activeSec`;
  `stop()` now returns its promise so the hero can `await stop()` before the actual is captured.
- `app/src/data/seed.ts` — a today's plan (with an in-progress hero) + dated backlog so the surfaces
  render real data.

## 5. Build record

- [x] **Phase 0 — pure logic + tests.** `rightNow.ts` (+ `promote`, `liveElapsedMin`), `comingUp.ts`,
      with unit tests (16). Logic proven before any UI.
- [x] **Phase 1 — pomodoro seam.** `activeSec` on `RunningTimer` (computed in the provider's timers
      memo); `stop()` returns `Promise<void>`. ↳ `TimerBar` callers ignore the return — no change.
- [x] **Phase 2 — DoneForm lift.** Extracted to its own file + `initialActualMin`; `TaskCard` imports it
      (behaviour unchanged).
- [x] **Phase 3 — cards.** `RightNowCard` (hero, Focus lane, Also-today, cold-start, next-prompt),
      `ComingUpCard` (capped radar). `CardLink` moved to `HomeCard`.
- [x] **Phase 4 — wire the home.** `DaytimeHome` = Day shape → Right now → Coming up → Time budget;
      removed `TodayTasksCard` + `FocusCard`. ↳ radar daytime-only (D9).
- [x] **Phase 5 — seed.** Today's plan (5 rows, #2 in progress as the hero) + two more dated backlog
      tasks so the radar shows "+1 more this week". ↳ isolated the recurrence stub test with `seed:false`
      (it had assumed the seed made no today-plans).
- [x] **Phase 6 — jsdom integration tests.** `RightNow.test.tsx` (split, Start→hero, live-timer,
      Done→what's-next-no-auto-advance, empty), `ComingUp.test.tsx` (capped + overflow + exclusion, empty);
      `Home.test.tsx` asserts both cards.
- [x] **Phase 7 — gate.** typecheck · lint · full test suite green.
- [x] **Phase 8 — headless UI + workflow pass** (opus, both themes + 390px). PASS: no console errors,
      no-scold confirmed, all three interactions (Start→hero, Focus this→Big 3, Done→"what's next" with no
      auto-advance) verified. ↳ fixed a 390px nit: category chips could wrap on a truncated row
      (`shrink-0 whitespace-nowrap` on the chip + `min-w-0` on the row title).
- [x] **Phase 9 — code review** (opus, project-aware). 0 blocking, 0 should-fix. Two recorded nits (not
      fixed, both cosmetic/transient): `promote` renumbers over raw rows so a _cancelled_ task left in
      today's plan can shift the promoted task's slot within the Big 3 (still lands in focus); and the radar's
      `excludeIds` doesn't gate on the plans-query pending state, so a dated planned-today task could flash
      for one tick before exclusion. Neither occurs with the current seed.
- [x] **Phase 10 — dev validation** — the count-up + plan-derived focus over a real day (in daily
      use; confirmed 2026-09-26).

## 6. Deferred / follow-ups (found, not built here)

- ~~A `planned` task whose plan row is on a past day appears nowhere.~~ Resolved: `getDay` sweeps it
  back to the backlog, and the night "Still open — when?" step asks first
  ([tasks/lenses.md](../tasks/lenses.md) D8).
- `useTodayPlan.spentMin` is not live either; `liveElapsedMin` could feed `TimeBudgetCard` later.
- ~~The radar's "+N more this week" links to `/tasks` for now.~~ It links to `/tasks?lens=week`.
- **Non-hero in-progress tasks have no inline Done/Focus** — only the hero is actionable (D2: "the one
  you act on"), so finishing a _second_ concurrent in-progress task means a trip to `/tasks`. Deliberate
  and fine for the common single-task case; surfacing a Done on non-hero in-progress rows is a later
  polish if juggling proves common.
