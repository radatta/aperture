# Rolls (forgiving momentum for deadline-free efforts)

**Area:** home · **Branch:** `rolls-momentum`

**Status: built 2026-09-21** (branch `rolls-momentum`, off `main` at #24 Right Now + Coming Up). Gate
green: typecheck · lint · tests (app 262 · lambdas 114 · shared 88 · cdk 25 · scripts 12). Opus headless
UI + workflow pass: **PASS-WITH-NITS** (one should-fix, fixed — §6; nits recorded there). Opus code-review: **0 blocking, 0 should-fix, 4 nits** (3 cleaned up — dropped the unused
`isRep`, de-duped `fmtLastRep`, documented re-plan-adds-not-moves; the 4th is the recorded picker nit).
**Dev-validated 2026-09-21** on the real Lambda + DynamoDB (create + persistence-across-refresh, the
pick→daytime→done→sheet loop, two-reps-a-day, edit/archive, category-delete reassign — all passed). Part
of the "Now / Focus / Rolls" epic (full context:
`localNotes/now-focus-rolls-epic.md`); this is PR 3 of 3, and the only one with new backend.

Permanent design-of-record: §3 is the decision log, §5 the build record. Where this doc and the code
disagree, fix whichever is wrong and say so here.

---

## 1. Why

Some of the things you most want to keep doing have **no deadline** — LeetCode daily, studying systems
design, working on Aperture. Nothing forces them, so they're the first to slip, and a plain task or a
"someday" checkbox has no pull. In Rahul's words: *"I will do things with an actual deadline; LC I will
keep putting off."*

Streaks are the usual fix, and they *do* motivate — but a resetting streak is a guilt machine: one missed
day zeroes it, and you start optimizing to protect the number instead of doing the thing. That's the exact
stress this app exists to remove. So Rolls give you streak-style momentum **that cannot be failed**: a
grid that only ever fills. A gap is just a lighter dot; nothing resets, nothing goes red. The pull is
real, the punishment isn't.

## 2. What it is

A **Roll** is a first-class entity: a deadline-free ongoing effort with a name, a category, and a default
estimate. Its momentum is a **contact sheet** — a GitHub-contributions-style dot grid, five Mon–Sun weeks,
derived entirely from your completed work.

- A **rep** is a completed task tagged to the roll (`Task.rollId`). There is **no counter** — the sheet is
  computed from done reps, so it can never drift from reality (the same "derive, never store a count"
  rule as LeetCode attempt-counts).
- The morning ritual is **"pick 1–2 today."** A `RollPicker` chip strip lives in the "Plan today" card;
  tapping a roll drops a planned rep task onto today's plan. That rep flows straight into the daytime
  **Right now** lane (PR 2) — completing it there *is* the rep, and it fills today's cell. Rolls feed the
  daytime home; they are not a parallel surface.
- Because a rep is a real task carrying the roll's estimate, **calibration rides ongoing effort too** — no
  special path.
- The `/rolls` deep view lists each roll with its contact sheet, the picker up top, a collapsed "New roll"
  form, and per-roll Edit / Archive.

Sketch of a roll card (illustrative — `#` = a day with ≥1 rep, `.` = a gap, blank = future):

```
LeetCode daily      Learning · ~30m                                  [Edit] [Archive]
        M T W T F S S
Aug 24  # # . # # . #
Aug 31  # . # # . . #
Sep 7   . # # # . # #
Sep 14  # # . # # # .
now     # # #
27 reps · last today
```

### Rolls vs Habits (they coexist — a deliberate call)

Aperture already has **Habits** (a binary behavior you tap, a weekly cadence target, its own dot grid).
Rolls are mechanically different and neither subsumes the other: a habit's completion is a *stored check*
(a counter — the thing Rolls avoid), it has no estimate and no task; a roll's completion is a *timed
task* that accrues calibration and flows into the daytime lane. Habits fit non-work presence ("call home
1×/week"); Rolls fit timed work you want to keep at. They read as one system because the contact sheet
reuses the Habits grid grammar (`recentWeeks`/`weekDates`), but the sheet is **read-only, ring-less, and
count-less-by-color** — that restraint is the visible difference. Revisit if real use shows the two
collapse into one (see §6).

## 3. Decision log

- **D1 — A rep is a done task tagged with the roll; momentum is DERIVED, never a stored counter.** A
  counter is a second source of truth = the streak object we're avoiding, and it drifts. Rejected: a
  "log a rep" quick path with no task (would reintroduce the counter). Confirmed with Rahul (B4 =
  derive-only).
- **D2 — Forgiving contact sheet, all-time count, no ring / red / streak / score / %.** The sheet only
  fills; a gap is a fainter dot (`bg-line`), never the Habits grid's hollow "please check" square and
  never red. The count is **all-time** — it can't decrease as days scroll past the window (a windowed
  count would be a decaying score). This is the whole no-scold payoff.
- **D3 — Rolls and Habits stay distinct** (see §2). Rejected: merging now — it would relitigate D1 and
  PRODUCT §4b inside the new-entity PR. Confirmed with Rahul (keep both, reassess after use).
- **D4 — A Roll is NOT a `TaskSeries`.** A series auto-materializes an occurrence every due day; a roll is
  open-ended and the *act of picking* is the value. Auto-materializing would make LeetCode appear on the
  plan every day unbidden — "another checkbox in the pile," the exact failure the epic names. A rep task
  has `seriesId: null`, `rollId: <roll>`.
- **D5 — `Task.rollId` is required-nullable, not optional.** Every Task field is required-nullable; an
  optional field is the one place a creation site can silently forget the tag. Pre-existing DDB rows read
  back `undefined`, so every reader compares `=== id` / `!rollId`, never `=== null` (same rule `dueDay`
  uses). The fan-out was ~15 Task literals, one atomic commit.
- **D6 — A dedicated `pickRollToday(rollId, day)` RPC, not client-composed create+plan.** One atomic call
  (a mid-sequence failure can't orphan an untagged task), one shared function stub and Lambda share, and
  it's contract-testable. It reuses the open rep if one exists (so yesterday's unfinished LeetCode
  re-plans onto today, never duplicates) and appends to the plan like `addToDay`. `day` is client-supplied
  (the server is UTC). Named `pick`, not `start` (which collides with `startSession`/`in_progress`).
  Re-planning a still-open rep onto a later day *adds* a plan row for that day; it does **not** move the
  prior day's row (past-day plan rows are inert in the no-auto-roll model, so a lingering one is harmless).
- **D7 — Two reps a day are allowed.** Once a rep is done, picking again spawns a fresh task; the cell
  counts 2. Two problems in a day is honest, not a bug. Confirmed with Rahul.
- **D8 — Rolls carry an estimate; the rep inherits it.** Calibration accrues on ongoing effort too. The
  type is nullable (series parity) but the form requires it; a null estimate falls back to
  `ROLL_PLAN_FALLBACK_MIN` (30) for the plan row — a named constant, not a magic number.
- **D9 — The contact sheet is derived client-side; no read RPC.** `useAllTasks()` already loads every live
  task for the home; `repDays()` is a pure fold over it. A server method would re-run the same fold over
  the same scan. The derivation gets a unit test instead of a contract test.
- **D10 — The picker lives in the morning "Plan today" card, not a sixth card.** Morning is already at the
  ≤5-card cap (PRODUCT §3), and picking a roll *is* a plan pull. Daytime needs nothing new — the rep is an
  ordinary plan row, so `RightNowCard` shows it and its Done → the rep. Night: nothing (derive-only).
- **D11 — Archive = `active: false` (habits parity); no `color` field.** Archived rolls leave the picker
  but keep their rep history. No color — the palette has one accent and `CategoryTag` already gives
  identity.

## 4. Where it lives

- Contract: `packages/shared/src/rolls.ts` (`rollRepFields`, `repDays`, `findOpenRollTask`,
  `ROLL_PLAN_FALLBACK_MIN` — the one place the rep rule lives), `types.ts` (`Roll`, `Task.rollId`),
  `api.ts` (`UpsertRollInput`, the 3 methods, `ExportBundle.rolls`), `rpc.ts`, `contractTests.ts`.
- Stub: `app/src/data/stubClient.ts` (+ `seed.ts` — three rolls, a backdated rep history, LeetCode
  pre-picked for today).
- Backend: `lambdas/src/backend.ts`, `lambdas/src/ddb/{keys,repo}.ts` (`roll#<id>`, id-keyed like habits;
  no new GSI — reps ride the `task#` scan).
- App: `app/src/data/hooks/useRolls.ts`, `app/src/modules/rolls/{rollSheet.ts,ContactSheet.tsx,RollPicker.tsx,RollTag.tsx}`,
  `app/src/pages/Rolls/index.tsx`, `routes.tsx`, `AppNav.tsx`, the picker in `pages/Home/index.tsx`, the
  marker in `modules/tasks/TaskCard.tsx`.

## 5. Build record

Built page-first behind the stub, then the Lambda behind the same contract. Commits (small, lowercase):
`added roll entity and rep logic` · `wired rolls through the api` · `built rolls page and contact sheet` ·
`wired roll picker into morning plan` · `documented rolls design`.

- Phase 0 — shared contract + `rollId` fan-out (green alone). ✅
- Phase 1–2 — RPC surface + stub + backend + seed + contract tests (atomic; the interface can't be green
  without both impls). ✅
- Phase 3 — hooks, `rollSheet` math + unit tests, `ContactSheet` / `RollPicker` / `RollTag`, `/rolls`
  page + route + nav. ✅
- Phase 4 — picker into the morning plan card + the tasks-page marker. ✅
- Phase 5 — tests: `rolls.test.ts` (rep rule), `rollSheet.test.ts` (grid/all-time count), contract cases
  (pick/dedup/re-plan/after-done/archive/category-reassign), `Rolls.test.tsx` + `RollPick.test.tsx`
  (create, pick→plan, archive, and the morning→daytime→done→sheet loop). ✅
- Headless UI + workflow pass (opus), code-review (opus): see the Status block.
- **Dev validation:** passed 2026-09-21 (real Lambda + DynamoDB; see the Status block for coverage).

## 6. Deferred / follow-ups

- **Revisit Rolls vs Habits after real use** (D3). If every habit you actually keep turns out to be timed
  work, narrow or retire Habits and let the two grids become one.
- **Picker: "picked today" vs "already repped today" read alike** (recorded nit from the opus headless
  pass). Both render teal + check; only the aria-label differs. Left as-is on purpose — a second rep in a
  day is allowed, so a "done" chip must stay tappable and shouldn't look finished. Revisit if it confuses
  in real use.
- **Fixed via the headless pass:** the roll rep now carries the `roll` marker in the daytime Right-now
  lane too (not just `/tasks`) — the surface where you actually act on it during the day.
- Not-Rolls observations from the headless pass (pre-existing, out of scope here): the global CaptureBar
  overlays bottom content, and `/tasks` metadata is cramped at 390px.
- **`roll:` bulk-add token** — `CreateTaskInput` deliberately did NOT gain `rollId` this PR (keeps capture
  untouched); a bulk token could tag reps in a paste later.
- **`listTasks` scale** — reps ride the full live-task scan, same posture as calibration; covered by the
  existing `TODO(scale)` ledger, not addressed here.
