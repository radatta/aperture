# Quick add — natural-language task capture

Type a task the way you'd say it — `aperture, fix login bug due fri 4pm 30m` — and **Claude Haiku** reads
the structure out of it: a short title, notes for the overflow, the category, due day/time, estimate. It
runs in the capture bar's Task mode and behind the Raycast hotkey, through **one server-side parse**.
Started as a request for optional fields on quick add (2026-10-12); the user chose a model parse over field pickers.

```
capture bar (Task) ─┐                                   ┌─ ' | ' line → strict grammar (no model)
                     ├─ parseTask(text) ─ BackendClient ┤
Raycast ─ parse_task ┘     (RPC / MCP)    runQuickParse └─ else → AnthropicGateway → Haiku → validate
                                          (shared)            (gated: noop in testMode/smoke)
```

## How it behaves

- **Enter / Send = Auto.** The field clears at once; the parse and the create run behind it; the receipt
  reads back what was saved (`Task added → backlog`, plus a 4s line under the field — `fix login bug ·
Aperture · due Fri 4pm · 30m` — until you start the next capture). On the phone, type it as you'd
  say it — nothing in a natural line needs the symbols page (`|`, `~` and `#` all sit on it).
- **✨ Review (or ⌘/Ctrl+Enter).** Parses into a preview under the field — title, `no category` or the
  category chip, due (relative: `due tomorrow 4pm`), estimate, notes (2 lines), and any dropped field in
  gold. A second press (✨, Enter or Send) saves exactly the preview, without parsing again. On a failed
  preview ✨ parses again ("Retry parse") and Enter saves the line as typed. Editing the text,
  switching modes, or the 4am rollover (the parse resolved "tmw" against yesterday) drops the preview.
  ✨ keeps focus in the field, so the phone keyboard stays up.
- **The preview's category chip.** When the parse found no category and the user's own history is
  confident, a dashed `Garden?` stands in for `no category` ([same scorer and gates as the
  editor's](task-editor.md)). The tap fills the preview and writes nothing; the next press saves it. It is
  never pre-selected: saving untapped stays uncategorised, Enter with no Review never sees it, and a
  grammar line never shows it. The task list loads only once a preview needs the chip. A preview belongs
  to its exact text, so an edit hides a taken chip and undoing the edit shows it again, still visible. A
  failed create puts the text back with the tap; a capture parked below (the field had moved on) keeps only
  its text, so Review it again.
- **A grammar line — space, pipe, space, as in `memo | ~30 #Admin`** — never reaches the model: it is the
  [bulk-add](bulk-add.md) grammar, as before, and shows no ✨ (⌘Enter saves it like Enter). `a|b` is
  not one; it goes to the model.
- **A failed parse saves the line as typed, loudly** — gold `Saved unparsed → backlog`, and `Saved as
typed — couldn't parse (reason)` under the field (`timeout`, `unavailable: no API key on this stage`,
  …). The app gives a parse 10s before saving raw — a long line (8s model budget) on a Lambda cold start
  can hit that and save raw; accepted.
- **A failed create never loses the text.** Into an empty field it goes back ("Couldn't save — your text
  is back in the box", and `→ today` set to where it was headed); if you've started the next capture
  meanwhile, it's **parked** under the field — `Couldn't save: "…"` (up to three lines; Put back shows
  all of it) with **Put back** (trades places with whatever the field holds, which is parked as "Set
  aside") and **× Discard**. Each row's text describes its buttons for screen readers.
- **Closing the app can't lose it either.** Each Auto capture sits in a localStorage outbox
  (`aperture:captureOutbox`) from Enter until its create settles, and parked captures are stored too
  (`aperture:captureParked`) until put back or discarded — an outbox entry moves to parked in one
  storage write, never through memory alone. A leftover outbox entry comes back parked as "Unsent when the
  app closed — it may have saved, check first", announced ("Unsent capture kept below the box"). The sweep
  runs on launch, on return to the foreground, and when a waiting entry comes of age; it never takes this
  page's own in-flight entries, nor another tab's under 30s old.
- `→ today` composes with both. Log and Idea modes are untouched.

## Pieces

| Where                                   | What                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/quickParse.ts`     | `ParseTaskResult` contract, `validateParsedTask` (the server's field rules over Haiku's untrusted JSON), `runQuickParse` flow |
| `lambdas/src/anthropic/`                | gateway (`noopAnthropic` / `FakeAnthropic` / `createLiveAnthropic`), the one prompt + JSON schema (`parsePrompt.ts`)          |
| `lambdas/src/backend.ts` `parseTask`    | server owns today (`dayStartHour` in LA) and the active category list; the client sends only text                             |
| `lambdas/src/mcp/tools.ts` `parse_task` | the same method for Raycast (agent token)                                                                                     |
| `app/src/modules/capture/`              | `useQuickParse` (preview, in-flight reuse, 10s ceiling), `captureOutbox.ts`, `parsePreview.ts`, CaptureBar wiring + parking   |
| `app/src/data/stubParse.ts`             | the stub's heuristic stand-in for Haiku (same flow + validator); `aperture:stub:failNextParse` fails the next parse once      |

The model call: `claude-haiku-5-5`, structured outputs (`categoryId` an enum of active ids), `thinking`
disabled, `effort: low`, `max_tokens 2048`, one attempt, 4s budget +1s per 400 chars (cap 8s; Lambda is
15s). Input capped at 2,500 characters (the overflow comes back as notes, so a longer line can't fit the
output or the budget). One JSON log line per call (`event: parse_task`, ok/reason, HTTP status,
stop_reason, ms, tokens) — never the text or the key.

## Operator step (once per stage)

The key is an SSM SecureString both functions may read (exactly that parameter):

```sh
read -rs key; aws ssm put-parameter --region us-west-1 --type SecureString \
  --name /aperture/<stage>/anthropic/api_key --value "$key"   # --overwrite to rotate
```

Without it every parse returns `unavailable` and lines save raw — deploys and smoke pass either way. A
warm Lambda holds the key it read; a 401 from the API drops it, so a rotated key is picked up on the next
parse.

## Decision log (2026-10-12)

Settled with the user: model parse over field pickers (D1); Raycast's parse rules (D2); two buttons —
Review and Auto (D3); a grammar line skips the model (D4); a failed parse saves raw, loudly (D5); Raycast moves
onto the same server parse, so the Mac holds no Anthropic key (D6). The rest was decided in an
autonomous build:

- **An RPC method, `parseTask`** — every BFF call is `POST /api/<method>`; a REST route would be a second
  convention.
- **SSM SecureString, not Secrets Manager** (which INFRA §10 had pre-declared for "v1.1 AI") — the Plaid
  pattern and SDK client, free, one operator command.
- **A gated gateway, not a `writes` entry** — it mutates nothing, but it carries a secret and a cost, so it
  follows Google/Plaid's read-gating. It never throws; a failure is an outcome.
- **Enter = Auto, Review is the opt-in** — capture stays one gesture (PRODUCT §2).
- **Auto is optimistic, with no automatic raw resend after a failed create** — the app can't tell a
  validation 400 from a timeout, and a blind resend risks a duplicate. (Raycast keeps its pre-write
  `-32602` resend.)
- **Saves are promises (`mutateAsync`)** in all three capture modes: `mutate`'s per-call callbacks fire
  only for the latest call, so a failed capture followed by a quick second one lost its restore — a
  pre-existing silent loss that Auto's parse delay made likely.
- **The server also runs the grammar** for MCP/Raycast callers (one validator, two surfaces), and its
  `input` carries only the fields that are set — `create_task` reads a present `null` as given and
  rejects it, which made every grammar line without `~` a raw save (found in review round 1).
- **Active categories only; `estimateMin: 0` → none, quietly; input cap → raw save; `categoryLabel` in
  the result** (so Raycast dropped its category cache).
- **Plain `fetch`, no Anthropic SDK** — one fixed POST is neither substantial logic nor subtle
  correctness. **No prompt caching** — the prompt changes daily and is under the cacheable minimum.
- **Out of the contract suite** (model-gateway dependent, like the calendar methods); parity by
  `backend.parse.test.ts` ↔ `stubParse.test.ts`. **Not in the smoke list** — its invariant is
  empty-args reads, and every smoke call already cold-starts the module that builds the gateway.
- **Round 1 (review), on "never fail silently":** a failed create parks rather than overwriting a newer
  capture; the outbox + the 10s client ceiling close the parse window, where the capture lived only in
  memory (rejected: keeping the text in the field until sent — Auto would feel like a spinner). Round 2
  made the parked list durable too (it had moved captures from storage back into memory) and added the
  foreground/age sweep (a relaunch within 30s had hidden a leftover until a later launch). A
  grammar-line error from Raycast stays a red raw save (no model fallback: the pipe is explicit intent).
  No per-period cost cap on `parse_task` (logged per call; revisit if the credit dips).
- **Dev check (2026-10-13, Claude in Chrome on dev):** 13/13 flows passed, 3–6s per parse. Two parse-quality
  bugs: Haiku invented a due time (`today plan 10m` → due today 10am, onto the calendar) and dropped or
  reworded the user's words (a marker word, `no category here`, ` extra`; sentence-casing). Fixed: the
  prompt now says keep every non-meta word verbatim (overflow to notes) and that a day alone or `10m` is no
  time; and the validator drops any due time when the typed line has no clock in it (`4pm`, `9:30am`,
  `16:00`, `noon`) — the one rule that doesn't depend on the model behaving. The re-run confirmed both,
  and caught one more invention ("call dentist tonight" → 15m): an estimate is now dropped the same way
  when the line has no duration (`30m`, `2h`, `90 min`, `an hour`).
- **Not built:** an editable preview (edit the text, Review again). The scoped Raycast token landed with
  voice capture (2026-11-16): Raycast and the Siri Shortcut post to `/api/capture` with a capture token —
  the same parse, plus voice-only time rules ([capture](capture.md)).

## Decision log (2026-11-17, the maintainer)

- **Every clock lands on its next occurrence, typed or spoken.** A typed time already past rolls forward as a
  spoken one does: "call 9am" at 3pm → tomorrow 9am; "1 am" at 02:01 (the app's day still yesterday) → the
  coming night's 01:00, not the hour just gone. Found by the voice-capture dev check at 02:01, where a typed
  "…at 1 am" came back with no time at all (next bullet). `validateParsedTask` resolves every clock with
  `resolveSpoken` against `ParseContext.now` (the server's clock; the stub's own) — a day the model gave
  counts only when it's after the calendar's today, so "today 9am" at 3pm rolls and "friday 9am" stays.
  Replaces the earlier "a past clock lands today" rule (credited in these docs to 2026-10-09, with no record
  of the maintainer's words) and `nightDueDay` (2026-10-31, below), which this covers.
- **A clock phrased as a due fills even when the model kept it in its title.** The model sometimes returns
  "call the bank at 1 am" unchanged with no time (1 in 10 on dev); the title check below then refused it, so
  the task had no due at all. A stated clock after "at", "by", "due at" or "due by" is the due time whatever
  the model did with its title, and the phrase leaves the title (`dueClock`, `spokenTime.ts`) — also when the
  model gave that same time but kept the words, so a line's title doesn't depend on the model. Spoken lines
  too. "watch 9pm show", "the 3pm meeting", "move the 3pm to 5pm" and a bare hour ("look at one of the
  leases") still get no time.

## Decision log (2026-11-16)

- **A clock stated outright fills a time the model missed.** The voice-capture dev check saw a typed "call the
  bank at 6 pm" come back with today and no time. When the model returns no time and the line states a clock
  outright (am/pm, noon, midnight, a 24-hour time — `spokenTimeIn`'s `clock`), `validateParsedTask` takes it
  — only when the model took those words out of its title ("watch 9pm show" kept
  them: they weren't the due time; an at/by clock is, since 2026-11-17). A different time from the model stands. Covers the app, Raycast and
  `parse_task` alike ([capture → Time rules](capture.md#4-time-rules)).

## Decision log (2026-10-31)

- _Superseded 2026-11-17 (every clock lands on its next occurrence; `nightDueDay` is gone)._
  **A small-hours clock on today is tonight's.** A parse that lands on the app's today with a clock
  before the day start moves to the next calendar date (`nightDueDay`, shared `due.ts`): "essay due
  tonight 2:30am" typed at 00:22 (app day still yesterday), or "2:30am" typed at 3pm, would otherwise be
  already past. Both parsers go through the one validator (`validateParsedTask`), which now needs
  `ParseContext.dayStartHour`. Any other day stays as parsed — "tomorrow 1am" is ambiguous.
