# Parent + parts

**Status: v1 built 2026-10-08** (branch `task-parts`). **v2a built 2026-10-13** (branch `parts-v2`): part blocks named after their parent (D12) and the parent's due marker (D13). **v2b built 2026-10-30** (branch `parts-v2b`): a timed task's day is its time (D14).

When something is due is often very different from when you work on it, and the work often comes in parts. A pset due Tuesday, done as three chunks across Monday and Tuesday, is really two things: the **deliverable** (due when it's actually due, done when submitted) and the **work** (blocks on do-days, each with an estimate and an actual). A **parent** is the deliverable; its **parts** are the work.

```
P2 · CSCI 198 · due Tue 11:59p · 1/3 · est 3h      ← parent: the deadline, category, notes
 ├─ Part 1 · Mon · done 50m (est 45)               ← parts: ordinary tasks — planned,
 ├─ Part 2 · Tue · planned 60m                        worked, measured on their own
 └─ Part 3 · Tue · planned 75m
```

All rules live in one file, `packages/shared/src/parts.ts`, which both `ApiClient` impls and MCP call. The split mechanics stay in `split.ts`.

## Decision log

**D1. One level, and parenthood is derived (2026-10-06/08).** `Task.parentId` replaces `splitFromId`. A task is a parent while some alive task's `parentId` points at it; nothing stored says so, so nothing can disagree with the parts. A parent can't have a parent, and a part can't have parts (`assertCanBePart`). Epics were rejected as overkill for one person.

**D2. The parent is a container.**

- It holds the due date (day + time), category and notes. It is never planned, started or given sessions; its status is only ever backlog, done or cancelled.
- Its estimate is the live sum of its parts; `estimateMin`/`bufferMin` stay null, and a write is refused.
- Work it would have had of its own ("proofread + submit") is a part.
- Only a task never worked on can become a parent (`assertParentEligible` / `canBecomeParent`: no `startedAt`, no logged time), since its logged time would have nowhere to go. A started task is split instead, which keeps that work as Part 1.
- A roll rep or a recurring occurrence can't become a parent either. Each is one rep of a repeating thing: the roll would re-plan it onto Today, and the series would respawn it once its plan row went (review round 1). Nor is one split (D11).
- **Taking its first part** (`becomeParent`): its estimate clears, its plan rows are tombstoned, and any calendar block is removed. If it was planned, the batch's first part takes its spot on the plan (same day and order, sized to the part).

**D3. Marking a parent done is a hard block while any part is open.**

- **The error names the parts:** "Part 3 isn't finished — complete, drop or delete it first" (`partOpenError`). It's enforced in shared logic, so the UI, both impls and MCP `complete_task` refuse alike.
- **The nudge:** once every part is done or dropped, a "Mark done" appears, as the primary button in the editor ("All parts done — mark it submitted?") and on its card. Home's Coming up just says "all parts done".
- **One tap:** marking it done prompts for nothing. Its actual is stamped as the sum of its done parts (`completeParent`); MCP refuses an `actualMin` on a parent.
- **Every part dropped:** marking it done is refused ("drop it instead"). Otherwise there's nothing to submit, and it would stamp a 0 actual against its lock — a bogus calibration point (review round 1).

**D4. The cascade.**

- **Cancelling a parent** cancels its open parts first, each through the normal cancel path (so their blocks go), then the parent. Done parts stay as history.
- **Permanently deleting a parent** deletes every part the same way, after a confirmation that names the count ("Delete “P2” and its 3 parts?"). MCP `delete_task` returns the part ids.
- **Acting on one part** never touches the parent or its siblings. A dropped part leaves the parent's sum and its count (`1/2`).

**D5. Calibration: every part is a point, and so is the done parent.**

- **The parent's lock** is frozen once, at **the moment the first part leaves planning** (it starts, or a started task is attached): the sum of each part's lock, else its working estimate, over the parts not dropped (`freezeParentLock`).
  - **If that moment passed with no baseline,** the lock stays unset. For example, a started, unscoped task was split: its parent inherits the original's null lock, and Part 2 starting later never adds one, because one written then would be hindsight. A split never freezes either: a standalone split's parent _is_ the original's lock (review round 1).
  - **A task whose last part goes** (detached, moved to another parent, or deleted) is plain again, and its lock goes too (`releaseParent`). It never had work of its own, so it re-freezes when it's actually started (review round 1).
- **A done parent** compares that lock with the sum of what its parts took. So it's an ordinary calibration row (`contributesCalibration`), and the night review and calibration page label it `· N parts`, counting the parts not dropped (D11).
- **The headline counts the work once** (decided 2026-10-11). `CalibrationPoint.parts` (> 0 on a rollup) lets the calibration page's aggregate leave parents out, since their parts are points already. Parents still show in Recent and the night review, where the "3 planned, 4 needed" signal lives. MCP `get_calibration` says the same.
- **What the two levels show:** each part says whether that piece was sized right. The parent says whether the whole job was, including a part you didn't plan (3 planned, 4 needed).
- **Replaces split.md's interim D6 exclusion and its "piece 3" family calibration.**
- **A part split mid-work stays its own point** (decided 2026-10-08). Its lock covers more than the done half, but the parent's rollup absorbs exactly that case, and excluding it would need the provenance `splitFromId` carried.

**D6. Split always yields parent + parts** (2026-10-06; mechanics in [split.md](split.md)).

- **Splitting a standalone task:** it becomes Part 1 under a new parent, keeping its id, so its sessions stay. The parent takes its title (or a typed one), category, deadline, notes (copied) and lock (`newParentFrom`).
- **Splitting a part** adds a sibling under the same parent. A parent itself can't be split; add a part instead. Nor can a roll rep or a recurring occurrence (D11).
- **Titles:** the split form offers three titles (Deliverable, This part, Next part), prefilled with the task's title, "Part 1" and "Part 2". What's typed is what's stored. MCP's omitted `title` on a standalone split defaults to "Part 1".

**D7. A part's own time is when its block ends, not a deadline** (2026-10-06).

- **Storage:** it's stored in `dueDay`/`dueTime`, so calendar sync works on parts unchanged (block = `[time − estimate, time]`).
- **Wording:** it reads "Ends / Ends at" in the editor and "ends Thu 3pm" on the card (`fmtDueDay(..., 'ends')`).
- **Its deadline is its parent's** (`deadlineOf`). That sets the part's urgency colour, Right now's "by …", and the "of P2 · due Tue 11:59pm" context. A part never appears on Coming up; its parent does.
- **A real intermediate deadline** ("draft due Thu, final due Tue") is two deliverables, so two parents.
- **A timed split** (decided 2026-10-08, chosen because it makes v2 cheaper): Part 1 keeps the original's time and block, and the follow-up inherits the time. "Keep going" gives two blocks at the time; "done" moves the event to the follow-up (`moveLink`, with only `gcalSeen`), never to the parent, which gets a due marker of its own (D13).
- **An untimed split** (decided 2026-10-11): the due day goes to the parent only. A standalone original's day was its deadline, so Part 1 drops it, and the follow-up never inherits an untimed day. Otherwise both parts would read "ends Tue" off what is really the parent's due date. A part's own untimed day stays on it.

**D8. A parent owns exactly one event: its due marker (D13), by any path** (v1, reworded for v2a). Every event write goes through one of two chokepoints:

- **`calendarSyncPlan`** (auto-sync, and the Add/Retry/Send button's `syncCalendarEvent`). With `opts.parent` its window is the marker's and a create/patch carries `marker`. An untimed parent's event goes (the marker needs a time), whatever the toggle says. It runs after the owed-removal delete.
- **`insertCalendarEvent`** (the picker, MCP `create_calendar_event`). It refuses a parent with `PARENT_NO_EVENT_ERROR`, before its other checks: a marker is placed by the deadline, never picked.

The pull, roll reps and series spawn never create one. Untimed parts keep manual blocks like any untimed task. A sync-failure note on an untimed parent with no event is cleared as moot. The backend skips the parent scan on a create (a brand-new task has no parts), so a timed bulk paste pays nothing extra inside its sync budget.

**D9. Where parents and parts show** (2026-10-08).

- **Week/Backlog:** a part not on today lives where its open parent does, judged by the parent's deadline (`placeOf(..., parent)`). It folds into the parent's card as a compact row (`foldParts`, `PartsList`), and lens counts count cards. A parent card shows `1/3 · est 1h 45m · 1 unscoped` (open parts with no estimate, D11) and no Start/Scope.
- **Today:** a part on today's plan is an ordinary card there, with "of P2". A parent never appears on Today, and the add-to-today picker lists parts but never parents.
- **Search and the Done lens:** flat, so every match is its own row.
- **Home:** Right now tags parts "of P2" and uses the parent's deadline. Coming up lists parents with `1/3` and never parts. The night review bars each done part and a parent done today.
- **Editor, parent:** "Open · 1 of 3 parts", a read-only estimate ("2h 40m — the sum of its parts"), a **Parts** section (rows, Add parts…, the nudge or the refusal), the Calendar section's marker rows (D13), and Drop/Delete copy that names the parts. No Split.
- **Editor, part:** "Part 2 of 3 of P2 · due …", where the parent's title opens the parent; a dropped part reads "Dropped · part of P2" (it no longer counts among the parts). Ends / Ends at, a flat "Ends after P2 is due." under them when that's so (`endsAfterParent` — a note, nothing blocks), and its own DeltaBar.
- **Break down…** (a plain task never worked on) and **Add parts…** (a parent) both open `BreakDownForm`: one part per line, `title | ~minutes` (the bulk-add grammar, minutes only; a category or a date is an error, since those are the parent's). Its errors are in the form's own words, mapped from the parser's `errorKinds` (never its English), never the bulk-add grammar (`#`, `due:`) a part has no use for; the part count hides while a line is wrong. Parts inherit the parent's category, and a plain task's own estimate prefills the first line.

**D10. `splitFromId` is retired with no migration.** It was two days old. Stored attributes on old rows are inert: they're read past, and ride along in the export. Old split pairs calibrate as independent tasks until re-linked by hand with `update_task {parentId}` — none on prod (checked 2026-10-13).

**D11. One refusal and two counts, after dev testing** (decided 2026-10-12).

- **A roll rep or a recurring occurrence isn't split** (`isRep`, `REP_NO_SPLIT_ERROR` in `splitOriginal`, so both impls refuse alike; the editor hides Split via `canSplit`). Splitting the LeetCode daily rep made a roll-less parent plus two roll-tagged parts on one day, two reps where there was one. It's the same reason a rep can't take parts (D2). The guard is on the task's own `rollId`/`seriesId`, so a roll-tagged part from before this also refuses; it can still be finished or dropped, and its parent can take more parts. The follow-up never copies `rollId` now. This supersedes split.md D5.
- **`unscoped` counts open parts only** (`partsSummary`). A done part's estimate can't be set any more, so it would nag forever. The parent's `estimateMin` still sums every part not dropped, done ones included: it's the whole job's size, the thing the lock is compared with. So a done part that was never estimated adds nothing to that size, and nothing flags it any more; its time still counts in the parent's actual and in calibration. Accepted (Rahul, 2026-10-12): a finished task's estimate can't be set, so a flag would have no fix.
- **A rollup's part count is its parts not dropped** (`rollupParts`, behind `CalibrationPoint.parts` and Home's night label), matching the card's `2/2` and the editor's "2 of 2 parts". A done parent always has one: `PARENT_ALL_DROPPED_ERROR` refuses the rest, and a done part can't be dropped afterwards. The delete confirm still counts every part, because it deletes every part.

**D12. A part's block is named after its parent** (v2a, 2026-10-13). `blockTitle`: `P2 · Part 1`, always, custom part titles included — the parent's name is the context a calendar needs. A part titled like its parent stays plain (never `P2 · P2`); a parent's marker and a plain task's block carry the plain title.

- **Propagation:** renaming a parent re-sends each linked, unfinished part (`setTaskTitle`'s fan-out — one Google call each, bounded by the part count; a failure lands on that part as `gcalSyncError` with Retry, never on the rename). Attaching, moving or detaching a part (`setTaskParent`) re-sends its own block under the new name.
- **Pull:** a Google rename has a leading `P2 · ` stripped before it reaches the part's title (`titleFromBlock`); a rename without the prefix is taken whole, and the next push puts the prefix back. A rename down to just the prefix writes nothing. "Kept your title" is decided in the part's own title space (the stripped base vs the part's title), so the prefix is never mistaken for an Aperture change waiting to go.
- **v1 blocks** (seen as bare `Part 1`) get the prefix with their next push of any kind; a Google rename of one meanwhile applies like any other (Rahul, 2026-10-29). A block linked before two-way sync (no `gcalSeen`) isn't renamed by a parent rename until its next push — documented, not special-cased. Known gap: a parent renamed in Google leaves its parts' blocks on the old prefix until their next push (the pull never writes to Google); meanwhile a Google rename of such a block still applies, the old prefix recovered from `gcalSeen` and stripped. Rare, accepted: the Lambda's pull reads the task list once, so a part's block renamed to the parent's _new_ name in the same delta as the parent's own Google rename keeps that prefix in its title.
- The manual picker on an untimed part prefills the same name (`AddToCalendarForm`, MCP `create_calendar_event`'s default title).

**D13. The parent's due marker** (v2a, 2026-10-13; replaces v1's delete in D8). A 15-minute (`MARKER_MIN`) event ending at the parent's deadline (`syncWindow(task, epoch, true)`), with the parent's plain title, shown free (`transparency: transparent`, so it never counts as busy) and graphite (event `colorId "8"`; neither of the user's own calendars is graphite, checked 2026-10-13). The gateway's `marker` flag carries the look. `gcalSeen.marker` records the look Aperture last sent, and the planner sends `marker` whenever the event's recorded look differs from the task's (a parent → marker, anything else → block), so a switch that failed or was skipped (sync off, finished) heals with the next push or Retry (Rahul, 2026-10-29). A block never sent a look is left alone, since its colour may be the user's own; a rename or a due change on a marker already showing as one never resends it.

- **When it appears (lazy, no backfill):** on Break down / the first part of a timed task (its block is patched into the marker — `adoptAsParent` syncs with `ensure`, which also creates one when the block had been removed by hand), on a timed standalone split (the new parent's marker is created after its parts), on a parent's due change, and from the editor's **Add due marker** or MCP `sync_calendar_event`. Nothing is written at deploy.
- **When it changes:** a due change moves it; marking the parent done leaves it, as a done task's block stays; cancelling the parent drops its open parts' blocks, then the marker. Its last part going (detached, moved, deleted) patches it back into a block (`releaseParentState`, an `ensure` sync: window + `marker: false` → `transparency: opaque`, `colorId: null`) — the fix for v1's "a released timed parent gets no block back". Deleting the parent itself never patches first: its parts go without releasing it (`deleteOne(id, false)`).
- **Pull:** an end drag sets the due date/time, read from the event's time and never parsed from text. A start drag or a stretch is ignored (a parent has no estimate of its own), and the push compares only a marker's end, so a stretch survives later edits too. A rename syncs. Colour is never read back. A Google delete unlinks, as for any block.
- **Editor:** linked → "Due marker on Google Calendar" + Remove; timed, unlinked, auto-sync on → "No due marker on your calendar." + **Add due marker**; untimed → "Set a due time to put its deadline on your calendar."; timed with sync off → says so. The card's meta reads "due marker" for a linked parent.

## Write rules (both impls, contract-tested)

| Method                                                           | On a parent / part                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTask(s)` with `parentId`                                  | Every parent is checked before any write. The first part runs `becomeParent`, plus the plan hand-over when the parent was planned, and its block becomes the marker (D13). Then `freezeParentLock`.                                                                                                                                    |
| `setTaskParent(id, parentId \| null)`                            | `assertCanBePart`. Attaching a first part runs `becomeParent` with no hand-over (the part keeps its own plan); attaching a started task can be the parent's first start (`freezeParentLock`). Detaching, or moving to another parent, releases the old parent if that was its last part (`releaseParent`; its marker becomes a block). |
| `transitionTask`                                                 | Parent: `done` → `completeParent`; `cancelled` → the cascade; anything else → refused. Part: the normal machine, then — when it just left planning — `freezeParentLock`.                                                                                                                                                               |
| `setTaskEstimate` / `setTaskActual` / `upsertPlan` / `splitTask` | Refused on a parent. `splitTask` also refuses a roll rep or a recurring occurrence (`splitOriginal`, D11).                                                                                                                                                                                                                             |
| `setTaskTitle`                                                   | Parent: re-sends each linked, unfinished part's block (D12).                                                                                                                                                                                                                                                                           |
| `deleteTask`                                                     | Parent: every part first (without releasing it), then itself. Part: releases its parent if it was the last.                                                                                                                                                                                                                            |
| `insertCalendarEvent` / `syncCalendar`                           | D8, D12, D13.                                                                                                                                                                                                                                                                                                                          |
| `getCalibration`                                                 | `calibrationTasks = filter(contributesCalibration)`.                                                                                                                                                                                                                                                                                   |

## D14. A timed task's day is its time ("option 3", v2b, 2026-10-30)

If a task has a time, the time decides its day; otherwise its plan row does. A timed part is on Today on the app day its end falls on (a 00:30 end with a 4am day start is still tonight, and reads `ends tonight 12:30am`), by clock, tagged "of P2"; on other days it sits under its parent, reading "ends Fri 3pm" instead of "+ Today". A timed first part doesn't take its planned parent's spot, and a timed original's split follow-up isn't planned. Working earlier on a deadline means a part with its own Ends, not planning the deadline. At night, a timed part's Tomorrow isn't offered when a day on would end it after its parent's deadline. The rule, the sweep that enforces it, Today and the night: [lenses.md](lenses.md) D13.

**Build note (parts-v2b-reads, 2026-11).** PR 77 made task reads consistent; the rest of the BFF's read-then-write rows followed — plans (`findPlan`: a second reorder straight after the first must move the row the first one left, not resurrect the one it dropped), the day row (`getDay(day, { consistent })` for the three setters), categories, settings, stories, habits and their checks — each repo read taking `opts?: { consistent?: boolean }` and each site that writes the copy back passing `{ consistent: true }` (`lambdas/src/backend.test.ts` → _read-then-write under lagging reads_). Display reads stay eventual; `getRunningSession` only gained the parameter (sessions belong to the stop-session rewrite). Two nits from PR 77's round 3 landed with it: a timed part's second line on Right now at phone width reads "of P2 · ends 3pm · due Mon 5pm" with the parent's name the piece that truncates (`RowText`/`PartOf`), and the stub parse takes "call due 9am" as "call" at 9 (`stubParse.ts`; prod parses with Haiku).
