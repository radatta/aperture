# Task editor modal

The task **detail-and-edit modal**: tap a task's title (or its Scope/Done button) and the whole task
opens in one surface — the full title, every field, and every manage action. It replaces the card's
old inline edit panels + overflow ("hamburger") menu.

## Why it exists

Card rows truncate the title (`truncate`, CSS-only — the full string was always in the DOM), and
editing a task meant a stack of collapse-in-place panels reached through an overflow menu. Two
problems: you couldn't read a long title, and editing was spread across per-panel forms on the card.

The modal fixes both and is **context-independent** — the same detail view can open from anywhere a
task title appears (a card, a Home row), which an inline panel can't, since it only works where a card
can grow. The task's field set is expected to grow, and a dedicated surface absorbs that better than an
ever-taller card.

## Shape

```
card (lifecycle only)                     modal (everything else)
──────────────────────                    ──────────────────────────────
title ── opens ──▶ ┐                       full title (read-only for now)
Scope (if unscoped)┤                       status · category · recurs
Start / Focus / Done ┘                     Details  — estimate/buffer/category/due (+ time), notes (Save)
+ section actions slot                     Time     — logged/remaining/locked/timestamps/Δ (read-only)
                                           Files · Calendar
                                           Manage   — Split / Drop / Delete
```

The card keeps only the actions you press without thinking. No overflow menu.

## Decisions + why

- **Built on the existing `components/Modal`, not a new primitive.** That Modal is a native `<dialog>`
  + `showModal()`, which gives the browser top layer (renders over the fixed dock, no z-index/inert
  work), focus containment, Escape, and a `::backdrop` scrim for free. Rolling our own portal/focus
  trap would have re-owned exactly the "subtle correctness" the native element already handles.
- **The card slims to lifecycle; the modal is the edit surface.** Start/Focus/Done stay on the card;
  scope/split/due/calendar/files/drop/delete all move into the modal. One editing context, not two.
- **The full title is an editable field.** It's a `Textarea` at the top of the details form, so a long
  title reads unclipped (the original complaint) *and* edits in place — settable at any status, since a
  title is display text that never touches the calibration lock (`setTaskTitle`). Blank is rejected
  (Save disables). This shipped in a second pass, after the branch rebased onto `#25` (the MCP server
  merge) which brought the `setTaskTitle` contract to `main`; the first pass left the title read-only
  to keep this change app-only until that method existed.
- **Changes from elsewhere reseed untouched fields** (2026-10-05). When the task changes outside the form (a split's rename or rescope, another device, the MCP), every field still showing the previous value takes the new one, during render so nothing flashes dirty. Edits in progress stay.
- **Single diff-driven Save, and Save stays open.** The details form writes only what changed,
  sequentially (the old `ScopePanel.save` pattern), then **keeps the modal open**: it reseeds every
  field from the task the last write returned, puts notes back in their rendered view, and shows a
  quiet "Saved" until the next edit (a failure keeps the edits and says "Couldn't save"). Until the
  refetch lands, the form compares against that returned task (newer `updatedAt` wins), so nothing
  reads dirty or flashes old values in between. Save is `aria-disabled` rather than `disabled` when
  there's nothing to save, so a keyboard user keeps focus on it. The earlier "Save closes" was never
  wanted (2026-09-27) — only Close / Esc / backdrop, Mark done, Drop and Delete leave. Estimate + buffer (the working estimate) are **editable at any
  open status** since 2026-10-05 ([split.md](split.md) D1) — the calibration baseline frozen at start is
  separate and never moves; the form says "Started at 45m — calibration is measured against that." (a split-family member: "— split, so it isn't measured on its own"). They
  go **read-only once done or cancelled** (`canEditEstimate`; `withEstimate` throws there). Category stays editable at any status (no machine guard); **due locks
  once the task is done or cancelled** — a UI rule (`isTerminal` in `TaskDetailsForm`), since re-dating
  history is meaningless.
- **Done opens the modal in a finish intent** (actual-minutes capture, `DoneForm` reused) focused on
  the Actual field. Scope opens it focused on Estimate. `TaskModal` owns that focus effect — it sits a
  parent above `Modal`, so its effect runs *after* `showModal()` (child effects fire first), the same
  ordering `BulkAddDialog` relies on.
- **Drop and Delete moved into the modal.** Drop gained a confirm strip (`DropConfirm`) it didn't have
  as a menu item — `cancelled` is terminal and it sits next to Delete, so a misclick is costly. All
  gates are the card's, moved verbatim: Drop only when `canScope`; Delete hidden when `seriesId !==
  null` (a recurring occurrence respawns — Drop is the right tool). Reveals are exclusive, one level.
- **The "not scoped" cue + Scope button stay on the card.** Removing the always-visible Scope button
  would have dropped the only "this task is unscoped" signal and made scoping — the morning-pass
  signature move — a title-tap→edit→Save instead of one tap. An unscoped backlog task keeps a quiet
  "not scoped" meta line and a `Scope` button that opens the modal on the Estimate field.
- **The page hosts the modal, not the row.** Save staying open means a save can move its row out of
  the list (a due date moves Backlog → Week, a rename leaves a search, a category change leaves a
  filter); a row-owned modal would vanish with it. `TaskModalHost` (on `/tasks`, around the lens
  content) renders the one `TaskModal`, reading the task live from the tasks query by id; rows open it
  through `useOpenTask` (a `TaskCard` outside any host hosts itself). It also closes the modal when the
  task leaves the list while open — Delete has no `onDone`, and a delete can come from MCP or another
  device.
- **Focus-return via `useDisclosure`.** Native `<dialog>` restores focus to the invoker on `close()`,
  but the jsdom test stub doesn't, and CONVENTIONS mandates `useDisclosure` — so the host holds one
  disclosure whose `triggerRef` is the opening row's title button; every opener (title/Scope/Done)
  returns focus there on close. If a save re-rendered the row (moved it to another group), its title
  is found again by task id (`data-task-id`); if the row has left the list, focus goes to the list
  area instead of `<body>`. While a save is in flight the form doesn't report dirty (closing then
  lets the save finish rather than offering a false "Discard"), and typing during it is kept — only
  fields untouched since Save are reseeded. After a mouse/touch close the focus comes back without the ring (only Tab counts as
  keyboard navigation), so the title doesn't sit outlined until you click elsewhere.
- **Click-outside closes, but an unsaved edit confirms first.** The task modal opts into backdrop-close
  (an opt-in `closeOnBackdrop` flag on the shared `Modal`, so paste-heavy dialogs like bulk-add stay
  unaffected). Every *exit* path — Esc, backdrop, the Close button — routes through `requestClose`,
  which pops a "Discard changes?" confirm (a second `<dialog>` stacked on top) when the details form is
  dirty. A *real action* (Mark done / Drop / Delete) closes without the prompt, since it isn't an
  abandon; Save doesn't close at all. "Dirty" is the details form only (title/estimate/category/due/notes); the Split/Calendar reveal
  forms have their own Cancel. Backdrop-close requires press *and* release on the backdrop, so a
  text-selection drag-out can't dismiss.

- **Notes live in the details form** ([notes.md](notes.md)): rendered, with Edit / "Add notes…";
  once editing, a textarea until Save (which shows the rendered note again) or Close. Editable at any status, like the title.

## Non-goals / deferred

- **Rename sync** — renaming a task does *not* rename its recurring series template. Its linked Google
  Calendar event *is* renamed when auto-sync is on (since 2026-10-05 — `docs/areas/calendar/` → Auto-sync).
- **Home rows** are not yet wired to the modal. `TaskTitleButton` is the seam — those truncated title
  spots can adopt it later with no new plumbing. (On `/tasks` every row is a `TaskCard`, and a click
  anywhere on the row opens the modal.)

## Build record

- New: `modules/tasks/editor/` (`TaskEditor`, `TaskDetailsForm`, `SplitForm`, `AddToCalendarForm`,
  `DeleteConfirm` + `DropConfirm`), `TaskModal`, `TaskTitleButton`.
- Later (2026-09-27): `TaskModalHost` + `task-modal-context` (page-level modal), Save stays open
  (`TaskDetailsForm`), quiet focus return (`useDisclosure`).
- Changed: `TaskCard` (rewritten slim), `TaskMeta` ("not scoped" cue), `taskMath` (`statusLabel`,
  `scopeLabel`), `format` (`fmtDateTime`), `Field` (ref prop), `DoneForm` (`actualRef`),
  `useTasks` (`useSetTaskTitle`), `dates` (`localEpochFromDayTime`).
- Deleted: `ScopePanel` (absorbed into `TaskDetailsForm`).
- Tests: `TaskEditor.test.tsx`, migrated `TaskCard.test.tsx` (menu flows → modal flows), plus
  `taskMath`/`format` helper tests. Full app suite green.
