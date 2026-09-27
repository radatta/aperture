# Task lenses

`/tasks` is one list seen through preset **lenses** — Today · Week · Backlog · Done — plus the
Recurring and Calibration views. Every open task lives in exactly one place, so no lens shows a task
twice; typing in search looks across all of them. Around it: a Home "+ Add" to put things on today,
a one-shot "→ today" on capture, and a night "Still open — when?" step.

Code: `app/src/modules/tasks/query.ts` (pure engine), `useTaskQuery.ts` (lens + filter state),
`TaskListSection.tsx` / `TodayLens.tsx` (renderers), `app/src/data/hooks/useAddToDay.ts` (every plan
write), `AddToTodayDialog.tsx`, `app/src/pages/Home/StillOpenSection.tsx`.

## 1. Places

`placeOf(task, today, todaysPlan)`:

| Task | Place |
| --- | --- |
| done or dropped | Done |
| on today's plan, or in progress | Today |
| due today through today+6, or past due | Week |
| everything else | Backlog |

A task planned for **tomorrow** (the night "Tomorrow") is `planned` with no row today, so tonight it
shows under Week or Backlog by its due day. That is deliberate and transient: tomorrow's `getDay` makes
it a Today task.

## 2. Decisions

- **D1 — typing searches everything open.** With search text, the lens's place is ignored and results
  come back grouped by place (Today · This week · Backlog), Today in plan order. The Done lens searches
  history only. Search matches every word against the title + category label + notes (case and
  accents ignored); a row the title and category alone don't explain says "in notes" ([notes.md](notes.md)).
  The add-to-today picker searches title + category only. Why: "find the thing" shouldn't depend on guessing which lens it's in.
- **D2 — presets carry sort + group only.** Which tasks a lens shows is `placeOf`'s job, so a filter or
  a search can never be clipped by a lens's window. Week/Backlog group by category (Settings order,
  retired-with-tasks after, "No category" last) and sort soonest-due first; Done is ungrouped, newest
  finished first, 50 at a time.
- **D3 — Today is the plan, not a query.** Capacity + planned-vs-available on top, plan rows in plan
  order, then "In progress · not planned today". Only search applies there; no sort/group/filter.
- **D4 — state.** The lens is in the URL (`?lens=week`, so Home links straight to Week). Search +
  filters are in sessionStorage (`aperture.tasks.query`), stamped with the day — sticky for a session,
  reset each new day. Switching lens keeps the search text and resets the filters to that lens's preset.
  Collapsed groups are in localStorage (`aperture.tasks.collapsed`); a group of 8+ starts collapsed
  (decided once, the first time the group is seen, so it doesn't snap shut as it grows). A search or a
  narrowing filter (category, due, status) opens every group; a different sort or grouping doesn't.
  The filter panel offers only options that can match on that lens (Week: due today; Backlog/Done:
  dated or not; status only on Done). Group headers carry a count (`CSEN 146 · 4`) — per-course sizes
  are what you plan from; it's the whole-backlog tally the lens pill leaves out.
- **D5 — one write path.** `useAddToDay(day?)` is the only code that puts a task on a day or takes it
  off:
  - add = plan row **first**, then backlog → planned (a planned task without a row is what the stale
    sweep moves back). A planned task stays planned; an in-progress task keeps its status.
  - dedupe: `upsertPlan` has none, so the hook reads that day's plan fresh and skips writing a row the
    task already has, and ignores a second call while the first is in flight. The status step still
    runs on that path, so retrying repairs a half-done add. Server-side dedupe is a follow-up (§3).
  - unplan (today's row) = remove the row, then `getDay(today)`: the stale sweep moves the task to
    backlog unless it has a row on a later day. The sweep owns that rule, so the client doesn't
    re-derive it. A started task (night "Backlog") is moved explicitly first — the sweep never touches
    in_progress.
  - Row buttons disable while their write runs, a failure shows "Couldn't save that", and focus moves
    to the list (not `<body>`) when the row leaves it.
  - `createToday` = create + add, not atomic: on a planning failure the task stays in the backlog and
    the caller says so.
- **D6 — status filters only split history.** The Done lens offers Done · Dropped (accessible names
  "Status: …"). Off Today, every open task is backlog or planned-for-another-day, so a status filter
  there could never narrow anything and isn't offered.
- **D7 — capture "→ today" is one-shot.** It applies to the next task only and resets after every
  submit, so it can't silently keep filling today's plan.
- **D8 — night "Still open — when?"** Inside "Today in review": each unfinished task on today's plan
  with no row tomorrow. **Tomorrow** adds a row for tomorrow (today's stays as history; a started task
  stays started). **Backlog** takes it off today, started or not (the locked estimate and logged time
  stay; a running focus timer on it is stopped first). **Leave** hides it for the session; the next
  morning's stale sweep handles it. No count, no red.
- **D9 — the idle Focus control docks in the capture panel.** It used to float above the panel and sit
  over right-aligned content while scrolling.

## 3. Deferred

- Server-side plan dedupe (both impls, contract-tested).
- Find-from-anywhere (Cmd/Ctrl+K) reusing `query.ts`, only if searching outside `/tasks` is missed.
