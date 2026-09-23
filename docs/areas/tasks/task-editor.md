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
Start / Focus / Done ┘                     Details  — estimate/buffer/category/due (Save)
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
- **Single diff-driven Save.** The details form writes only what changed, sequentially (the old
  `ScopePanel.save` pattern), then closes. Estimate + buffer are **read-only once work has started** —
  `canEditEstimate` (backlog|planned only), because the machine freezes the calibration baseline and
  `withEstimate` throws past that. Category + due stay editable at any status (no machine guard).
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
- **Focus-return via `useDisclosure`.** Native `<dialog>` restores focus to the invoker on `close()`,
  but the jsdom test stub doesn't, and CONVENTIONS mandates `useDisclosure` — so the card holds one
  disclosure whose `triggerRef` is the title button; every opener (title/Scope/Done) returns focus
  there on close.
- **Click-outside closes, but an unsaved edit confirms first.** The task modal opts into backdrop-close
  (an opt-in `closeOnBackdrop` flag on the shared `Modal`, so paste-heavy dialogs like bulk-add stay
  unaffected). Every *exit* path — Esc, backdrop, the Close button — routes through `requestClose`,
  which pops a "Discard changes?" confirm (a second `<dialog>` stacked on top) when the details form is
  dirty. A *real action* (Save / Mark done / Drop / Delete) closes without the prompt, since it isn't an
  abandon. "Dirty" is the details form only (title/estimate/category/due); the Split/Calendar reveal
  forms have their own Cancel. Backdrop-close requires press *and* release on the backdrop, so a
  text-selection drag-out can't dismiss.

## Non-goals / deferred

- **Rename sync** — renaming a task does *not* rename its recurring series template or its linked
  Google Calendar event. Calendar edit-sync is already a deferred gap (`docs/areas/calendar/`).
- **Home rows** are not yet wired to the modal. `TaskTitleButton` is the seam — those truncated title
  spots can adopt it later with no new plumbing. (On `/tasks` every row is a `TaskCard`, and a click
  anywhere on the row opens the modal.)

## Build record

- New: `modules/tasks/editor/` (`TaskEditor`, `TaskDetailsForm`, `SplitForm`, `AddToCalendarForm`,
  `DeleteConfirm` + `DropConfirm`), `TaskModal`, `TaskTitleButton`.
- Changed: `TaskCard` (rewritten slim), `TaskMeta` ("not scoped" cue), `taskMath` (`statusLabel`,
  `scopeLabel`), `format` (`fmtDateTime`), `Field` (ref prop), `DoneForm` (`actualRef`),
  `useTasks` (`useSetTaskTitle`), `dates` (`localEpochFromDayTime`).
- Deleted: `ScopePanel` (absorbed into `TaskDetailsForm`).
- Tests: `TaskEditor.test.tsx`, migrated `TaskCard.test.tsx` (menu flows → modal flows), plus
  `taskMath`/`format` helper tests. Full app suite green.
