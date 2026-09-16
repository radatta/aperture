# Task Due Dates

**Area:** tasks · **Status:** design locked, build pending · **Branch:** `task-due-dates`

A day-granular **due date** on a task — *when it's due*, distinct from *when I'll work it*. The task
model had scheduling (`taskPlans.day`) and estimates, but no deadline concept. This adds one, as free
metadata, without turning the app into a nag.

This is a permanent design-of-record — the design, the decision log, **and** the build record, all
kept. §3 is the decision log: every product decision we actually made, why, and what we rejected —
that's the part that stops a future reader (or a future us) from re-litigating settled ground or
"fixing" something that was a deliberate choice. §7 is the build record: it stays after merge as the
account of how the first cut was built, not a disposable ticket. Where this doc and the code disagree,
fix whichever is wrong and say so here.

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

- **Set it** in `ScopePanel` (backlog/planned enrichment) via a native `<input type="date">` —
  roll-our-own, no date-picker dependency. For **in-progress** tasks, a "Due day…" item in the card's
  overflow menu opens a small `DueDayForm`.
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

  Weekday names alone are ambiguous past a week and read oddly at ±1, hence the tomorrow/yesterday and
  the ≥7-day month/day fallback.
- **Shown in two places** (the pull list renders its own inline row, not `TaskCard`): `TaskCard`'s meta
  line, and `PlanSection`'s backlog-pull row. Same subtle tone in both.
- **Dark theme:** a native date input's picker glyphs often need `color-scheme` set; if it looks wrong,
  fix with CSS, don't pull a picker dependency.

## 7. Build record

How the first cut was built — kept as the permanent account, not deleted after merge. Reconciled from a
`Plan` pass against the real code. ~20 files; the count is driven by `dueDay` being a **required** field
on `Task`, which breaks typecheck at every full-`Task` literal (the spec's original "~5–7" missed that
fan-out and the second display surface).

**Step 1 — contract (shared) + compile fixes, one atomic set** so typecheck goes green:
- `packages/shared/src/types.ts` — add `dueDay: string | null` to `Task`.
- `packages/shared/src/api.ts` — declare `setTaskDueDay` after `setTaskCategory`.
- `packages/shared/src/rpc.ts` — insert `'setTaskDueDay'` after `'setTaskCategory'` (mid-list, for
  merge hygiene against sibling PRs that append).
- `packages/shared/src/machines.ts` — `splitFollowUp` carries `dueDay: original.dueDay` (a split
  changes scope, not the deadline — same treatment as `categoryId`).
- `lambdas/src/backend.ts` — add the method after `setTaskCategory`; `dueDay: null` in the `createTask`
  and `materializeDueSeries` literals.
- `app/src/data/stubClient.ts` — `setTaskDueDay` stub + `dueDay: null` in both literals.
- Fixtures/literals: `machines.test.ts`, `lambdas/src/ddb/repo.test.ts`, `app/…/taskMath.test.ts`,
  `app/src/data/seed.ts` (both literals). No change to `mapping.ts`, `handler.ts`, `httpClient.ts`.

**Step 2 — formatter (shared, node-testable):**
- `packages/shared/src/dates.ts` — `fmtWeekdayShort(key)` and `fmtDueDay(dueDay, today)` (§6 table),
  next to `fmtWeekday`. Pure; `today` comes from the caller's `todayKey(dayStartHour)`. Follows the
  `modules/log/dayLabel.ts` shape (takes `today` as an argument).
- `packages/shared/src/dates.test.ts` — the §6 table plus the `dayStartHour` boundary (see below).

**Step 3 — page-first seed:** give 2–3 backlog seeds real `dueDay`s relative to now so the sort and the
phrases are visible on first load.

**Step 4 — app: hook, sort, UI:**
- `app/src/data/hooks/useTasks.ts` — `useSetDueDay()` mirroring `useSetCategory`.
- `app/src/modules/tasks/taskMath.ts` — `byDueHint(tasks)`: stable sort, dated-ascending first, undated
  keep incoming order, never mutate input.
- `app/src/modules/tasks/ScopePanel.tsx` — date `Field`; only writes when changed.
- `app/src/modules/tasks/TaskCard.tsx` — subtle `fmtDueDay` in `TaskMeta` (no status gating); a `'due'`
  panel + overflow "Due day…" for in-progress.
- `app/src/modules/tasks/PlanSection.tsx` — `byDueHint(backlog)` for the pull list + the subtle phrase
  on the inline row.

**Step 5 — contract test** in `packages/shared/src/contractTests.ts` (insert mid-file): create defaults
null; set/read-back; still settable in-progress with `estimateLockedMin` unchanged; clear to null;
survives `listTasks`. This exercise over `InMemoryDoc` + `Repo` is the round-trip check.

**Step 6 — verify / headless UI pass / review / commit:**
- `set -o pipefail; pnpm typecheck; pnpm lint; pnpm test` (echo `${PIPESTATUS[0]}` — never trust a
  piped exit code).
- **Headless UI pass via the `run-app` skill** (default stub + auth-bypass): drive the real app and
  screenshot the surfaces this touches — the Plan tab's backlog pull (sorted, subtle `due …` phrases),
  a Scope panel with the date field, a backlog `TaskCard`'s meta line, and an in-progress card's
  overflow → "Due day…". Check **both themes** (the native `<input type="date">` glyphs often need
  `color-scheme` in dark). This is where UI issues the unit tests can't see surface — **make the fixes
  the screenshots reveal** (spacing, tone, dark-theme picker, a surface that didn't wire up) before
  moving on. Serialise against `pnpm test` — screenshot, kill the browser, then test (12 GiB / 6 CPUs).
- `code-reviewer` agent; address findings; one lowercase commit.

**The `dayStartHour` boundary test** — the trap the formatter exists to avoid: at 02:30 on Sun the
wall-clock date is already the next day, but the logical day is still Saturday. A task due Saturday must
read `due today`, not `was due Sat`. Because `fmtDueDay` is pure over `(dueDay, today)`, the boundary
lives entirely in `todayKey`; compose them in a node test — e.g. `fmtDueDay('2026-06-06',
todayKey(4, at(2026,6,7,3)))` → `due today`, and at 04:00 exactly → `was due yesterday`.

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
