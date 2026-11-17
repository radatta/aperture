# Task reflection

One optional line on a finished task, in your own words: what went well, what you'd do differently, where
the time went ("should have outlined first — the rewrite ate the time"). It's written where the actual is,
on the Done form, and read back beside the estimate-vs-actual delta, so the number has its reason next to it.

## 1. Shape

- **Field:** `Task.reflection: string | null`, capped at `TASK_REFLECTION_MAX` (1,000 characters,
  `.length`). Empty is `null`. Rows written before it existed read back `undefined`, so readers check
  `!task.reflection`. No migration.
- **Contract:**
  - `setTaskActual(id, actualMin, reflection?)` saves it in the same write as the actual. `undefined`
    keeps the current one, `null` clears, and a string is normalized. Over the cap rejects and writes
    nothing, the actual included. The http client drops a trailing `undefined`, so over the wire a
    two-argument call keeps it too.
  - `setTaskReflection(id, reflection | null)` edits it at any status. A missing value is an error, never
    a silent clear, as with `setTaskNotes`.
  - `CalibrationPoint.reflection` carries it, so a calibration read gets the why with the delta.
- **Normalizing:** every writer runs `normalizeReflection` (`packages/shared/src/taskNotes.ts`, beside
  `normalizeNotes`): CRLF → LF, trim, `''` → `null`, over the cap throws. The behaviour is in the
  cross-impl contract suite (stub + Lambda + handler); the normalizers are unit-tested in `taskNotes.test.ts`.
- **Semantics:**
  - Never part of the estimate lock.
  - Cancel keeps it; delete tombstones it with the row; export carries it on `tasks[]`.
  - Every spawn path starts it `null`: a split's new parent and follow-up (the original keeps its own,
    since the reflection is about the finished work), series occurrences and roll reps.
  - A done parent takes one in the editor or through MCP, after its parts' rollup.
  - An errand checked off over MCP without an actual takes one after the check-off (there's no
    `setTaskActual` for it to ride); a failure there says the task is done, so a retry goes to `update_task`.
- **Markdown:** the notes subset ([notes.md](notes.md) §2), rendered by the same `NotesView`.

## 2. Surfaces

- **Done form** (`DoneForm.tsx`, also on Home's Right now and Flux's rep tie):
  - An optional Reflection textarea under Actual, 16px, placeholder "How did it go? Optional."
  - Focus stays on Actual (Home's Right now focuses it on Done, as the task modal does).
  - Left as it was seeded, it isn't sent, so one saved meanwhile (MCP, another device) is kept; cleared,
    it sends `null`.
  - In the task modal, a changed reflection joins the dirty guard (its own `finish` slot), so Esc,
    backdrop or Cancel ask before it's lost.
  - A counter shows from 900; over 1,000 it turns red and Mark done disables (no `maxLength`, so a paste
    is never silently cut).
  - A failed Mark done keeps the text.
- **Task editor** ([task-editor.md](task-editor.md)):
  - A Reflection block under Notes in the details form, shown on a done task or any other that already
    has one — except one in progress, whose Done form holds it. An open task without one shows nothing.
  - It's the notes field with its own label, cap and copy (`NotesField`): rendered with an Edit button, or
    "Add a reflection…" when empty.
  - It joins the form's one Save (which keeps the modal open) and the dirty guard, only while being edited.
- **Night review** (Home → Today in review): one muted, italic, truncated line of plain text (markers
  dropped, `notesPlainText`) under each done task's delta bar or no-estimate row. Nothing when there's none.
  An errand isn't listed there (places.md D3), so its reflection reads in the task modal and over MCP only.
- **MCP** ([mcp/index.md](../mcp/index.md)):
  - `complete_task {…, reflection?}` saves it with the actual.
  - `update_task {…, reflection}` replaces or clears it.
  - `list_tasks`, `list_backlog` and `get_calibration` return it.
  - The tool text says to record it only in the user's own words, never invented or summarised.

## 3. Decisions

- **One field, not a comment thread** (2026-11-03). A per-task thread (`comment#task#<taskId>#<ulid>`,
  with `author` and `kind`) was weighed and parked: the user's real use is a single look back at
  completion, and Claude's progress updates already live in PR bodies and reports. If a thread is built
  later, this field becomes its first row (`kind: 'reflection'`, `createdAt = completedAt ?? updatedAt`),
  a one-time copy.
- **On every Done, always optional.** No delta threshold: a threshold is a hidden "you're over" judgment
  and hides the under-estimates. No badge, no nag.
- **Named "reflection"**, not `actualNote`: it's wider than the time gap, and it matches the night
  ritual's vocabulary (`Day.reflectionText`). Sayable by voice ("add a reflection to the pset").
- **Not on split** (v1): the split form is already dense; the original takes one in the editor after.

## 4. Deferred

- A weekly Haiku pass that groups reflections into patterns ("lab write-ups run long"), from
  `get_calibration`. Would run on the free API credit.
- Reflection on `split_task {finish: "done"}`.
- Search over reflections.
- Typing a reflection, then finishing the task another way (Drop, a split that finishes it) closes the
  modal without asking: the Done form unmounts, so its edit slot reads clean. An Actual typed there was
  already lost the same way.
- Closing while a Mark done is in flight never waits, so a failed save loses the actual and the reflection
  without an error. The slot would have to report `saving`, and leaving mid-finish closes at once by design.
