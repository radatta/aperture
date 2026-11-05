# Recurring tasks — cadences, ends, and the respawn fix

**Area:** tasks · **Branch:** `school-cadences` · prod tasks `01M4FJH9JZDK98QD1W607EEMRR` (cadences),
`01M387QB2BW4TZZBGXDYM45AWC` (respawn).

**Status: built 2026-11-04.** The design of record for recurring series: the model, the decisions D1–D7, the
respawn record. Where this doc and the code disagree, fix whichever is wrong and say so here. The one-line
summary and the storage shape live in [TECH.md](../../arch/TECH.md) → _taskSeries_; MCP's three tools in
[mcp/index.md](../mcp/index.md).

---

## 1. Why

School work follows cadences: a pre-lab is written every Tuesday and due Wednesday; a homework set drops
every week and is due the week after; both stop at the quarter's end. The v1 series (`daily / weekdays /
weekly / everyN`, open-ended, occurrences spawned planned with no due date) could say _when to work it_ but
not _when it's due_ or _when it ends_ — so a school series either lied about its deadline or was retyped
every week. And unplanning an occurrence respawned it (§4), which made a recurring task impossible to defer.

## 2. Model

A series is still a template; each occurrence is still a real task with `seriesId`, its own estimate and
actual, its own calibration point. Three fields are new (`packages/shared/src/types.ts`):

- `TaskSeries.dueOffsetDays: number | null` — the cadence. An occurrence spawns **planned on its day** with
  `dueDay = day + offset` (0 = the same day, 1 = the next day …), **untimed**. `null` = no due date.
- `TaskSeries.until: string | null` — the last day it spawns (inclusive). `null` = open-ended.
- `Task.seriesDay?: string` — the day the series spawned this occurrence for: its identity within the series.

Rows from before read back `undefined` for all three → readers use `?? null` / `== null`. No migration.

The shared helpers (`packages/shared/src/recurrence.ts`) are the one rule both impls run, so the stub and the
Lambda spawn identical occurrences: `seriesDueOn` (the rule within `[anchorDate, until]`),
`occurrenceDueDay`, `seriesHasOccurrence` (D4), `occurrenceFields` (the spawned task's literal) and
`seriesCadence` (the upsert's validation — a bad offset or `until` throws before any write).

## 3. Decision log

- **D1. Cadence = a day offset, no series due _time_.** A timed task is never planned
  ([lenses.md](lenses.md) D13), so a timed series would land its occurrences in Backlog, not on Tuesday's
  plan — the opposite of what a cadence is for; and Canvas treats 11:59pm as all-day anyway. Later, if
  wanted: a `dueTime` on the series spawns timed occurrences unplanned.
- **D2. `until` ends spawning, not the row.** Past `until` the series stays `active` and its row reads
  "ended Dec 5" with Stop still offered — the user sees it ran out and retires it when ready, rather than a
  row vanishing on a date. Nothing spawns after `until`, whatever the rule says.
- **D3. Course = category.** Courses are categories already (`01M2XZFVQJ8YNE333DJQAN4PDN`); a series'
  `categoryId` is its course. Nothing to add.
- **D4. Respawn identity is `(seriesId, seriesDay)`, not a plan row.** See §4. A legacy occurrence
  (no `seriesDay`) is known by its alive plan row on the day — the old rule, kept only so the first `getDay`
  after the change doesn't double today's occurrence; it can go any day after the deploy.
- **D5. MCP: `list_series`, `create_series`, `stop_series`** (`lambdas/src/mcp/seriesTools.ts`). Voice:
  "pre-lab every Tuesday, due Wednesday, until Dec 5" → `create_series {title, rule, dueOffsetDays: 1,
until}`. The anchor is the user's today (`USER_TIME_ZONE`, the day boundary from settings). An `until`
  before today, a negative offset or a malformed rule is a param error (`-32602`) raised before any
  dispatch — nothing is written. `list_series` is the active ones unless `includeStopped`. No delete tool:
  `stop_series` deactivates; occurrences stay.
- **D6. Form: a "Due" select and an optional "Until" date.** Due = No due date · Same day · Next day ·
  In 2–6 days (what a school cadence needs; a longer offset is MCP's). Until is a native
  `<input type="date">`, as [due-dates.md](due-dates.md) §6 — roll-our-own, no picker dependency. The row
  reads `seriesSummary`: "Mon, Wed · due next day · until Dec 5" / "· ended Dec 5" (a year other than
  today's is spelled out). A refused save shows inline and keeps the draft (never a silent failure). The
  Due/Until values persist across Cancel like the rule does — a quarter's courses share an end.
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
`seriesDay` is `day`, whatever its status or rows. Unplanned → backlog, no copy; "+ Today" plans the same
task again; reload after reload, one occurrence. Proven in the contract suite (both impls), on the Lambda's
own path (`backend.test.ts` → _backend recurrence_), and on dev (§6 `unplan`, `replan`, `reload-one`).

What didn't change: the stale sweep ([TECH.md](../../arch/TECH.md) → _Stale sweep_) still sends an
unplanned occurrence to backlog, and still drops a missed daily that today's copy supersedes.

## 5. Surfaces

- **Recurring tab** (`/tasks?lens=recurring`, `RecurringSection.tsx`): the form (D6) and the rows.
- **Today / Week / Backlog:** an occurrence is an ordinary task card — "due tomorrow" from its `dueDay`.
- **Task editor:** "Recurs · <rule>" is unchanged (the cadence shows on the Recurring tab's row).
- **MCP:** D5. `list_tasks` shows occurrences (with `seriesId`, `seriesDay`, `dueDay`); `list_series` the
  templates.
- **Stub seed:** one "Pre-lab report" series (weekly on today's weekday, due next day, until +42 days), so
  the tab and Today show a cadence on first load.

## 6. Dev check

`scripts/src/devcheck/scenarios/recurring.ts` — the matrix: the form's create and its row; Today "due
tomorrow"; a reload keeps one; Unplan → Backlog with no copy after two reloads; "+ Today" brings the same
one back; an Until of yesterday reads "ended" and spawns nothing; a series with no Due spawns undated; the
neighbour is untouched; `create_series` → `list_series` → Today; `create_series` with a past `until`
refused with nothing written; `stop_series` (inactive, out of the list, occurrence kept); `stop_series` on
no such id → Not found. Off dev: `getDay` twice after `removePlan` (the Lambda's own test) and another
user's id (two users on one table, `seriesTools.test.ts`).

Cleanup by recorded id, as every scenario: a series is ledgered from its create response (the browser's
`upsertSeries`, `recorder.ts`; the API's; MCP's `create_series`) with the `series` ledger kind, and
`deleteSeries` (api.ts) deletes the occurrences the server spawned for it — `getDay` made them, so no create
response ever named them; the series id is their record — then tombstones the series (D7). A `create_series`
the server refuses as a param error resolves its `intent` with a `refused` line (nothing was written).

## 7. Deferred

- A series `dueTime` (timed occurrences, unplanned) — D1.
- Editing a series' cadence from its row (the API takes `id` + the fields; MCP has no `update_series`).
- Canvas import (`01M472W1SC8MRN4E90TQAXTG7C`): an imported "Pre-Lab 3" and a cadence occurrence would be
  duplicates — cadences are for what Canvas doesn't list.
- PR-D3's exam-prep template (`01M2XZFVQJ8YNE333DJQAN4PDM`) can now use `until`.
