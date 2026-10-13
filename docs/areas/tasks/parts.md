# Parent + parts

**Status: v1 built 2026-10-08** (branch `task-parts`). v2 (a part's time edited as its block, a timed task's day taken from its block, the parent's due marker) is designed below and not built.

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
- **A timed split** (decided 2026-10-08, chosen because it makes v2 cheaper): Part 1 keeps the original's time and block, and the follow-up inherits the time. "Keep going" gives two blocks at the time; "done" moves the event to the follow-up (`moveLink`, with only `gcalSeen`), never to the parent.
- **An untimed split** (decided 2026-10-11): the due day goes to the parent only. A standalone original's day was its deadline, so Part 1 drops it, and the follow-up never inherits an untimed day. Otherwise both parts would read "ends Tue" off what is really the parent's due date. A part's own untimed day stays on it.

**D8. The parent never owns a Google event, by any path** (v1). Every event write goes through one of two chokepoints:

- **`calendarSyncPlan`** (auto-sync, and the Add/Retry/Send button's `syncCalendarEvent`). With `opts.parent` it deletes a linked event, whatever the toggle says, and otherwise does nothing. It runs after the owed-removal delete.
- **`insertCalendarEvent`** (the picker, MCP `create_calendar_event`). It refuses a parent with `PARENT_NO_EVENT_ERROR`, before its other checks.

The pull, roll reps and series spawn never create one. Untimed parts keep manual blocks like any untimed task. A sync-failure note on a parent with no event is cleared as moot, and its editor keeps the error and Retry rows (a Retry on a linked parent deletes the event). The backend skips the parent scan on a create (a brand-new task has no parts), so a timed bulk paste pays nothing extra inside its sync budget. In v2 the parent gets a due marker (below) in place of D8's delete.

**D9. Where parents and parts show** (2026-10-08).

- **Week/Backlog:** a part not on today lives where its open parent does, judged by the parent's deadline (`placeOf(..., parent)`). It folds into the parent's card as a compact row (`foldParts`, `PartsList`), and lens counts count cards. A parent card shows `1/3 · est 1h 45m · 1 unscoped` (open parts with no estimate, D11) and no Start/Scope.
- **Today:** a part on today's plan is an ordinary card there, with "of P2". A parent never appears on Today, and the add-to-today picker lists parts but never parents.
- **Search and the Done lens:** flat, so every match is its own row.
- **Home:** Right now tags parts "of P2" and uses the parent's deadline. Coming up lists parents with `1/3` and never parts. The night review bars each done part and a parent done today.
- **Editor, parent:** "Open · 1 of 3 parts", a read-only estimate ("2h 40m — the sum of its parts"), a **Parts** section (rows, Add parts…, the nudge or the refusal), "Its parts carry their own calendar blocks.", and Drop/Delete copy that names the parts. No Split.
- **Editor, part:** "Part 2 of 3 of P2 · due …", where the parent's title opens the parent. Ends / Ends at, and its own DeltaBar.
- **Break down…** (a plain task never worked on) and **Add parts…** (a parent) both open `BreakDownForm`: one part per line, `title | ~minutes` (the bulk-add grammar, minutes only; `#` and `due:` are errors, since those are the parent's). Parts inherit the parent's category, and a plain task's own estimate prefills the first line.

**D10. `splitFromId` is retired with no migration.** It was two days old. Stored attributes on old rows are inert: they're read past, and ride along in the export. Old split pairs calibrate as independent tasks until re-linked by hand with `update_task {parentId}` (about one task, 2026-10-08).

**D11. One refusal and two counts, after dev testing** (decided 2026-10-12).

- **A roll rep or a recurring occurrence isn't split** (`isRep`, `REP_NO_SPLIT_ERROR` in `splitOriginal`, so both impls refuse alike; the editor hides Split via `canSplit`). Splitting the LeetCode daily rep made a roll-less parent plus two roll-tagged parts on one day, two reps where there was one. It's the same reason a rep can't take parts (D2). The guard is on the task's own `rollId`/`seriesId`, so a roll-tagged part from before this also refuses; it can still be finished or dropped, and its parent can take more parts. The follow-up never copies `rollId` now. This supersedes split.md D5.
- **`unscoped` counts open parts only** (`partsSummary`). A done part's estimate can't be set any more, so it would nag forever. The parent's `estimateMin` still sums every part not dropped, done ones included: it's the whole job's size, the thing the lock is compared with. So a done part that was never estimated adds nothing to that size, and nothing flags it any more; its time still counts in the parent's actual and in calibration. Accepted (Rahul, 2026-10-12): a finished task's estimate can't be set, so a flag would have no fix.
- **A rollup's part count is its parts not dropped** (`rollupParts`, behind `CalibrationPoint.parts` and Home's night label), matching the card's `2/2` and the editor's "2 of 2 parts". A done parent always has one: `PARENT_ALL_DROPPED_ERROR` refuses the rest, and a done part can't be dropped afterwards. The delete confirm still counts every part, because it deletes every part.

## Write rules (both impls, contract-tested)

| Method                                                           | On a parent / part                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTask(s)` with `parentId`                                  | Every parent is checked before any write. The first part runs `becomeParent`, plus the plan hand-over when the parent was planned. Then `freezeParentLock`.                                                                                                                                                |
| `setTaskParent(id, parentId \| null)`                            | `assertCanBePart`. Attaching a first part runs `becomeParent` with no hand-over (the part keeps its own plan); attaching a started task can be the parent's first start (`freezeParentLock`). Detaching, or moving to another parent, releases the old parent if that was its last part (`releaseParent`). |
| `transitionTask`                                                 | Parent: `done` → `completeParent`; `cancelled` → the cascade; anything else → refused. Part: the normal machine, then — when it just left planning — `freezeParentLock`.                                                                                                                                   |
| `setTaskEstimate` / `setTaskActual` / `upsertPlan` / `splitTask` | Refused on a parent. `splitTask` also refuses a roll rep or a recurring occurrence (`splitOriginal`, D11).                                                                                                                                                                                                 |
| `deleteTask`                                                     | Parent: every part first, then itself. Part: releases its parent if it was the last.                                                                                                                                                                                                                       |
| `insertCalendarEvent` / `syncCalendar`                           | D8.                                                                                                                                                                                                                                                                                                        |
| `getCalibration`                                                 | `calibrationTasks = filter(contributesCalibration)`.                                                                                                                                                                                                                                                       |

## v2 (designed 2026-10-06, not built)

- **A part's time is edited as its block.** It's the same `dueDay`/`dueTime`, already editable in v1 as Ends / Ends at. Two-way sync already moves it on an end drag and sets the estimate on a start drag.
- **A timed task's day is its block's day ("option 3").** If a task has a time, the time decides its day; otherwise its plan row does. A timed task needs no plan row: dragging its block in Google moves it on Today. The trade-off: a moved block reads as a reschedule, not a rollover. This touches Today, the stale sweep, `useAddToDay` and the night review.
- **The parent's due marker:** a 15-min event marked "free", whose end is the due time, titled with the parent's plain title, and told apart by a graphite `colorId`.
  - **Pull rules:** an end drag sets the due date/time, read from the event's time and never parsed from text. A start drag is ignored, since the estimate is the sum of the parts. A rename syncs. Colour is never pulled.
  - **Code:** the marker needs its own window (`[due − 15m, due]`) and a parent branch in the pull planner. It replaces D8's delete line.
