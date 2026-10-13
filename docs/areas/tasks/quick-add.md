# Quick add — natural-language task capture

Type a task the way you'd say it — `aperture, fix login bug due fri 4pm 30m` — and **Claude Haiku** reads
the structure out of it: a short title, notes for the overflow, the category, due day/time, estimate. It
runs in the capture bar's Task mode and behind the Raycast hotkey, through **one server-side parse**.
Started as "optional add fields to quick add" (2026-10-12); the user chose a model parse over field pickers.

```
capture bar (Task) ─┐                                   ┌─ ' | ' line → strict grammar (no model)
                     ├─ parseTask(text) ─ BackendClient ┤
Raycast ─ parse_task ┘     (RPC / MCP)    runQuickParse └─ else → AnthropicGateway → Haiku → validate
                                          (shared)            (gated: noop in testMode/smoke)
```

## How it behaves

- **Enter / Send = Auto.** The field clears at once; the parse and the create run behind it; the receipt
  reads back what was saved (`Task added → backlog`, plus a 4s line under the field: `fix login bug ·
Aperture · due Fri 4pm · 30m`).
- **✨ Review (or ⌘/Ctrl+Enter).** Parses into a preview under the field — title, `no category` or the
  category chip, due, estimate, notes (2 lines), and any dropped field in gold. A second press (✨, Enter
  or Send) saves exactly the preview, without parsing again. Editing the text hides the preview.
- **A line with `|`** never reaches the model: it is the [bulk-add](bulk-add.md) grammar, as before.
- **A failed parse saves the line as typed, loudly** — gold `Saved unparsed → backlog`, and the reason
  (`timeout`, `unavailable: no API key on this stage`, …) under the field. A failed **create** puts the
  text back ("Couldn't save"), as every capture always has.
- `→ today` composes with both. Log and Idea modes are untouched.

## Pieces

| Where                                   | What                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/quickParse.ts`     | `ParseTaskResult` contract, `validateParsedTask` (the server's field rules over Haiku's untrusted JSON), `runQuickParse` flow |
| `lambdas/src/anthropic/`                | gateway (`noopAnthropic` / `FakeAnthropic` / `createLiveAnthropic`), the one prompt + JSON schema (`parsePrompt.ts`)          |
| `lambdas/src/backend.ts` `parseTask`    | server owns today (`dayStartHour` in LA) and the active category list; the client sends only text                             |
| `lambdas/src/mcp/tools.ts` `parse_task` | the same method for Raycast (agent token)                                                                                     |
| `app/src/modules/capture/`              | `useQuickParse` (preview + in-flight reuse), `parsePreview.ts`, CaptureBar wiring                                             |
| `app/src/data/stubParse.ts`             | the stub's heuristic stand-in for Haiku (same flow + validator); `aperture:stub:failNextParse` fails the next parse once      |

The model call: `claude-haiku-5-5`, structured outputs (`categoryId` an enum of active ids), `thinking`
disabled, `effort: low`, `max_tokens 1024`, one attempt, 4s budget +1s per 400 chars (cap 8s; Lambda is
15s). One JSON log line per call (`event: parse_task`, ok/reason, ms, tokens) — never the text or the key.

## Operator step (once per stage)

The key is an SSM SecureString both functions may read (exactly that parameter):

```sh
read -rs key; aws ssm put-parameter --region us-west-1 --type SecureString \
  --name /aperture/<stage>/anthropic/api_key --value "$key"   # --overwrite to rotate
```

Without it every parse returns `unavailable` and lines save raw — deploys and smoke pass either way. A
rotated key reaches warm Lambdas only when they recycle.

## Decision log (2026-10-12)

Settled with the user: model parse over field pickers (D1); Raycast's parse rules (D2); two buttons —
Review and Auto (D3); `|` skips the model (D4); a failed parse saves raw, loudly (D5); Raycast moves
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
- **The server also runs the `|` grammar** for MCP/Raycast callers (one validator, two surfaces).
- **Active categories only; `estimateMin: 0` → none, quietly; 5,000-char input cap → raw save;
  `categoryLabel` in the result** (so Raycast dropped its category cache).
- **Plain `fetch`, no Anthropic SDK** — one fixed POST is neither substantial logic nor subtle
  correctness. **No prompt caching** — the prompt changes daily and is under the cacheable minimum.
- **Out of the contract suite** (model-gateway dependent, like the calendar methods); parity by
  `backend.parse.test.ts` ↔ `stubParse.test.ts`. **Not in the smoke list** — its invariant is
  empty-args reads, and every smoke call already cold-starts the module that builds the gateway.
- **Not built:** an editable preview (edit the text, Review again); a scoped Raycast token
  (`parse_task` + `create_task` — [mcp → Deferred](../mcp/index.md#deferred)).
