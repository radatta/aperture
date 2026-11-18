# Recurring tasks — cadences, ends, and the respawn fix

**Area:** tasks · **Branch:** `school-cadences` · prod tasks `01M4FJH9JZDK98QD1W607EEMRR` (cadences),
`01M387QB2BW4TZZBGXDYM45AWC` (respawn); `series-due-time` · `01M6YNPT024NPTS0YT117JMX9W` (due time, D8).

**Status: built 2026-11-04; due time (D8) built 2026-11-18.** The design of record for recurring series: the
model, the decisions D1–D8, the respawn record. Where this doc and the code disagree, fix whichever is wrong and say so here. The one-line
summary and the storage shape live in [TECH.md](../../arch/TECH.md) → _taskSeries_; MCP's three tools in
[mcp/index.md](../mcp/index.md).

---

## 1. Why

School work follows cadences: a weekly report is written one day and due the next; a homework set drops every week and is due the week after; both stop at the term's end. The v1 series (`daily / weekdays /
weekly / everyN`, open-ended, occurrences spawned planned with no due date) could say _when to work it_ but
not _when it's due_ or _when it ends_ — so a school series either lied about its deadline or was retyped
every week. And unplanning an occurrence respawned it (§4), which made a recurring task impossible to defer.

## 2. Model

A series is still a template; each occurrence is still a real task with `seriesId`, its own estimate and
actual, its own calibration point. Four fields are new (`packages/shared/src/types.ts`):

- `TaskSeries.dueOffsetDays: number | null` — the cadence. An occurrence spawns **planned on its day** with
  `dueDay = day + offset` (0 = the same day, 1 = the next day …), untimed unless the series has a time.
  `null` = no due date.
- `TaskSeries.dueTime: string | null` — the deadline's clock (`HH:MM`), only with an offset (D8). Each
  occurrence carries it as its `dueTime`.
- `TaskSeries.until: string | null` — the last day it spawns (inclusive). `null` = open-ended.
- `Task.seriesDay?: string | null` — the day the series spawned this occurrence for: its identity within the series.

Rows from before read back `undefined` for all four → readers use `?? null` / `== null`. No migration.

Materialization is still **lazy**: an occurrence exists once `getDay(today)` runs — the app's first load of the
day, not a clock. A consequence timed reminders accept and document: a day whose first app open comes after
the morning ping has no "planned today" reminder for that occurrence ([reminders.md](reminders.md) §2).

The shared helpers (`packages/shared/src/recurrence.ts`) are the one rule both impls run, so the stub and the
Lambda spawn identical occurrences: `seriesDueOn` (the rule within `[anchorDate, until]`),
`occurrenceDueDay`, `seriesHasOccurrence` (D4), `occurrenceFields` (the spawned task's literal),
`occurrencePlanned` (whether it gets a plan row, D8) and `seriesCadence` (the upsert's validation — a bad
offset, `until` or time throws before any write).

## 3. Decision log

- **D1. Cadence = a day offset, no series due _time_** (2026-11-04; **revisited by D8**, 2026-11-18). A
  timed task is never planned ([lenses.md](lenses.md) D13), so a timed series would land its occurrences in
  Backlog, not on Tuesday's plan — the opposite of what a cadence is for; and the course site treats 11:59pm
  as all-day anyway. D8 adds the time without that cost: D13 gained an exception instead.
- **D2. `until` ends spawning, not the row.** Past `until` the series stays `active` and its row reads
  "ended Nov 30" with Stop still offered — the user sees it ran out and retires it when ready, rather than a
  row vanishing on a date. Nothing spawns after `until`, whatever the rule says.
- **D3. Course = category.** Courses are categories already (`01M2XZFVQJ8YNE333DJQAN4PDN`); a series'
  `categoryId` is its course. Nothing to add.
- **D4. Respawn identity is `(seriesId, seriesDay)`, not a plan row.** See §4. A legacy occurrence
  (no `seriesDay`) is known by its alive plan row on the day — the old rule, kept only so the first `getDay`
  after the change doesn't double today's occurrence; it can go any day after the deploy. One legacy
  occurrence the user had already unplanned before the deploy (no row for the fallback to see) gets one
  last respawn — the old behaviour, once; the copy it spawns carries `seriesDay`, so it ends there.
  A consequence, intended (review round 1): an occurrence **moved** onto another day the series is due no
  longer stands in for that day's occurrence — both show, each with its own due date. For a dated series
  that's the truth (report 3 moved to next Tuesday doesn't excuse report 4's); for an undated daily it
  reads as a visible second row the user can drop, where the old rule silently skipped the day's spawn.
  Undo: also count an alive plan row on `day` for the series, any `seriesDay`, in `seriesHasOccurrence`.
- **D5. MCP: `list_series`, `create_series`, `stop_series`** (`lambdas/src/mcp/seriesTools.ts`). Voice:
  "weekly report every Tuesday, due Wednesday, until Nov 30" → `create_series {title, rule, dueOffsetDays: 1,
until}`. The anchor is the user's today (`USER_TIME_ZONE`, the day boundary from settings). An `until`
  before today, a negative offset or a malformed rule is a param error (`-32602`) raised before any
  dispatch — nothing is written. `list_series` is the active ones unless `includeStopped`. No delete tool:
  `stop_series` deactivates; occurrences stay.
- **D6. Form: a "Due" select and an optional "Until" date.** Due = No due date · Same day · Next day ·
  In 2–6 days (what a school cadence needs; a longer offset is MCP's). Until is a native
  `<input type="date">`, as [due-dates.md](due-dates.md) §6 — roll-our-own, no picker dependency. The row
  reads `seriesSummary`: "Mon, Wed · due next day · until Nov 30" / "· ended Nov 30" (a year other than
  today's is spelled out). A refused save shows inline and keeps the draft (never a silent failure). The
  Due/Until values persist across Cancel like the rule does — a term's courses share an end.
- **D8. A series due time: a deadline, not a day** (2026-11-18, the maintainer's option (a); task
  `01M6YNPT024NPTS0YT117JMX9W`). "Pre-lab every Tuesday, due Wednesday 2pm" = weekly Tue, offset 1,
  `dueTime` 14:00. The rule by offset:
  - **Offset ≥ 1:** the occurrence spawns planned on its day with a row, as before; its time is only its
    deadline — "due tomorrow 2pm" on the card, urgency colour, the deadline ping, the calendar block. This
    is D13's one exception, a **deadline occurrence** (`isDeadlineOccurrence`: `seriesId`, `seriesDay`,
    timed, `dueDay > seriesDay`); every D13 site reads `timeDecidesDay` / `byTimeOn` instead of `isTimed`
    (the sites, its due day and the other cases: [lenses.md](lenses.md) D13 → _The exception_).
  - **Offset 0:** a plain timed task (D13): spawned `backlog` with no row, on Today by its time
    (`occurrencePlanned`). Its work day is its due day, so there is nothing to reconcile. A time before the
    day start is refused (`SERIES_TIME_SMALL_HOURS_ERROR`, form inline and MCP `-32602`): with a 4am start a
    same-day 02:00 deadline would spawn already past. Offset 1 at 02:00 is fine ("due tonight 2am").
  - **Validation** (`seriesCadence`, both impls, before any write): a time must be `HH:MM`
    (`SERIES_TIME_ERROR`) and needs an offset (`SERIES_TIME_NEEDS_DUE_ERROR`). The Lambda reads settings
    for the day start only when a time is asked for.
  - **Calendar** (the maintainer, 2026-11-18): each timed occurrence gets its Google Calendar event like
    any timed task — the prep block ending at the deadline — made by `getDay` as it spawns
    (`syncCalendar(null, task)`; the Lambda's `syncCreated`, shared with `createTasks`, so several on one
    `getDay` stay inside the bulk budget: a failure stops the rest, marked for Retry). The task read before
    a spawn is consistent, since a duplicate spawn would now also duplicate an event. Residual race: two
    `getDay`s at the same instant on two devices can still both spawn (a deterministic occurrence id with
    put-if-absent closes it — a follow-up). A `getDay` for a past day can make a past-dated event, as a
    timed create with a past time does. Cleanup: deleting an occurrence deletes its event first.
  - The small-hours refusal is judged at write time only: a later day-start change (4 → 6 with a same-day
    05:00 series), or an offset-0 series created after its time today, spawns that occurrence already past
    due, with a past-dated event. Accepted: rare, visible as overdue, and the user's own setting.
  - Failure path: the Lambda syncs whatever spawned even when a later spawn write throws (`finally`), so
    an occurrence never sits timed with no event and no Retry note. The steady-state task read is
    eventual; only a spawn about to happen re-reads consistently.
  - Replace-all `upsertSeries`: an edit that omits `dueTime` clears it (like the offset, §7).
- **D7. `deleteSeries(id)` in the contract — API only.** A tombstone of the template (occurrences stay);
  no UI or MCP surface. It exists for the dev check's cleanup by recorded id (§6): `stop_series` would
  leave one inactive row per run in the test user's partition forever.

## 4. The respawn bug (record)

**Before:** `materializeDueSeries(day)` decided "already spawned" by scanning the day's **plan rows** for a
task with that `seriesId`. Unplanning the occurrence tombstoned its plan row, so the next `getDay(today)` —
every app load — saw no row and spawned a second occurrence, planned; the first sat in Backlog (the sweep
had moved it). Each unplan minted another copy. Deleting an occurrence respawned it the same way (the UI
hides Delete and MCP refuses it for that reason — both still true: a tombstoned task is not alive).

**After:** `seriesHasOccurrence` asks the **tasks**: is there an alive task with this `seriesId` whose
`seriesDay` is `day`, whatever its status or rows. Unplanned → status backlog (listed under Week while its
due day is within the week, [lenses.md](lenses.md) §1), no copy; "+ Today" plans the same task again;
reload after reload, one occurrence. Proven in the contract suite (both impls), on the Lambda's
own path (`backend.test.ts` → _backend recurrence_), and on dev (§6 `unplan`, `replan`, `reload-one`).

What didn't change: the stale sweep ([TECH.md](../../arch/TECH.md) → _Stale sweep_) still sends an
unplanned occurrence to backlog, and still drops a missed daily that today's copy supersedes. What did,
beyond the fix: a moved occurrence no longer suppresses the spawn on the day it lands (D4 — the contract
case "an occurrence moved onto another due day is its own deliverable").

`deleteSeries` is a tombstone: the row stays in the table with `deletedAt`, reads as gone to `listSeries`
and `getSeries`, and a stop or edit after it is Not found on both impls (`backend.test.ts` → _backend
recurrence_, the contract case).

## 5. Surfaces

- **Recurring tab** (`/tasks?lens=recurring`, `RecurringSection.tsx`): the form (D6) and the rows. A
  **Due time** field (native `<input type="time">`, 16px) shows once Due isn't "No due date"; picking "No
  due date" clears it; Cancel keeps it with the offset. The row reads "Tue · due next day 2pm · until Dec 5".
- **Today / Week / Backlog:** an occurrence is an ordinary task card — "due tomorrow" from its `dueDay`,
  "due tomorrow 2pm" with a time.
- **Task editor:** "Recurs · <rule>" is unchanged (the cadence shows on the Recurring tab's row).
- **MCP:** D5. `list_tasks` shows occurrences (with `seriesId`, `seriesDay`, `dueDay`); `list_series` the
  templates.
- **Stub seed:** one "Weekly report" series (weekly on today's weekday, due next day 2pm, until +42 days),
  so the tab and Today show a timed cadence on first load.

## 6. Dev check

`scripts/src/devcheck/scenarios/recurring.ts` — the matrix: the form's create and its row; Today "due
tomorrow"; a reload keeps one; Unplan → backlog status (on Week, it's due tomorrow): after two reloads the
searched list has one row offering "+ Today" and no Unplan — no planned copy; "+ Today" brings the same one back; an Until of yesterday reads "ended" and spawns nothing; a series with no Due spawns undated; the
neighbour is untouched; `create_series` → `list_series` → Today; `create_series` with a past `until`
refused with nothing written; `stop_series` (inactive, out of the list, occurrence kept); `stop_series` on
no such id → Not found. The due time (D8): the form's time field (revealed by Due, cleared by "No due
date", Cancel writes nothing), its row, Today "due tomorrow 2pm" with Unplan, the server fields and no
calendar state without Google, Unplan → "+ Today" back, a same-day 23:59 series By time with neither Unplan
nor "+ Today", `upsertSeries` and `create_series` refusals, `create_series` with a time. Off dev: `getDay` twice after `removePlan` and `deleteSeries`'s tombstone (the
Lambda's own tests, `backend.test.ts`) and another user's id (two users on one table, `seriesTools.test.ts`);
for D8, the due day (the contract), the superseded guard (`machines.test.ts`) and the planned ping
(`dispatch.test.ts`). The Google event is _needs you_ — the test user has no Google account — and proven by
`backend.calendar.test.ts` → _series occurrences_.

Cleanup by recorded id, as every scenario: a series is ledgered from its create response (the browser's
`upsertSeries`, `recorder.ts`; the API's; MCP's `create_series`) with the `series` ledger kind, and
`deleteSeries` (`scripts/src/devcheck/api/tasks.ts`) deletes the occurrences the server spawned for it — `getDay` made them, so no create
response ever named them; the series id is their record — then tombstones the series (D7). A `create_series`
the server refuses as a param error resolves its `intent` with a `refused` line (nothing was written).

## 7. Deferred

- A deterministic occurrence id (put-if-absent) to close D8's residual double-spawn race.
- Editing a series' cadence from its row (the API takes `id` + the fields; MCP has no `update_series`).
  Note for whoever builds it: `upsertSeries` is replace-all — an edit sends every field, since an omitted
  `dueOffsetDays` or `until` resets to `null` (like `active ?? true`).
- Course-site import (`01M472W1SC8MRN4E90TQAXTG7C`): an imported assignment and a cadence occurrence would be
  duplicates — cadences are for what the course site doesn't list.
- PR-D3's exam-prep template (`01M2XZFVQJ8YNE333DJQAN4PDM`) can now use `until`.
