# Task lenses

`/tasks` is one list seen through preset **lenses** — Today · Week · Backlog · Done — plus the
Recurring and Calibration views. Every open task has exactly one home (Today, Week, Backlog or Done never
show a task twice); **Places** also lists every open errand by store, so a dated or started errand shows
there and in Week/Today ([places.md](places.md) §3). Typing in search looks across all of them, grouped by
each task's one home. Around it: a Home "+ Add" to put things on today,
a one-shot "→ today" on capture, and a night "Still open — when?" step.

Code: `app/src/modules/tasks/query.ts` (pure engine), `useTaskQuery.ts` (lens + filter state),
`TaskListSection.tsx` / `TodayLens.tsx` (renderers), `app/src/data/hooks/useAddToDay.ts` (every plan
write), `AddToTodayDialog.tsx`, `app/src/pages/Home/StillOpenSection.tsx`.

## 1. Places

`placeOf(task, { today, planOrder, dayStartHour }, parent?, isParent?)`:

| Task                                                                                                                                                                | Place   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| done or dropped                                                                                                                                                     | Done    |
| timed (not a parent), its deadline's **app day** is today; or on today's plan (untimed); or in progress                                                             | Today   |
| due today through today+6, or past due                                                                                                                              | Week    |
| an errand (has a `place`) not otherwise in Today/Week — [places.md](places.md) §3. **Places also lists every open errand**, so a dated or started one shows in both | Places  |
| everything else                                                                                                                                                     | Backlog |

A task planned for **tomorrow** (the night "Tomorrow") is `planned` with no row today, so tonight it
shows under Week or Backlog by its due day. That is deliberate and transient: tomorrow's `getDay` makes
it a Today task. A **timed** task's day is its time (D13): a plan row on it places nothing.

## 2. Decisions

- **D1 — typing searches everything open.** With search text, the lens's place is ignored and results
  come back grouped by place (Today · This week · Backlog), Today in plan order. The Done lens searches
  history only. Search matches every word against the title + category label + notes (case and
  accents ignored); a row the title and category alone don't explain says "in notes" ([notes.md](notes.md)).
  The add-to-today picker searches title + category only. Why: "find the thing" shouldn't depend on guessing which lens it's in.
- **D2 — presets carry sort + group only.** Which tasks a lens shows is `placeOf`'s job (on Places,
  `errandsByPlace` — every open errand, the Shortcut's items), so a filter or
  a search can never be clipped by a lens's window. Backlog groups by category (Settings order,
  retired-with-tasks after, "No category" last); Week is flat (D10). Both sort soonest-due first; Done
  is ungrouped, newest finished first, 50 at a time.
- **D3 — Today is the plan, not a query.** Capacity + planned-vs-available on top, then "By time" (the
  timed tasks due today, by clock, D13), then the open plan rows in plan order, then "In progress · not planned today", then a collapsed "Done today · N" (D11). Only
  search applies there; no sort/group/filter.
- **D4 — state.** The lens is in the URL (`?lens=week`, so Home links straight to Week). Search +
  filters are in sessionStorage (`aperture.tasks.query`), stamped with the day — sticky for a session,
  reset each new day. Switching lens keeps the search text and resets the filters to that lens's preset.
  Collapsed groups are in localStorage (`aperture.tasks.collapsed`); a group of 8+ starts collapsed
  (decided once, the first time the group is seen, so it doesn't snap shut as it grows). A search or a
  narrowing filter (category, due, status) opens every group; a different sort or grouping doesn't.
  The filter panel offers only options that can match on that lens (Week: due today; Backlog/Done:
  dated or not; status only on Done). Group headers carry a count (`MATH 200 · 4`) — per-course sizes
  are what you plan from; it's the whole-backlog tally the lens pill leaves out.
- **D5 — one write path.** `useAddToDay(day?)` is the only code that puts a task on a day or takes it
  off:
  - add = plan row **first**, then backlog → planned (a planned task without a row is what the stale
    sweep moves back). A planned task stays planned; an in-progress task keeps its status.
  - dedupe: `upsertPlan` keeps one alive row per (task, day) on both impls — an id-less insert for a
    task already on that day returns the row untouched (no resize, no reorder; edits go through `id`),
    on a consistent read so two taps in one second see each other (`day-guards`, 2026-11). The hook
    still reads that day's plan fresh (it sets `order` and `already`) and ignores a second call while
    the first is in flight, so the status step still runs on that path and retrying repairs a
    half-done add.
  - unplan (today's row) = remove the row, then `getDay(today)`: the stale sweep moves the task to
    backlog unless it has a row on a later day. The sweep owns that rule, so the client doesn't
    re-derive it. A started task (night "Backlog") is moved explicitly first — the sweep never touches
    in_progress.
  - Row buttons disable while their write runs, a failure shows "Couldn't save that", and focus moves
    to the list (not `<body>`) when the row leaves it.
  - **One write path, one refetch (2026-11).** Each write's hook refetches what it changed, and an add or unplan
    resolves once the lists are new: a plan write lands in its day's list at once and refetches the plans keys
    only; a task write refetches tasks, plans and calibration — never the day singleton, whose own
    refetch cascades into tasks and plans again (`useDay`). The one task write that needs the day's
    sweep, a planned task gaining a time (D13), asks for it itself (`useSetDue`); so does a new series
    (its occurrence materializes on `getDay`) and a calendar pull that changed tasks. Measured with the
    Tasks page's three queries mounted (`useAddToDay.test.tsx`): a "+ Today" went from 5 `listTasks`,
    6 `listPlansForDay`, 2 `getDay` to 1 / 3 / 0 (the pre-read, the row write's refetch, the status
    write's); an Unplan from 3 / 3 / 1 to 1 / 2 / 1. A page load is untouched (Home: 19 reads before
    and after). Task-write hooks don't wait for their refetch (the modal closes on the write's own
    answer, PR 77); `useTransitionTask({ settled: true })` does, for the row that leaves its list.
  - `createToday` = create + add, not atomic: on a planning failure the task stays in the backlog and
    the caller says so.
  - A timed task is never added (D13): `addToDay` returns `'timed'` and writes nothing, and the server's
    `upsertPlan` refuses it (`TIMED_NO_PLAN_ERROR`, both impls). `createToday` of a timed input says
    so (`timed`), and the capture receipt reads "due Fri 4pm, by its time".
- **D6 — status filters only split history.** The Done lens offers Done · Dropped (accessible names
  "Status: …"). Off Today, every open task is backlog or planned-for-another-day, so a status filter
  there could never narrow anything and isn't offered.
- **D7 — capture "→ today" is one-shot.** It applies to the next task only and resets after every
  submit, so it can't silently keep filling today's plan.
- **D8 — night "Still open — when?"** Inside "Today in review": each unfinished task on today's plan
  with no row tomorrow. **Tomorrow** adds a row for tomorrow (today's stays as history; a started task
  stays started). **Backlog** takes it off today, started or not (the locked estimate and logged time
  stay; a running focus timer on it is stopped first — if the unplan then fails, the timer is restarted,
  the status put back, and the row says so; the stopped minutes stay on the task). **Leave** hides it for the session; the next
  morning's stale sweep handles it. No count, no red. A **timed** row (D13) shows its time and offers
  Tomorrow — the same clock a day on (`setTaskDue`, so its calendar block moves with it) — and Leave;
  no Backlog, since a timed task isn't planned. A timed part whose Tomorrow would end it after its
  parent's deadline (`endsAfterParent`) offers Leave only.
- **D9 — the idle Focus control docks in the capture panel.** It used to float above the panel and sit
  over right-aligned content while scrolling.
- **D10 — Week is flat, soonest due first (2026-10-05).** Week holds only what's due within 7 days plus
  overdue, so its one question is "what's due next". Category headers scattered that answer — the
  soonest deadline could sit below a whole group of later ones — and every row already carries its
  category tag. Group → Category in the filter panel still works for the session (a "By category" chip;
  reset per D4). Backlog stays grouped: there, per-course size is what you plan from.

- **D11 — finished work leaves the plan list (2026-10-06).** Today drew every plan row whatever its
  status, so a done task sat among the open ones with an Unplan button (which would have deleted the
  history row). Now `doneToday()` (`modules/tasks/doneToday.ts`) splits it:
  - **Done today** (collapsed at the bottom): today's done plan rows in plan order, then tasks finished
    today off the plan (`completedAt`'s day key), oldest first, so a task finished from the in-progress
    tier doesn't vanish. Rows carry no actions; the title opens the editor.
  - **Dropped** tasks on today's plan show nowhere on Today; the Done lens' Dropped chip is their home.
  - **The rows stay.** Capacity still counts a done task's planned minutes (the check measures the load
    you set, and night compares against it), and Big 3 keeps a done task in its slot (right-now.md D3).
    A **dropped** task's minutes and count stop counting (`useTodayPlan`): dropping is "not doing it",
    and its row is no longer anywhere you could Unplan it from. Home's "N planned · Xh" follows.
  - **Collapsed** under `today:done` in the same map as D4. It always starts collapsed and the choice
    sticks across days, like every group. An empty group isn't drawn. With every planned task done,
    the empty state reads "Everything planned is done." instead of "Nothing planned yet."
  - A finished or dropped task's row never offers Unplan, on the Done lens either.
  - Focus: a Done row leaves the list a render after the modal host sees the new data, so the host
    also watches the list's DOM for the trigger leaving (`TaskModalHost`), else focus fell to `<body>`.
    The watch ends at the user's next tap or key, so a row they move later never pulls focus back.

- **D12 — parts live where their parent does (2026-10-08, [parts.md](parts.md) D9).** A part not on today's
  plan (and not in progress) is placed by its open parent's deadline, not its own time, which is when its
  block ends (`placeOf(task, today, planOrder, parent)`; `placer` looks the parent up). Outside a search, a part
  whose parent is in the same result folds into the parent's card (`foldParts`), where it's drawn as a compact
  row with "+ Today", "today", "in progress" or done struck (`PartsList`), and the lens pills count cards. Search
  and the Done lens stay flat. A parent never goes on Today, and the add-to-today picker skips parents and
  labels parts "of P2". A part on Today is an ordinary card, tagged "of P2 · due …".

- **D13 — option 3: a time decides the day (2026-10-30, parts v2b).** A timed task (`dueDay` +
  `dueTime`, not a parent) is on Today on the app day its deadline falls on, and never planned; only an
  untimed task is planned. `placeOf` and `todayRows` (`modules/tasks/todayRows.ts`) read it the same
  way: timed rows first ("By time", no Unplan, in deadline order), then the plan.
  - **The day is the deadline instant's app day** (`timedDay`, shared `machines.ts`): the instant
    bucketed by `dayKey` like every other one, so with a 4am day start a 00:30 deadline is still
    tonight's, and after 23:00 in By time. **Placement, the "Due today"/"Due this week" chips
    (`inDueBucket`) and the labels all read the app day:** a deadline after midnight but before the day
    start reads **tonight** — `due tonight 12:30am` (Tasks, Coming up, Add to today, the capture
    receipt and chips; `fmtDueDay` given `{ dayStartHour }`), `ends tonight 12:30am` on a part,
    `by 12:30am` in Right now (its compact form), `due tonight 12:30am` at night. One already past
    stays as written: a task due today 2am, seen after 4am, sits overdue in Week reading
    `due today 2am` in the past colour, and is out of "Due today" (its app day was yesterday); no
    "last night" tier; nor does a passed one tonight (at 2am, `due tonight 12:30am` in the past
    colour). Capture rolls a small-hours clock typed for today onto the next date
    ([quick-add.md](quick-add.md), 2026-10-31). Known gap: "tonight" is a clock test
    (`beforeDayStart`) while the day is `dayKey`'s real hours, so they disagree for one hour on a DST
    night (fall-back: a 03:00–03:59 deadline reads "tonight" but sits in Week). The fix is a wall-clock
    rollover in `dayKey` itself — a follow-up.
  - **Why:** "OA closes Sun 11:59pm" belongs to Sunday; a plan row put it on Wednesday and the deadline
    read twice. Working earlier means a part with its own Ends ([parts.md](parts.md) D14), not
    planning the deadline. The trade-off: a timed task moved in Google moves its day, like a reschedule.
  - **One write rule, one healer:** `upsertPlan` refuses a timed task; a planned task that gains a time
    (or an MCP `status: planned`) is the next `getDay`'s stale sweep's — any timed `planned` task goes
    back to backlog, whatever its rows (`stalePlannedMoves`, never cancelling a timed occurrence). Its
    rows stay as history. The sweep is monotone, so `getDay` refuses a day after the user's app day
    (`FUTURE_DAY_ERROR`, both impls, `day-guards` 2026-11; the Lambda's today is LA's, so a device whose own day is ahead of LA's — travelling east — sees that error on Home and Tasks until LA's day catches up, where before it silently swept today's plan) — a future call is a client bug surfaced
    loudly, never served unswept. That sweep is also the migration: zero Google writes, status only. The
    Lambda re-judges each move on a consistent re-read, and `upsertPlan` reads the list consistently
    (a time cleared a moment ago is honoured). A timed occurrence is never dropped as superseded — it
    goes to backlog and sits overdue in Week until dealt with; rare, and safer than cancelling an
    occurrence for having its own row today. A roll pick whose open rep is timed is refused the same
    way ([rolls.md](../home/rolls.md) D6).
  - **Rows:** a timed task with no row counts its block's length toward capacity (estimate + buffer,
    else 30); a legacy row's minutes still count. A timed task done today stays for capacity; one
    finished before today is gone. "+ Today" is hidden on a timed task everywhere, and the add-to-today
    picker leaves timed tasks out with one line: "Timed tasks land on their day — break one down to
    work on it earlier." A split's follow-up of a timed task, and a timed first part, aren't planned.
    Home's "N waiting in the backlog" counts what "+ Add" can pull in — no timed task, no parent.
  - **Right now:** the Big 3 stay the chosen plan; timed rows are a "By time" tier above Also today
    ([right-now.md](../home/right-now.md) D11).

- **D14 — the Backlog is the life backlog (2026-11-05, [areas.md](areas.md)).** Every category has a life
  area (School · Aperture · Recruiting · Personal; none reads as Personal). Backlog's preset shows the life
  areas (`TaskQuery.areas = LIFE_AREAS`); the Aperture-area cards wait behind a toggle chip **"Aperture · N"**
  in the chips row — pressed while shown, N = the Aperture cards in the Backlog whatever the query
  (`areaCardCounts`), not drawn when N is 0. A part in the same list follows its parent's area, as it
  follows its place. It is session state like every filter (D4: sticky for the session, reset each day);
  it widens rather than narrows, so it is no override chip, never counts toward "Filter · N", and Clear /
  Reset to lens fold it back. A search ignores it (D1: typing finds everything). Today and Week never
  filter by area — a dev ticket due Friday is due Friday. Home's "N waiting" (`useBacklog`) and the
  "+ Add" picker's unsearched list apply the same life predicate (`lifeFrom`); typing in the picker finds
  anything. Why: with Aperture work in the same list as coursework the plan pass started from the wrong
  question; the chip keeps it one tap away.

## 3. Deferred

- Find-from-anywhere (Cmd/Ctrl+K) reusing `query.ts` — **won't do** (2026-11-05): the daily device is the phone, where "find" is Tasks → type and D1 makes the lens moot; no usage note records a miss. The build shape, if a miss is ever reported, is on task 01M38GBZ6SYT21KV0GP2QXCW4P (a `?q=` link into `/tasks` first, a Find dialog only if still wanted).
