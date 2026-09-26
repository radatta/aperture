# Task notes

A free-form `notes` field on every task — the context a title can't hold: links, a checklist, which
questions are the hard ones. Written in a small subset of markdown, rendered in the task editor, found by
search, and settable from bulk add and MCP. The row never shows the text, only a quiet marker.

## 1. Shape

- **Field:** `Task.notes: string | null`, capped at `TASK_NOTES_MAX` (5,000 characters, `.length`).
  Empty is `null`, like the sibling nullable fields. Rows written before notes existed have no attribute
  and read back `undefined`, so readers check `!task.notes`. No migration.
- **Contract:** `setTaskNotes(id, notes | null)`, plus `CreateTaskInput.notes`. Every writer runs
  `normalizeNotes` (`packages/shared/src/taskNotes.ts`): CRLF → LF, trim, `''` → `null`, over the cap
  throws. `createTasks` normalizes every input before writing any, so one bad input creates nothing.
  The behaviour is in the cross-impl contract suite (stub + Lambda + handler); `normalizeNotes` itself
  is unit-tested in `taskNotes.test.ts`.
- **Semantics:** editable at **any** status (done and dropped included) and never part of the estimate
  lock — like the title. A split follow-up carries the notes (the remaining scope keeps its context).
  Roll reps and series occurrences start with `null`; series templates have no notes.

## 2. Light markdown

Rendered by `modules/tasks/notes/` — `parseNotes.ts` (pure) and `NotesView.tsx`.

- **Supported:** paragraphs (blank line); a single newline is a line break; `**bold**`; `*italic*` /
  `_italic_` (never inside snake_case); `` `code` ``; `- ` bullets; `1. ` numbered (keeps its start
  number; mid-paragraph only `1.` starts one, so "2026. was a good year" stays prose); `[text](url)`
  (no parentheses inside the URL — such a link falls back to a bare URL); bare `http(s)://` URLs
  (trailing punctuation and an unbalanced `)` stay out).
- **Not supported, by design:** headings, images (a remote fetch is a tracking surface), raw HTML,
  blockquotes, tables, nesting, code fences. They stay literal text.
- **Cost:** linear in the note's length — a hostile 5,000-character note (thousands of `(http://[`,
  `)`, `*`) parses in milliseconds, and a test pins that.
- **Safety:** the output is React elements, never HTML — text is always a child, so `<script>` and
  `&lt;` show as typed. The one live surface is `href`: only absolute `http:`, `https:` and `mailto:`
  URLs pass (checked with the URL parser, which folds case and strips tab-split schemes); anything else,
  relative links included, renders as its literal source. Links open with
  `target=_blank rel=noopener noreferrer`.

## 3. Surfaces

- **Editor** ([task-editor.md](task-editor.md)): a Notes block in the details form. It shows the
  rendered note with an Edit button, or "Add notes…" when empty. Once editing, it stays a textarea until
  Save or Close — no blur-to-render, no preview tab. The textarea grows with its text up to 40dvh (30dvh
  below `sm`, so Save stays in reach on a phone), then scrolls, inside the 85dvh modal. A `n / 5,000`
  counter appears from 4,500 and turns red over the cap, where Save disables (a screen reader hears the crossing, not every keystroke); there's no `maxLength`,
  so a paste is never silently truncated. Notes join the dirty guard only while being edited — in view
  mode the field shows the live note, so a stale draft never reads as a change — and Save sends them
  only when they changed.
- **Row:** no snippet. A task with notes gets a quiet note icon in its meta line (screen readers hear
  "Has notes").
- **Search** ([lenses.md](lenses.md) D1): every word must appear in the title, category label or notes.
  A row the title and category alone don't explain (a notes-only or a mixed search) says "in notes"
  next to the icon. The add-to-today picker stays title + category only: it finds-or-creates by
  title, and notes hits would crowd that.
- **Bulk add** ([bulk-add.md](bulk-add.md)): a `notes:"…"` token, with `\n` and `\\` as its only escapes.
- **MCP** ([mcp/index.md](../mcp/index.md)): `notes` on `create_task`, `create_tasks` and `update_task`.

## 4. Decisions

- **Hand-rolled renderer over a dependency.** Neither rule applies: not (A) hard-to-own logic — the
  subset is a line-based block splitter plus one inline pass (~180 lines); not (B) security-critical —
  emitting React elements removes sanitizing from the problem, leaving only the `href` allowlist.
  Rejected: `react-markdown` (11 direct deps, ~40 packages) and `marked` + `dompurify` (needs
  `dangerouslySetInnerHTML`).
- **Notes are checked before any write.** The stub and Lambda normalize before reading or writing; MCP
  validates before dispatching, so an over-cap `update_task` lands none of its other fields either. A
  `setTaskNotes` call missing its second argument is an error, never a clear (`setNotesArg`).

## 5. Deferred

- Notes on series templates (occurrences would copy them).
- Trimming notes out of the MCP list tools (`list_tasks` / `list_backlog` return them in full, up to
  5 KB each) if that payload gets heavy.
- A `\"` escape in the bulk token.

## 6. Build record

Five commits: the contract (shared + stub + backend + contract tests), the editor (renderer, field,
autogrow `Textarea`, seed notes), search + the row marker, the bulk token, and MCP.
