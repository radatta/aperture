# Task Due Dates (+ times)

**Area:** tasks · **Branch:** `task-due-dates`

**Status: built 2026-09-15** (branch `task-due-dates`, rebased onto `main` after story-bank #12). Validated
on dev — set / clear / relative display / soonest-due sort verified against real Cognito → Lambda →
DynamoDB, including the in-progress overflow surface and split-carries-the-deadline. Merged as #13
(PR-C rebased onto it). Gate green (counts in §7 Phase 8) · headless UI pass · code-review (0 Sev-1/2).

A day-granular **due date** on a task — *when it's due*, distinct from *when I'll work it*. The task
model had scheduling (`taskPlans.day`) and estimates, but no deadline concept. This adds one, as free
metadata, without turning the app into a nag.

**Due times: built 2026-10-05** (branch `task-due-times`) — an optional `dueTime` beside `dueDay`, an
urgency colour for timed tasks, and calendar auto-sync. Revisits D1 and D5; build record §10.

Permanent design-of-record: §3 is the decision log, §7 and §10 the build records. Where this doc and the code
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
it's due Friday (`dueDay`); you can have a due date and no plan yet, or a plan and no due date. `dueDay`
stays day-granular, matching `taskPlans.day`'s `YYYY-MM-DD` shape; a clock time (a 4pm submission) is a
**separate, optional** `dueTime` on that day (D1 revisited).

## 3. Decision log

Every product decision we actually made on this feature, the reasoning, and the alternative we turned
down. Locked unless explicitly revisited here (with a date).

**D1 — Day-granular, not a datetime.**
A deadline is a day (`YYYY-MM-DD`, same shape as `taskPlans.day`), never a clock time.
*Why:* a pset is "due Friday", not "due 3:14pm Friday" — clock precision would be fabricated.
*Rejected:* a `dueTime` / full datetime. Clock-time events are Google Calendar's job; keeping this
day-granular is what keeps the two concepts (and the two areas) cleanly separated.
**Revisited 2026-10-05 — an optional `dueTime` is added.** Real use said otherwise: titles like
"Prep case study (due 4pm)" and "P1 proposal (due 12pm)" were carrying the clock by hand, and timed
reminders need it. The time is a deadline (submit by), not an appointment. It is a **second field**
(`"HH:MM"`, 24h local wall clock), not a datetime: every consumer that treats `dueDay` as a day — the
Week lens cutoff (`dueDay <= today+6` as a string compare), Coming up, `fmtDueDay`, the date input,
`isDayKey` validation, presets, split — stays untouched, and sorting is one comparator. A combined
`YYYY-MM-DDTHH:MM` would have silently dropped a timed task on the week's last day out of Week, and a
rename to `due` would have needed a prod backfill. `dueDay` itself is still day-granular.

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
**Revisited 2026-10-05 — urgency colour for TIMED tasks.** With a clock time, a flat label "means
nothing" two hours out (the user's words). A timed row now colours: **gold edge ≤6h, gold fill ≤1h, red
fill once past**, and the red **stays** (across days) until the task is done, cancelled or moved —
`dueUrgency` in `packages/shared/src/due.ts`, looks in `app/src/modules/tasks/dueStyle.ts`. Untimed
deadlines keep D5 exactly (flat, `ink-subtle`); done/cancelled never colour; the label text stays quiet
("due today 4pm" until the 4am rollover, D6); still no countdown and no aggregate/overdue count anywhere.
Edge-then-fill rather than a gold→orange→red ramp: three warm tints are hard to tell apart. The two
fills are their own contrast-checked tokens — olive-amber and red-brown, darker than the ground in dark
mode — after the first pass's translucent gold and salmon read as the same grey in dark mode (headless
UI pass, 2026-10-05); a coloured row lifts its `ink-subtle` text to `ink-muted`.

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

**D11 — Sort within a day: timed by time, then untimed (2026-10-05).** `byDueHint` keys on
`(dueDay, dueTime ?? '99:99')`. D9 still holds — manual order wins wherever set.

**D10 — No GSI; in-memory sort.**
*Why:* single user, small N. A `dueDay`-keyed query earns nothing here and adds a schema surface.
*Deferred (not rejected):* a `dueDay` GSI + a "this week's dues" view move to the calibration area,
where cross-task deadline queries actually pay off.

## 4. Data model

Nullable fields on the existing task item — no new key, no GSI:

```ts
Task { …existing… , dueDay: string | null,    // "YYYY-MM-DD", same shape as taskPlans.day
                    dueTime: string | null }   // "HH:MM" 24h local, only with dueDay (2026-10-05)
```

- **Invariant (one gate, `normalizeDue` in `due.ts`):** a time needs a day; clearing the day clears the
  time; both must be well-formed (`isDayKey`, `isTimeKey`). Both creates and `setTaskDue` run it before
  any write. Old rows read `dueTime` back `undefined` → untimed (readers use `!dueTime`).

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

**2026-10-05:** `setTaskDue(id, { dueDay, dueTime? })` is the write; `setTaskDueDay` is kept as
`setTaskDue(id, { dueDay })` (cached app shells, older callers). Object-shaped on purpose: RPC args are
a JSON array, so a trailing optional `dueTime` would arrive as `null` (clear) instead of absent (keep);
in an object an omitted key stays omitted. A due write then runs calendar auto-sync
([calendar → Auto-sync](../calendar/index.md)).

## 6. UX surfaces & display

- **Set it** — now in the task editor modal, until the task is done or cancelled ([task-editor.md](task-editor.md)); originally
  `ScopePanel` (backlog/planned) plus an in-progress overflow "Due day…" → `DueDayForm` (D4). Either way
  a native `<input type="date">` — roll-our-own, no date-picker dependency.
- **Display** as relative phrasing at `ink-subtle`, computed by `fmtDueDay(dueDay, today)`:

  | days from today | phrase |
  | --- | --- |
  | 0 | `due today` |
  | +1 | `due tomorrow` |
  | +1, a clock before the day start | `due tonight 12:30am` |
  | +2 … +6 | `due Fri` (weekday) |
  | ≥ +7 | `due Sep 22` (month + day) |
  | −1 | `was due yesterday` |
  | −2 … −6 | `was due Tue` (weekday) |
  | ≤ −7 | `was due Jun 8` (month + day) |

  (Why this shape: D8.) A timed task appends the clock on every branch — `due Fri 4pm`,
  `due today 11:59pm`, `was due Tue 9:30am` (`fmtClock12`). The "tonight" row needs the day start:
  `fmtDueDay(dueDay, today, dueTime, { dayStartHour })` — its app day is today ([lenses.md](lenses.md)
  D13); without it, the deadline reads as written. The time is set in the editor's **Due time**
  field (disabled without a date), via `due:YYYY-MM-DD@HH:MM` in bulk add / capture
  ([bulk-add.md](bulk-add.md)), or `dueTime` over MCP.
- **Shown in:** `TaskCard`'s meta line, the Home "+ Add" dialog's rows, Coming up, and (timed only)
  the Right-now rows. Same subtle tone throughout; a timed row's **urgency colour** (D5 revisited) is on
  the row, re-read every minute (`useNow`), with the same signal in screen-reader text. (`/tasks` lists are all `TaskCard` now — [lenses.md](lenses.md).)
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
- ~~Clock-time / `dueTime` on the task → never~~ — built 2026-10-05 (D1 revisited).
- Timed reminders / notifications — the separate Reminders task; `dueTime` is its prerequisite.
- Due times on recurring series templates.

## 9. Sibling-PR conflicts (merge coordination)

Built in parallel with story-bank (recruiting) and google-calendar (calendar), in separate sessions.
Expected conflicts, resolved by the human at merge:

- `rpc.ts` `API_METHODS` — all three PRs; the mid-list insert minimises it.
- `Task` type + its ~10 literal sites — the calendar PR adds `gcalEventId`/`gcalCalendarId` on the same
  lines; it should rebase onto this PR and add its fields beside `dueDay: null`.
- `api.ts`, `backend.ts`, `stubClient.ts`, `useTasks.ts`, `contractTests.ts` — near the same task-section
  lines; the mid-file inserts help.

## 10. Build record — due times (2026-10-05)

Planned by the `Plan` agent (~60 files). One branch, page-first; shared → stub/app → lambdas → docs.

- **shared:** `Task.dueTime` + `gcalSyncError`, `Settings.autoCalendar`; `setTaskDue` + `syncCalendarEvent`
  (`api.ts`, `rpc.ts`); `dates.ts` — `isTimeKey`, `fmtClock12`, `hhmmOfEpoch`, `DUE_TIME_PRESETS`,
  `USER_TIME_ZONE` (moved from the MCP finance tools), `zonedEpoch`, `fmtDueDay(…, dueTime)`; new
  `due.ts` (`normalizeDue`, `eventWindow`, `dueUrgency`) and `calendarSync.ts` (the planner); the
  `@HH:MM` grammar; `splitFollowUp` carries the time. Contract cases: set/keep/clear, validation,
  bulk, split, settings default.
  - ↳ *`zonedEpoch` exists because the Lambda is UTC — `localEpochFromDayTime` there would put every
    event 7–8 hours off. Tested on both DST-change days.*
- **app:** editor **Due time** field (one `setTaskDue` write); urgency colour on `TaskCard`, Coming up and
  Right now via `dueStyle.ts` + the new `useNow` hook (one shared ticker, lifted from `HomeModeProvider`); the
  `--due-imminent-fill` / `--due-past-fill` tokens; capture time chips; sync-failure line + Retry in the editor, "calendar sync failed" on the row;
  Settings toggle; add-to-calendar prefills the block ending at the deadline; seed has three timed tasks
  (imminent, soon, past).
  - ↳ *The colour classes must beat `Card`'s own `border-line`/`bg-panel` (`cx` is a plain join, no
    merge): the edge is an important border colour, the fill an inset shadow over the background.*
- **lambdas:** `setTaskDue`, `syncCalendar` routed through every task write that can change the event;
  gateway `patchEvent` + `EventGoneError`; MCP `dueTime` on the three task tools.
- **Tests:** shared (dates/DST, due, planner, grammar, contract) · lambdas (auto-sync scenarios incl.
  failure + retry, deleted-in-Google, toggle off, bulk, split, testMode; MCP) · app (editor, capture chips,
  urgency classes, Coming up order + colour, Settings toggle, stub parity, `useNow`).

