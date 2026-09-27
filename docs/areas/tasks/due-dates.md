# Task Due Dates

**Area:** tasks · **Branch:** `task-due-dates`

**Status: built 2026-09-15** (branch `task-due-dates`, rebased onto `main` after story-bank #12). Validated
on dev — set / clear / relative display / soonest-due sort verified against real Cognito → Lambda →
DynamoDB, including the in-progress overflow surface and split-carries-the-deadline. Merged as #13
(PR-C rebased onto it). Gate green (counts in §7 Phase 8) · headless UI pass · code-review (0 Sev-1/2).

A day-granular **due date** on a task — *when it's due*, distinct from *when I'll work it*. The task
model had scheduling (`taskPlans.day`) and estimates, but no deadline concept. This adds one, as free
metadata, without turning the app into a nag.

Permanent design-of-record: §3 is the decision log, §7 the build record. Where this doc and the code
disagree, fix whichever is wrong and say so here.

---

## 1. Why

Two of the three life-buckets Aperture now serves run on deadlines: a pset is *due Friday*, an OA
*closes Sunday*. The model could say "I plan to work this Wednesday" but not "this is due Friday" — so
a task you'd scheduled for Wednesday carried no signal that missing Wednesday meant missing the actual
deadline. Due dates close that gap.

The hard part isn't the field. It's adding a deadline **without** importing the guilt machinery every
other todo app reaches for — countdowns, red overdue badges, an "N overdue" tally. Aperture's posture
is no-scold (see `product/PRODUCT.md`): a rollover is an honest signal, never a reprimand. A lapsed due
date reads exactly like a rollover — flat, quiet, un-emphasised.

## 2. Two dates, kept separate

```
                task  "finish pset 3"
                          │
           ┌──────────────┴───────────────┐
           ▼                              ▼
┌─────────────────────┐        ┌─────────────────────┐
│    taskPlans.day    │        │        dueDay       │
│  when I'll work it  │        │    when it's due    │
├─────────────────────┤        ├─────────────────────┤
│  scheduling · order │        │    free metadata    │
│  can span many days │        │  one day · no lock  │
└─────────────────────┘        └─────────────────────┘
```

They are deliberately different fields. You can schedule a task onto Wednesday (`taskPlans.day`) while
it's due Friday (`dueDay`); you can have a due date and no plan yet, or a plan and no due date. Clock
precision (a 3pm OA) is **not** this field's job — that lives in Google Calendar (see the calendar
area). Due dates stay day-granular, matching `taskPlans.day`'s `YYYY-MM-DD` shape.

## 3. Decision log

Every product decision we actually made on this feature, the reasoning, and the alternative we turned
down. Locked unless explicitly revisited here (with a date).

**D1 — Day-granular, not a datetime.**
A deadline is a day (`YYYY-MM-DD`, same shape as `taskPlans.day`), never a clock time.
*Why:* a pset is "due Friday", not "due 3:14pm Friday" — clock precision would be fabricated.
*Rejected:* a `dueTime` / full datetime. Clock-time events are Google Calendar's job; keeping this
day-granular is what keeps the two concepts (and the two areas) cleanly separated.

**D2 — Enrichment-only, never on the capture bar.**
You add a due date in the scope/plan pass, not when you capture the task.
*Why:* capture stays title-only — the whole product rests on capture cost staying below memory cost.
Every field we let creep onto the capture bar taxes the one interaction we most need to stay frictionless.
*Rejected:* a due-date field at capture. It would be convenient occasionally and corrosive always.

**D3 — Free metadata, outside the estimate lock.**
`dueDay` is editable at **any** status and never touches `estimateLockedMin`.
*Why:* `estimateLockedMin` is the calibration anchor — it freezes on first exit from planning precisely
so the predict-vs-actual gap stays honest. A deadline moving is not a scope change; conflating the two
would corrupt calibration data every time a professor pushed a due date.
*Rejected:* treating a due-date edit like an estimate edit (locked after planning).

**D4 — A dedicated in-progress surface, because "editable at any status" has nowhere to live otherwise.**
In-progress tasks get a small "Due day…" panel via the card's overflow menu; backlog/planned use
`ScopePanel`; done/cancelled are display-only.
*Why:* the discovery that forced this — `ScopePanel` is gated to backlog/planned **and** calls
`setTaskEstimate` unconditionally, which throws once the estimate is frozen. So the existing enrichment
surface physically cannot edit an in-progress task. D3 says the deadline is editable then; D4 is what
makes that real in the UI.
*Rejected:* (a) API-only editing for in-progress tasks — a real capability with no button is a lie in
the design; (b) ungating `ScopePanel` — it would try to re-lock the estimate and throw.
*Since superseded:* the task editor modal ([task-editor.md](task-editor.md)) deleted `ScopePanel` and the
overflow menu; category is edited there at any status, due until the task is done or cancelled (`isTerminal`, see task-editor.md). D3 still holds; D4 is the decision as made
at the time.

**D5 — Flat, subtle display; no aggregate, ever.**
Relative phrasing at the `ink-subtle` tone. **No** countdown, **no** `danger`/red, **no**
bold-for-urgency, **no** "N overdue" count anywhere in the app.
*Why:* this is the whole reason the feature is hard. The overdue tally and the red badge are the exact
guilt machinery the no-scold posture forbids (`product/PRODUCT.md`). A lapsed due date must read like a
rollover — honest, quiet — not like a reprimand.
*Rejected:* the entire default vocabulary of todo apps (countdowns, colour-coded urgency, an overdue
counter). Deliberately, not by omission.

**D6 — "Today" is the 4am logical day, not local midnight.**
The relative formatter compares against `todayKey(dayStartHour)` (4am rollover).
*Why:* the app already defines a day as starting at 4am so late-night work lands on the right day.
A due-date label computed against naive midnight would flip "due today" to "was due" at midnight while
you're still working the same logical day — a scold caused by a clock bug. See the boundary test in §7.
*Rejected:* naive local-midnight "today".

**D7 — The due label persists on done/cancelled tasks** (`was due Tue`).
*Why:* an honest historical record of what the deadline was; the flat tone (D5) means past-tense doesn't
read as a scold. *Rejected:* hiding the label once terminal — it would erase useful history for no gain,
now that D5 removes the reason to hide it.

**D8 — The relative phrase set covers the whole range, not just weekdays.**
`due today` / `due tomorrow` / weekday for ±2–6 / `due Sep 22` (month+day) beyond a week; same in the
past tense. (Full table in §6.)
*Why:* weekday names alone are ambiguous past 6 days ("due Fri" could be this week or next) and read
oddly at ±1 ("due Tue" tomorrow). *Rejected:* weekday-only phrasing (the spec's first sketch) — it has a
real gap at ≥7 days and an awkwardness at ±1.

**D9 — The due-date sort is a hint, never an override.**
Manual `taskPlans.order` wins wherever set. Due date only orders the **unplanned backlog pull**
(soonest-due first, undated last), in memory over already-loaded tasks.
*Why:* the user's explicit ordering is intent and must not be second-guessed by a heuristic. This is
also structurally safe, not just a convention: backlog tasks have no `order` rows and planned rows are
already order-sorted, so there is no task where a manual order and the due-hint actually compete.
*Rejected:* due date as the primary sort key across all task lists (briefly considered, reversed — it
would silently reorder lists the user had hand-ordered).

**D10 — No GSI; in-memory sort.**
*Why:* single user, small N. A `dueDay`-keyed query earns nothing here and adds a schema surface.
*Deferred (not rejected):* a `dueDay` GSI + a "this week's dues" view move to the calibration area,
where cross-task deadline queries actually pay off.

## 4. Data model

One nullable field on the existing task item — no new key, no GSI:

```ts
Task { …existing… , dueDay: string | null }   // "YYYY-MM-DD", same shape as taskPlans.day
```

- `createTask` defaults `dueDay: null` (mirrors `estimateMin`/`categoryId` defaulting).
- Persists for free: `taskItem` mapping is `{ PK, SK, ...task }` (a spread), and the read path
  `toEntity` strips key attributes rather than whitelisting — so no mapping change either direction.
- **Existing rows predate the field** → they read back `undefined`, not `null`. No migration; every
  consumer treats falsy `dueDay` as "undated" (truthiness checks, `?? ''` for inputs, undated-last in
  the sort). The `null` contract holds only for newly-created tasks.

## 5. RPC

`setTaskDueDay(id, dueDay: string | null)` — a dedicated method mirroring `setTaskCategory` (the BFF is
RPC, not REST):

```ts
async setTaskDueDay(id: string, dueDay: string | null): Promise<Task> {
  const t = await this.mustTask(id);
  return this.repo.putTask({ ...t, dueDay, updatedAt: this.now() });
}
```

Registered in `API_METHODS` (`packages/shared/src/rpc.ts`) immediately after `setTaskCategory`.
Callable at any status; never touches `estimateLockedMin`. Setting `null` clears it.

## 6. UX surfaces & display

- **Set it** — now in the task editor modal, until the task is done or cancelled ([task-editor.md](task-editor.md)); originally
  `ScopePanel` (backlog/planned) plus an in-progress overflow "Due day…" → `DueDayForm` (D4). Either way
  a native `<input type="date">` — roll-our-own, no date-picker dependency.
- **Display** as relative phrasing at `ink-subtle`, computed by `fmtDueDay(dueDay, today)`:

  | days from today | phrase |
  | --- | --- |
  | 0 | `due today` |
  | +1 | `due tomorrow` |
  | +2 … +6 | `due Fri` (weekday) |
  | ≥ +7 | `due Sep 22` (month + day) |
  | −1 | `was due yesterday` |
  | −2 … −6 | `was due Tue` (weekday) |
  | ≤ −7 | `was due Jun 8` (month + day) |

  (Why this shape: D8.)
- **Shown in two places:** `TaskCard`'s meta line, and the Home "+ Add" dialog's rows. Same subtle
  tone in both. (`/tasks` lists are all `TaskCard` now — [lenses.md](lenses.md).)
- **Dark theme:** a native date input's picker glyphs often need `color-scheme` set; if it looks wrong,
  fix with CSS, don't pull a picker dependency.

## 7. Build record (implementation plan)

Ordered, page-first. Each phase names the files it touches. Checked once built; `↳` notes record where
the build diverged from the plan or hit something worth remembering. Built 2026-09-15. ~20 files — the
count is driven by `dueDay` being a **required** field on `Task`, which breaks typecheck at every
full-`Task` literal (the `Plan` pass's original "~5–7" missed that fan-out and the second display surface).

- [x] **Phase 0 — shared contract + compile fixes** (one atomic set so `tsc` goes green)
  - `packages/shared/src/types.ts` — `dueDay: string | null` on `Task`.
  - `packages/shared/src/api.ts` — `setTaskDueDay` on `ApiClient`, after `setTaskCategory`.
  - `packages/shared/src/rpc.ts` — `'setTaskDueDay'` inserted **after `'setTaskCategory'`, mid-list**.
    - ↳ *Mid-list insert, not append — deliberate merge hygiene. It paid off: story-bank appended its four story methods at the end, so on the rebase `API_METHODS` merged with zero conflict.*
  - `packages/shared/src/machines.ts` — `splitFollowUp` carries `dueDay: original.dueDay`.
  - `packages/shared/src/contractTests.ts` — a `tasks: due day …` case, inserted after the split test.
  - Compile-fix fixtures: `machines.test.ts`, `lambdas/src/ddb/repo.test.ts`, `app/…/taskMath.test.ts`.
    - ↳ *No change to `lambdas/src/ddb/mapping.ts` — `taskItem` spreads `...task` and `toEntity` strips keys rather than whitelisting, so `dueDay` round-trips for free both ways. The spec had hedged this; confirmed unnecessary.*

- [x] **Phase 1 — backend + stub** (both `ApiClient` impls)
  - `lambdas/src/backend.ts` — `setTaskDueDay` after `setTaskCategory`; `dueDay: null` in the `createTask` + `materializeDueSeries` literals.
  - `app/src/data/stubClient.ts` — `setTaskDueDay` (`writes.patch`) + `dueDay: null` in both literals.

- [x] **Phase 2 — the formatter** (shared, node-testable)
  - `packages/shared/src/dates.ts` — `fmtWeekdayShort` + `fmtDueDay(dueDay, today)` (§6 table), beside `fmtWeekday`.
    - ↳ *The spec said to compute "today" via a `dayBoundary` helper — no such helper exists. Correct shape (matching `modules/log/dayLabel.ts`): the formatter is **pure over `(dueDay, today)`**, and the caller passes `today = todayKey(dayStartHour)`, so the 4am rollover lives in `todayKey` alone.*
  - `packages/shared/src/dates.test.ts` — the phrase table + the `dayStartHour` boundary, tested by composing `fmtDueDay` with `todayKey(4, at(…))`: 2:30am pre-rollover reads `due today`; 4am exactly reads `was due yesterday`.

- [x] **Phase 3 — page-first seed**
  - `app/src/data/seed.ts` — `dueDay: null` on the existing literals; a few backlog seeds given real due days (one overdue, one soon, one far out, two undated) so the sort and every phrase branch show on first load.
    - ↳ *`tsc` caught a missed literal here (the done-task seed) on the first typecheck — the required-field fan-out again.*

- [x] **Phase 4 — app: hook, sort, UI**
  - `app/src/data/hooks/useTasks.ts` — `useSetDueDay()` (mirrors `useSetCategory`).
  - `app/src/modules/tasks/taskMath.ts` — `byDueHint(tasks)`: copy-then-stable-sort, dated ascending, undated last, input never mutated. + tests in `taskMath.test.ts`.
    - ↳ *Falsy `dueDay` folds to undated — that includes the `undefined` pre-existing rows read back as, so old tasks sort last and never crash. Verified in dev against real rows that predate the field.*
  - `app/src/modules/tasks/ScopePanel.tsx` — a `Due` date `Field`; writes only when changed.
  - `app/src/modules/tasks/TaskCard.tsx` — subtle `fmtDueDay` in `TaskMeta` (shown at every status, incl. done/cancelled); a `'due'` panel + an in-progress overflow **"Due day…"**.
    - ↳ *The second surface is forced, not cosmetic — D4 has the why.*
  - `app/src/modules/tasks/PlanSection.tsx` — `byDueHint(backlog)` on the pull + the subtle phrase on its inline row. *(Since removed by the task lenses: Week/Backlog sort with `byDueHint` via `query.ts`.)*
    - ↳ *The pull renders its own inline card, not `TaskCard`, so the due display is added in two places (D5).*

- [x] **Phase 5 — headless UI pass** (`run-app`, both themes)
  - Drove `/tasks` — Plan pull (sorted, subtle phrases), Backlog `TaskCard` meta, a Scope panel's date field, an in-progress card's overflow "Due day…". Light + dark.
    - ↳ *No UI fixes needed. Dark's native date-picker glyphs are legible — the `[color-scheme:…]` handling (later hoisted into `Field`, Phase 6) worked. Bonus: the run confirmed `splitFollowUp` carries the deadline end-to-end — a split follow-up came out "…(cont.)" still reading "due Thu".*
    - ↳ *Same sandbox fight as story-bank: the `apt` `chromium` is a snap wrapper that hangs, so it pivoted to Playwright's own headless-shell build (into an isolated `PLAYWRIGHT_BROWSERS_PATH` to dodge a cache lock the parallel session held). Dark driven via `emulateMedia` + `data-theme`.*

- [x] **Phase 6 — code-review**
  - `code-reviewer`: 0 Sev-1/2. Two nits applied:
    - ↳ *Save button now disabled on `setEstimate || setCategory || setDueDay` pending (was estimate-only — this change had widened the double-submit window by one await).*
    - ↳ *`[color-scheme:light] dark:[color-scheme:dark]` hoisted from the two call sites into `Field` itself (auto-applied for `date`/`time`/`datetime-local`) — DRY at the component; confirmed no other date inputs exist.*

- [x] **Phase 7 — split-bug fix** (pre-existing, found while dev-testing)
  - `app/src/modules/tasks/TaskCard.tsx` `SplitForm` — gate "Done" on `canTransitionTask(task.status,'done')` (backlog/planned show a plain "will be cancelled" note); wrap the split in try/catch + an inline error line.
    - ↳ *Splitting a backlog task and choosing "Done" threw `Invalid task transition: backlog → done`, and the unhandled rejection leaked raw JSON to the page. Unrelated to due dates but fixed here; headless-verified both the backlog (no "Done") and in-progress (has "Done") paths.*

- [x] **Phase 8 — docs + reorg + gate**
  - `docs/arch/TECH.md` §2.2 (the `dueDay` bullet), `docs/index.md`, this design doc.
    - ↳ *Bundled the full docs reorg (`product/arch/areas/ops`) into this branch. On rebase onto story-bank's `main` it clashed — story-bank had already made `docs/recruiting/` — reconciled by folding that into `docs/areas/recruiting/{index.md,story-bank.md}` and repointing all seven inbound links.*
  - Gate: `pnpm typecheck` · `pnpm lint` · `pnpm test` (319: app 193 · lambdas 69 · shared 33 · cdk 18 · scripts 6) all green. Commits: `reorganized docs…` · `added task due-dates design doc` · `added day-granular task due dates` · `fixed illegal split finish…` — one lowercase line each, no trailers.

## 8. Deferred / out of scope

- `dueDay`-keyed GSI + a "this week's dues" deep view → calibration area.
- gcal "add to calendar" off a `dueDay` → calendar area (this feature lands first so that has a date).
- Clock-time / `dueTime` on the task → never; that's gcal's job.

## 9. Sibling-PR conflicts (merge coordination)

Built in parallel with story-bank (recruiting) and google-calendar (calendar), in separate sessions.
Expected conflicts, resolved by the human at merge:

- `rpc.ts` `API_METHODS` — all three PRs; the mid-list insert minimises it.
- `Task` type + its ~10 literal sites — the calendar PR adds `gcalEventId`/`gcalCalendarId` on the same
  lines; it should rebase onto this PR and add its fields beside `dueDay: null`.
- `api.ts`, `backend.ts`, `stubClient.ts`, `useTasks.ts`, `contractTests.ts` — near the same task-section
  lines; the mid-file inserts help.
