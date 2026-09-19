# Bulk Add Tasks

A "Bulk add" button on the Tasks-page header opens a modal: paste many lines, one task per line, each
line optionally carrying inline tokens (`~estimate #category due:date`). A live preview parses as you
type — red errors gate submit, gold warnings don't. All lines commit in one batch as `backlog` tasks.

**The operator is Claude, not thumbs.** Rahul asks Claude to generate the paste; he does not hand-type
it. That single fact drives the whole design: the grammar is strict and concrete (no natural-language
dates, no silent rewrites), verbose is fine, ambiguity is not. The [operator reference](#operator-reference)
below is the load-bearing part of this doc — Claude reads it before generating a paste.

## 1. Why

Batch entry is the *morning plan pass*, not capture (PRODUCT §2). The global capture bar is deliberately
structure-free — it never asks for estimate/category/due. Bulk add is the opposite surface: a deliberate,
reviewable sit-down where structure is welcome. So tokens-at-entry here is not a violation of the
capture rule; it's the plan pass wearing a keyboard.

## 2. Decision log

- **Dedicated modal, not the capture bar.** The capture bar stays structure-free (its whole premise).
  Bulk add is a separate, roomy surface — the app's first `<dialog>`.
- **Explicit ` | ` separator** (space-pipe-space) between title and tokens. The one grammar with zero
  ambiguity: a `#`/`~`/`due:` in a *title* is literal and never parsed; any junk after the pipe is a
  loud red error. Cost: a title can't contain ` | ` (it errors; the operator re-emits). Chosen over
  trailing-tokens ("fix issue #42" silently reading `#42` as a category).
- **ISO-only dates, no keywords.** `due:2026-09-25` only — no `fri`/`tomorrow`. The operator is Claude,
  which knows today's date and emits a concrete one; friendly shortcuts buy nothing and add ambiguity.
- **Quoted multi-word labels:** `#"Deep Work"`. What's between the quotes is the label; only case is
  folded to match.
- **`#label` no-match is a warning, not an error.** The task is created uncategorised (categoryId null);
  the preview flags it gold. Categories are a small managed set — never auto-created from a paste. An
  *ambiguous* label (two categories collide case-insensitively) IS a hard error.
- **Titles are never rewritten.** A leading list marker (`- `, `1. `) is a hard error, not a silent
  strip — a hidden transform is worse than a loud stop.
- **Red gates, gold doesn't.** A token that declares intent but can't be parsed (`due:garbage`, `~30m`)
  is red and blocks the whole submit. A token that parses but doesn't match (`#unknown`) is gold and
  submits. Duplicate titles (in-paste, or against a live task) are gold — safe re-submit after a failure.
- **One `createdAt` stamp per batch.** `listTasks` sorts `createdAt` desc, stably; a shared stamp + the
  monotonic ULID factory makes the batch render as one top block in paste order.
- **Best-effort batch write, not a transaction.** `createTasks` goes through the existing `writes.batchPut`
  seam (single audit point, one round-trip). DynamoDB `BatchWriteItem` is not atomic, so this is
  best-effort — but `LiveDoc.batchPut` now retries `UnprocessedItems` (it previously dropped them), which
  closes the only silent-loss path at single-user volume. On a hard failure the dialog stays open, text
  intact, and the "already exists" warnings mark exactly what landed. `TransactWriteItems` (true
  atomicity) was rejected: capped at 100 items, a new op in three impls, for a failure mode that doesn't
  occur at this scale. Upgrading to a formal `{created, failed}` report later is additive.

## 3. Data / RPC

- `CreateTaskInput` grew `dueDay?: string | null` (single create still passes null). No change to `Task`.
- New RPC `createTasks(inputs: CreateTaskInput[]) → Task[]`, inserted after `createTask` in `API_METHODS`.
- `repo.putTasks` → `writes.batchPut`. `noopWrites.batchPut` already no-ops, so a testMode/smoke run
  writes nothing.
- The parser is pure and lives in `packages/shared/src/bulkTasks.ts` (`parseBulkTasks`, `toCreateInputs`)
  — the contract package, so a future non-browser operator (CLI/MCP) posts the same grammar. `isDayKey`
  (the `due:` validator) is in `packages/shared/src/dates.ts`.

## 4. Operator reference

**This is a spec Claude reads before generating a bulk paste — treat it as the contract, not prose.**

```
One task per line. A line is:   <title>[ | <tokens>]

  title    literal text, trimmed, non-empty. '#' '~' 'due:' are LITERAL here — not parsed.
  |        the separator is exactly ' | ' (space pipe space). Omit it if there are no tokens.
  tokens   one or more, whitespace-separated, EACH KIND AT MOST ONCE, any order:
             ~<minutes>        whole integer >= 1        e.g. ~30      (estimate; stays unlocked)
             #<label>          single word               e.g. #Admin
             #"<label>"        multi-word, quoted        e.g. #"Deep Work"
             due:<YYYY-MM-DD>  real calendar date, ISO   e.g. due:2026-09-25
```

Rules that produce a **red error** (blocks the entire submit — fix or remove):
- empty title; a leading list marker (`- `, `* `, `1. `); a `|` in the title; ` | ` with nothing after it
- `~` that isn't a whole minute ≥ 1 (`~30m`, `~0`, `~1.5`, `~`)
- `due:` that isn't a real ISO date (`due:2026-02-30`, `due:2026-2-5`); a capitalized `Due:`
- an unterminated `#"quote`; a label that matches two categories; any unrecognized token
- the same kind of token twice on one line

Rules that produce a **gold warning** (task still created):
- `#label` matches no category → created uncategorised
- a title duplicated within the paste, or already held by a live task

Good paste:
```
email coach
finish 214 pset | ~90 #"Deep Work" due:2026-09-25
book flight | due:2026-10-02
review the RFC | ~45 #Admin
```

The category labels are shown live in the dialog header — read the valid set off the screen.

## 5. Build record

Page-first, one atomic contract change so `tsc -b` stays green. ~20 files across four packages:

- **shared:** `bulkTasks.ts` (+ test), `isDayKey` in `dates.ts` (+ test), `CreateTaskInput.dueDay` +
  `createTasks` in `api.ts`, `'createTasks'` in `rpc.ts`, `createTasks` contract cases, barrel export.
- **app:** `components/Modal` (native `<dialog>` primitive, first in the app), `modules/tasks/BulkAddDialog`
  (+ test), `useCreateTasks` in `useTasks.ts`, header button + disclosure + receipt in `pages/Tasks`,
  a `ref` on the `Textarea` primitive and an `id` on `Text`, a `showModal`/`close` jsdom stub in
  `test/setup.ts`.
- **lambdas:** `createTasks`/`newTask` in `backend.ts`, `putTasks` in `repo.ts`, `UnprocessedItems`
  retry in `LiveDoc.batchPut`.

Tests: parser table-driven unit tests; `isDayKey`; `createTasks` in the cross-impl contract suite (stub
+ lambda + handler); a `BulkAddDialog` integration test (gating, submit-in-order, warning-still-submits,
cancel-drops-draft + focus-return, failure-keeps-text).

## 6. Deferred / out of scope

- A formal `{created, failed}` per-line failure report (additive to `createTasks` if partial failures
  ever show up in practice).
- Setting `bufferMin` from a token (bulk sets estimate only).
- Per-line editing in the preview (fix the textarea instead — it's a paste, re-pasting is free).
