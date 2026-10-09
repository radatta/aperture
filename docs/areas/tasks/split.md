# Split + editable estimates

When work turns out bigger than estimated, you **split** the task. The finished (or ongoing) part stays as the original. The rest becomes a new part with its own estimate. Separately, the working estimate is now **editable mid-task**. Calibration still measures against the baseline frozen at start, so neither change can launder the signature metric.

**Revised 2026-10-08 by [parts.md](parts.md):** a split always yields **parent + parts**. A standalone original becomes Part 1 under a new parent that takes its title, deadline and lock. Splitting a part adds a sibling. `splitFromId` and the "family" are retired, and piece 3 (family calibration) became the parent's rollup (parts.md D5). D2's mechanics below still hold; D3, D6 and D7 are superseded where marked.

This was piece 1 of 3:

1. Editable estimates + real split (this doc).
2. Calendar two-way sync: dragging an event's start in Google changes `estimateMin`. Built 2026-10-08 (PR 53).
3. Family calibration on the calibration page. Absorbed into parent + parts (parts.md D5).

The split mechanics live in `packages/shared/src/split.ts`, and the parent rules in `parts.ts`. Both `ApiClient` impls call them (the same pattern as `rolls.ts`).

```
      A (started, lock = 60)                    P "A" (new parent: A's title, deadline, lock 60)
      ├─ done with this part ─► A done   ──►     ├─ Part 1 = A (same id, done, actual 40)
      └─ remaining ─► new part B                 └─ Part 2 = B (own estimate)   rollup: 60 vs Σ actual
```

## Decision log

**D1. The working estimate is editable at any open status (2026-10-05).** This reverses the old rule, under which `withEstimate` threw past planning. `estimateMin`/`bufferMin` now change in the editor, through MCP `update_task`, and (piece 2) from Google. `estimateLockedMin` still snapshots at the first exit from planning (`machines.ts` `taskTransition`) and is never edited. Calibration compares actual against that lock, so you can't drag the estimate up to match actual and erase the gap.

- Done and cancelled tasks keep their estimate read-only, because it's history (the same rule as Due).
- "Remaining" (`taskMath.remainingMin`, the in-progress hero) uses the working estimate.

**D2. A split never cancels.** The original either finishes (`finish: 'done'`, only for a started task; the UI and MCP require an actual) or keeps going (`'keep'`, optionally renamed or rescoped). The rest becomes a new task. Dropping the rest is plain Cancel, a separate action.

- The new task carries the category, deadline (day and time), notes and `rollId`.
- It lands on the original's latest plan day if the original is `planned`/`in_progress` (a plan row with estimate + buffer, or 30 when unscoped). Otherwise it goes to the backlog. A past plan day self-heals: `getDay(today)`'s stale sweep moves the task back to backlog. The original's own row on that day is re-sized so the day's planned total counts the job once (`rescopedPlanMinutes`): a done part's row becomes its actual (what it really took), and a kept-going original that was rescoped gets its new estimate + buffer.
- `splitOriginal` validates the whole input before any write.

**D3 (superseded 2026-10-08 by parts.md D6 and D10). The family link needs a frozen baseline upstream, and there's no `splitRootId`.** B gets `splitFromId = A` only if A has a lock or is itself linked (`linksToFamily`). So a task with linked children always has a lock that predates all of them, and piece 3 can trust that the root's lock covers the whole job. Splitting an unstarted task gives two independent tasks, each its own fresh estimate. The root is found by walking `splitFromId` (`splitRoot`/`splitFamily`). Every consumer already loads the full task list, so a stored root would only be a denormalisation with no GSI to justify it. If piece 3 needs `family#<root>` queries at scale, add it then.

**D4. Calendar on a split** (detail in [calendar/index.md](../calendar/index.md) → Auto-sync → Split):

- **Done, timed:** the event moves to B, whatever placed it (a picked block too — a timed task's one block is its auto block).
- **Keep, timed:** each part owns a block, so two blocks end at the deadline. Piece 2 is how B's gets dragged earlier.
- **Manual events on an untimed A:** stay on A.
- **Owed removals:** carried out through the reporting path.

Write order on a done timed split: the original is saved unlinked, and then the follow-up is saved with the link. If the follow-up's write fails, the Google event is left orphaned but visible. The reverse order is worse: if the original's write failed, two tasks would point at one event, and a retry would duplicate the follow-up.

**D5. Rolls.** B inherits `rollId`, so finishing the rest tomorrow honestly counts as a rep tomorrow, and one pick can yield two reps. With a kept-going A, a roll has two open reps; `findOpenRollTask` re-plans the first. Harmless.

**D6 (superseded 2026-10-08 by parts.md D5: every part is a point, and so is the done parent). Interim calibration: split families are excluded.** A done A measured against the whole job's lock would read "overestimated" when you actually underestimated. So `isCalibrationPoint` leaves out every family member (A and B) until piece 3 scores the family as one point (root lock vs Σ actual). Excluding B too keeps the aggregate from jumping when piece 3 lands.

- Wired into both `getCalibration` impls and the editor's DeltaBar. The night review still **lists** a finished split part (it's a real task), as a plain row with its actual time and a "split" tag instead of the estimate-vs-actual bar. A task finished with no estimate gets the same plain row, tagged "no estimate".
- Older split rows predate `splitFromId`, read back `undefined`, and keep counting as before.

**D7 (pieces 2 and 3 are done or absorbed, see the header). What pieces 2 and 3 inherit.**

- Piece 2 writes only `estimateMin` from a Google start drag, and that write skips done/cancelled tasks (a done task still takes the end and title).
- ~~`calendar/research.md` still lists two-way sync under "don't build".~~ Revisited by piece 2: the entry now carves out events Aperture owns ([calendar → Two-way sync](../calendar/index.md)).
- Piece 3 computes the family point from `splitFamily` and drops the D6 exclusion.

Smaller build-time calls (file placement, write order, hint copy, focus, MCP strictness) are logged in the PR body.

## Surfaces

As of 2026-10-08 (parts.md D6 and D9):

- **Editor** (`TaskDetailsForm`): Estimate and Buffer render whenever the task is open; the lock line and the reseed-on-outside-change rule are in [task-editor.md](task-editor.md). The section label is Scope, then Rescope, then Details. A parent has no Split (it takes parts), and its estimate is read-only, the sum of its parts.
- **Split form** (`SplitForm`, phone-width stack):
  - a "Done with this part / Keep going" toggle, shown only for an in-progress task (otherwise keep only, with "Not started — each part gets its own estimate.");
  - **Deliverable (new)**, standalone only: the new parent's title, prefilled with the task's;
  - **This part** (title, prefilled "Part 1" when standalone, else its own; plus Actual or Estimate);
  - **Next part** (standalone; "Part 2") or **Remaining → new part of «parent»** (a part; "… (cont.)"), with an estimate prefilled so the parts add up to the working estimate (done: what's left; keep: half of what's left; each floored at 5);
  - a landing hint plus "Both parts: … · was …", and, standalone, "«title» keeps the due date; the parts carry the work."
  - Every title is editable before submit, so what's typed is what's stored. Done closes the modal. Keep collapses the reveal and returns focus to Split….
- **Header**: a part says "Part 2 of 3 of «parent» · due …", replacing the old "Split from / Split into" rows.
- **MCP**: `split_task` ([mcp/index.md](../mcp/index.md)); `update_task` rescopes started tasks.

## Build record (2026-10-05)

- **Shared:** `split.ts` (new) + `split.test.ts`; `Task.splitFromId`; `SplitTaskInput` and `splitTask(id, input)`; `canEditEstimate`/`withEstimate` relaxed; `splitFollowUp` moved from `machines.ts` to `split.ts`; contract cases (lock survives a rescope; done, keep, unstarted, chain and validation splits).
- **Lambdas:** `BackendClient.splitTask`/`getCalibration`; the `split_task` tool and description updates; calendar split tests (done moves the link, keep makes two blocks, a rescope of a started task re-times the event).
- **App:** `SplitForm` rewrite; `TaskDetailsForm`/`TaskEditor` (editable estimate, provenance rows, family-aware delta, focus); `taskMath` (`remainingMin`, `scopeLabel`, `splitDefaults`); `RightNowCard`, `ReviewCard`, `TaskCard`; stub parity; a seeded split family ("Write the literature review").
