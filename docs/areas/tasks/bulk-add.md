# Bulk Add Tasks

A "Bulk add" button on the Tasks-page header opens a modal: paste many lines, one task per line, each
line optionally carrying inline tokens (`~estimate #category due:date notes:"…"`). A live preview parses as you
type — red errors gate submit, gold warnings don't. All lines commit in one batch as `backlog` tasks.
The same grammar, one line at a time, also works in the capture bar's Task mode (§2, 2026-09-28).

**The operator is Claude, not thumbs.** Rahul asks Claude to generate the paste; he does not hand-type
it. That single fact drives the whole design: the grammar is strict and concrete (no natural-language
dates, no silent rewrites), verbose is fine, ambiguity is not. The [operator reference](#operator-reference)
below is the load-bearing part of this doc — Claude reads it before generating a paste.

## 1. Why

Batch entry is the *morning plan pass*, not capture (PRODUCT §2). The global capture bar is deliberately
structure-free — it never asks for estimate/category/due. Bulk add is the opposite surface: a deliberate,
reviewable sit-down where structure is welcome. So tokens-at-entry here is not a violation of the
capture rule; it's the plan pass wearing a keyboard.

Capture later took the same grammar as an *optional* single line (2026-09-28): typing `#Aperture` at
capture time was wanted, and an opt-in token asks nothing of a bare capture.

## 2. Decision log

- **Dedicated modal, not the capture bar.** The capture bar stays structure-free (its whole premise).
  Bulk add is a separate, roomy surface — the app's first `<dialog>`. *Superseded in part 2026-09-28:*
  bulk add is still the many-lines surface, but capture's Task mode now takes one line of the grammar.
- **Capture tokens (2026-09-28).** Task mode only; Log and Idea are untouched.
  - **Gated on ` | ` in the raw text.** Without it nothing is parsed — `a|b`, `- milk`, `fix #42 ~5`
    save literally, exactly as before. The raw (not trimmed) text, so `milk | ` is the red "nothing
    after" error rather than a task titled `milk |`. Cost: a capture title can no longer contain ` | `.
  - **Never fails silently.** A red error refuses Enter *and* the Send tap, keeps the text, and the
    receipt says "Not saved" (the full reason is in the preview row, and in the status
    region for screen readers). Send is `aria-disabled`, not `disabled`, so a tap still explains. The
    notice clears once its cause is gone (line fixed, categories arrived, mode switched). Gold warnings
    show in the preview row before submit and don't block.
  - **One line only.** Tokens plus a line break is red — splitting would turn one capture into N tasks,
    truncating would drop text. Bulk add takes many. Multi-line captures *without* ` | ` are unchanged.
  - **Waits for categories.** A `#label` line before the list first loads is refused ("Loading
    categories…", or a red "couldn't load" on a query error) instead of parsing as unknown and landing
    uncategorised — the dialog's guard, keyed on *having data* rather than `isSuccess`, so a failed
    background refetch over a good cached list doesn't refuse. Label-free lines save meanwhile.
  - **No duplicate-title warning** — repeating a title is normal in quick capture, and it would need
    the full task list in an always-mounted component.
  - **"→ today" composes:** the estimate flows into `plannedMinutes` via `plannedDefault`.
  - The placeholder stays "New task…" — teaching syntax there is the structure prompt §2 forbids.
- **Token autocomplete in capture (2026-09-30).** Chips under the field complete the token under the
  caret; a tap (or Tab) types the *literal* token, so the grammar and parser are unchanged.
  - **Only once a token is started** — `#`, `~` or `due:` after the first ` | `, never inside
    `notes:"…"`. No starter chips at an empty position: a bare `~ # due:` row is a structure prompt
    (PRODUCT §2), and it would claim Tab everywhere after ` | `.
  - **`#`** — active categories, case-insensitive **word-start** match (`#work` → Deep Work; `#e`
    doesn't light up everything), in category order. Multi-word labels insert `#"Deep Work"`; a label
    containing `"` is omitted (the grammar can't write it). Nothing shows until categories load — the
    preview row already says so.
  - **`due:`** — Today, Tomorrow, the first five Mon–Fri days in today+1..+7, and +1 week, deduped by
    day. Labels tier like `fmtDueDay` (weekday for +2..+6, `Oct 7` for +7), inserted as ISO. Built by
    `duePresets(todayKey(dayStartHour))`, so the rollover is `todayKey`'s job. Typed digits filter.
    Once the day is whole (caret at the end of `due:2026-10-09`) or carries an `@`, the chips switch to
    **times** — 9am · 12pm · 5pm · 11:59pm (`DUE_TIME_PRESETS`), filtered by what follows the `@`, each
    typing the full `due:<day>@HH:MM` ("Due Friday, Oct 9 at 5pm"). Added 2026-10-05.
  - **`~`** — fixed 15 · 30 · 45 · 60 · 90 · 120, filtered by digit prefix.
  - **Keys:** Tab accepts the first chip while chips show, else cycles mode; Shift+Tab always cycles
    (the escape hatch). No arrow-key highlight — arrows move the caret in a textarea; type one more
    letter to narrow. Escape and Enter unchanged.
  - **A11y:** a `role="group"` of plain buttons, not a combobox (no highlight to promise, and the
    textarea already carries `aria-describedby`/`aria-invalid`). Not a live region — it changes per
    keystroke. Each chip has a standalone name ("Estimate 15m", "Due Friday, Oct 2") since "15m" or
    "Fri" alone means nothing. Chips `preventDefault` on mousedown so an iPhone tap keeps the keyboard
    up. Tab is ignored mid-IME-composition.
  - **Caret placement is keyed on an accept nonce, not the text** — accepting an already-complete token
    changes nothing, and a text-keyed effect would skip it and jump the caret on the next keystroke.
- **Explicit ` | ` separator** (space-pipe-space) between title and tokens. The one grammar with zero
  ambiguity: a `#`/`~`/`due:` in a *title* is literal and never parsed; any junk after the pipe is a
  loud red error. Cost: a title can't contain ` | ` (it errors; the operator re-emits). Chosen over
  trailing-tokens ("fix issue #42" silently reading `#42` as a category).
- **ISO-only dates, no keywords.** `due:2026-09-25` only — no `fri`/`tomorrow`. The operator is Claude,
  which knows today's date and emits a concrete one; friendly shortcuts buy nothing and add ambiguity.
- **Due time as an `@HH:MM` suffix (2026-10-05).** `due:2026-09-25@17:00` — 24h, zero-padded, no
  `am`/`pm`, same strictness. A suffix on the one `due:` token (not a separate `at:` token) because a time
  only means something on its day ([due-dates.md](due-dates.md) D1 revisited).
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
- **Notes are one quoted token, `notes:"…"`, with two escapes: `\n` and `\\`.** A paste is one line
  per task, so a multi-line note needs `\n` (the one Claude already emits). `\\` is a literal
  backslash — without it `\nabla` or `C:\new` would silently become a newline. No `"` inside (reword,
  or use `'`) — a `\"` escape buys little and doubles the ways to get it wrong. Over the
  5,000-character cap is red here, before submit, and the server rejects the whole batch anyway
  ([notes.md](notes.md)). A `notes:"` in the *title* (the ` | ` was forgotten) is legal but gold.
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

- `CreateTaskInput` grew `dueDay?: string | null` (single create still passes null), and later
  `notes?: string | null` (see [notes.md](notes.md)).
- New RPC `createTasks(inputs: CreateTaskInput[]) → Task[]`, inserted after `createTask` in `API_METHODS`.
- `repo.putTasks` → `writes.batchPut`. `noopWrites.batchPut` already no-ops, so a testMode/smoke run
  writes nothing.
- The parser is pure and lives in `packages/shared/src/bulkTasks.ts` (`parseBulkTasks`, `toCreateInputs`)
  — the contract package, so a future non-browser operator (CLI/MCP) posts the same grammar. Capture
  uses `hasTaskTokens` (the ` | ` gate), `parseTaskLine` (one line, red on a line break) and
  `toCreateInput`; still one validator. `useCreateTask` / `createToday` take `string | CreateTaskInput`.
  The chip preview is `app/src/modules/tasks/TaskTokenChips.tsx`, shared by both surfaces. `isDayKey`
  (the `due:` validator) is in `packages/shared/src/dates.ts`.
- Autocomplete: `tokenAtCaret` sits beside `scanTokens` in `bulkTasks.ts` (spans, so it shares the
  quoting rules exactly) and `duePresets` in `dates.ts`; the chip builders and `applySuggestion` are
  app-side in `app/src/modules/capture/suggestions.ts`, rendered by `TokenSuggestions.tsx`.

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
             due:<YYYY-MM-DD>@<HH:MM>  + a 24h deadline time   e.g. due:2026-09-25@17:00
             notes:"<text>"    quoted; \n = a newline    e.g. notes:"Ch. 4\nq6: use the lemma"
```

The `notes:"…"` value is the task's notes (light markdown — see [notes.md](notes.md)). Inside the
quotes everything is literal: `~30`, `#Admin`, `due:…`, even ` | `. Two escapes: `\n` becomes a
newline and `\\` a literal backslash — so write LaTeX and Windows paths with doubled backslashes
(`\\nabla`, `C:\\new`), or a `\n` inside them turns into a line break. The value is trimmed, and must
be at most 5,000 characters after unescaping.

Rules that produce a **red error** (blocks the entire submit — fix or remove):
- empty title; a leading list marker (`- `, `* `, `1. `); a `|` in the title; ` | ` with nothing after it
- `~` that isn't a whole minute ≥ 1 (`~30m`, `~0`, `~1.5`, `~`)
- `due:` that isn't a real ISO date (`due:2026-02-30`, `due:2026-2-5`); a capitalized `Due:`
- an `@` time that isn't zero-padded 24h `HH:MM` (`@5pm`, `@5:00`, `@24:00`, a bare `@`)
- an unterminated `#"quote`; a label that matches two categories; any unrecognized token
- the same kind of token twice on one line
- `notes:` without quotes; an unterminated `notes:"…`; empty notes (`notes:""`); a `"` inside the
  notes; notes over 5,000 characters; a capitalized `Notes:`

Rules that produce a **gold warning** (task still created):
- a `notes:"` inside the title — the ` | ` before it was probably forgotten
- `#label` matches no category → created uncategorised
- a title duplicated within the paste, or already held by a live task

Good paste:
```
email coach
finish 214 pset | ~90 #"Deep Work" due:2026-09-25@17:00
book flight | due:2026-10-02
review the RFC | ~45 #Admin
read ch. 4 | ~30 notes:"q1–8\n- q6: use the lemma\nhttps://example.edu/pset4"
```

The category labels are shown live in the dialog header — read the valid set off the screen.

**In capture (Task mode):** exactly one line of the above, one task per capture — e.g.
`draft memo | ~30 #Admin due:2026-10-03`. Same red/gold rules, minus the duplicate-title warning; a
line break alongside ` | ` is red. The suggestion chips are a thumb aid that type these same tokens —
the contract above is unchanged.

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

**Due times (2026-10-05):** the `@HH:MM` suffix in `parseLine` (`isTimeKey`), `BulkLine.dueTime` →
`toCreateInput`; time chips in `suggestions.ts`; `TaskTokenChips` shows the time. A timed line is
auto-synced to the calendar by `createTasks` ([calendar → Auto-sync](../calendar/index.md)). Tests:
parse/red cases, literal inside notes, the caret token after `@`, and a `CaptureBar` chip → task case.

**Capture tokens (2026-09-28):** shared `hasTaskTokens`/`parseTaskLine`/`toCreateInput` (+ tests);
`useCreateTask` and `createToday` widened to `string | CreateTaskInput`; `CaptureBar` preview row +
refusal notice; `TaskTokenChips` extracted from `BulkAddDialog`. Tests: parser parity with
`parseBulkTasks`, and `CaptureBar` cases for parse, literal bare titles, refused red/Send, unknown
label, "→ today" minutes, categories loading, failed refetch over cached data, line break, refusal
announce + clear, and failure-restores-text.

**Token autocomplete (2026-09-30):** shared `scanTokens` → spans + `tokenAtCaret`, `duePresets`
(+ tests: caret table incl. quotes/notes/second ` | `; presets across weekdays, year end, DST,
day-start rollover); app `suggestions.ts` (+ test), `TokenSuggestions.tsx`, `CaptureBar` caret
tracking + Tab. `CaptureBar` cases: tap completes + keeps focus, word-start + quoting, due chips under
a fixed clock, Tab accept vs mode cycle, Shift+Tab, none outside a token, mid-line completion,
no-op accept places the caret (fails against the text-keyed version), standalone chip names, Escape
still blurs.

## 6. Deferred / out of scope

- A formal `{created, failed}` per-line failure report (additive to `createTasks` if partial failures
  ever show up in practice).
- Setting `bufferMin` from a token (bulk sets estimate only).
- A `\"` escape inside `notes:"…"` (reword, or use `'`).
- Per-line editing in the preview (fix the textarea instead — it's a paste, re-pasting is free).
- Capture autocomplete: `~` presets ordered by what I actually use / calibration history (fixed for
  now); starter chips at an empty token position; completing the `due:` keyword from `d`; an
  arrow-key highlight.
