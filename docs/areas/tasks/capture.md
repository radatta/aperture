# Voice capture (Siri, the Action Button, Raycast)

**Area:** tasks · **Branch:** `siri-capture`

**Status: built 2026-11-16, on its PR.** "Hey Siri, Aperture" or the Action Button → a task, with Siri saying
back what landed and when. Research: the spike (research panel, 2026-11-16; archived with the hub's notes).
Permanent design-of-record: this doc. Where this doc and the code disagree, fix whichever is wrong and say so
here.

## 1. What it is

One shortcut, two ways in. No Apple Developer account, no app on the phone — a personal shortcut posting to
Aperture.

- **Siri, hands-free:** "Hey Siri, Aperture" → Siri asks for the task → "call the dentist at 5" → Siri
  answers "Added: call the dentist, today 5 PM." Two utterances, no taps.
- **Action Button:** press → "call the dentist at 5" → the same answer. One press, one utterance.
- **Raycast (Mac):** the typed hotkey ([tools/raycast](../../../tools/raycast/README.md)) posts to the same
  route with its own token.

Without the paid Developer Program, a personal shortcut is run by its name and Siri asks a second question
for free text; "remind me…" with no app named always goes to Apple Reminders. One sentence ("…in
Aperture") needs a real app with App Intents — out of scope (spike §2 E).

Tasks only: there is no "log" twin (the maintainer, 2026-11-16).

## 2. The route: `POST /api/capture`

Outside the RPC surface, like `GET /api/places/<slug>/tasks` ([places §4](places.md#4-the-shortcut-route)),
and the only thing a capture token opens. `/api/capture` and every path under it end at it; they never fall
through to the JWT path.

- **Auth:** `x-aperture-authorization: Bearer apc_<43 chars>`. CloudFront forwards only that header on
  `/api/*`, so a new header or a `?token=` would be stripped.
- **Body:** JSON `{text, voice?}`. `text` is trimmed, 1–2,500 characters; the body is at most 16 KiB.
  `voice: true` (the Shortcut; `"true"` as text is taken too) applies the voice time rules (§4); absent
  (Raycast) keeps the typed rules, exactly as the capture bar. Both roll a past clock with no day forward.
- **Order:** 405 non-POST → 413 body too large → 401 token → 422 other path, bad JSON, empty or over-long
  text (only after auth, never counted) → 429 daily cap → 409 busy → 200.
- **200:** `{id, say, detail, raw, duplicate, due}` — `say` the sentence to speak, `detail` the typed
  receipt (Raycast's toast), `raw` saved as typed, `due` `{day, time}` or null.
- **Anything else:** `{error, say}`. **Never 404:** CloudFront turns an origin 403/404 into the app's
  `index.html` (a 200), which the Shortcut would read as nothing.

| Status | When                                         | `say`                                                                                  |
| ------ | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| 200    | parsed                                       | "Added: call mum, today 5 PM." (a place: "Added to Grocer: milk.")                     |
| 200    | saved without the model, its words' time     | "Added without AI, as typed: call mum at 5, today 5 PM." (spoken lines)                |
| 200    | saved as typed, no time it can place         | "Added as typed, with no date or time: call mum at five."                              |
| 200    | the same line within a minute                | "Already added: call mum, today 5 PM." (same `id`, nothing new)                        |
| 200    | …and the first is still in flight            | "Got that a moment ago. If it isn't in the app in a minute, say it again." (`id` null) |
| 401    | missing, malformed, unknown or revoked token | "Aperture: this capture token isn't valid. Make a new one in Settings."                |
| 405    | not POST                                     | "Aperture capture needs a POST."                                                       |
| 413    | body over 16 KiB                             | "That was too long for Aperture. Nothing was added."                                   |
| 422    | other path / bad body / empty / over-long    | the path's, "Aperture didn't get any text." or the too-long one                        |
| 409    | every retry of the token row lost a race     | "Aperture was busy and nothing was added. Say it again."                               |
| 429    | 200 captures today                           | "Daily capture limit reached. Nothing was added."                                      |
| 500    | anything else                                | "Aperture hit an error. Check the app before retrying."                                |

**Flow** (`BackendClient.captureForToken`): count the capture first (one conditional write — at the cap it
refuses before anything is spent) → parse (`runQuickParse`: a `|` line takes the grammar and never meets
the model; a line over 600 characters (`CAPTURE_PARSE_TEXT_MAX`) skips it too; otherwise one Sonnet call, claimed
against the user's parse cap first, with a deadline of `min(parseBudgetMs, 5 s)` and at most 512 output tokens)
→ `createTask` (a timed task syncs to Google Calendar as usual) → remember the task for the duplicate guard.
Without the model (failed, timed out, capped, too long) a spoken line saves as typed **with the time its own
words say**, placed by the voice rules (§4) — "tomorrow" is the next day; any other day word, or no time, saves
with none — and says "without AI"; a typed line saves with no due. A failed create forgets the line, so the
retry is a new capture, not "already got that".

**A lost race on the token row** (several captures at once through one token — F224, 2026-11-17): each counter
write is conditional on the row's `updatedAt`; a lost one backs off (full jitter, 25 ms doubling to 200 ms) and
tries again, eight tries in all (under a second). Every try lost: **409** with the spoken "say it again" — the
write that lost added nothing, so a retry is safe. It was a generic 500 before.

**Why synchronous** (spike §3b): for a reminder, hearing the time it understood is what catches a misheard
one, and a background parse would need a self-invoke or a queue plus an IAM change. Parse takes 3–6 s on dev
(quick-add's 2026-10-13 measure, Haiku), so some lines will hit the 5 s deadline and save raw — the dev check's
model rows fail on `raw: true`, which is the signal to raise `CAPTURE_PARSE_DEADLINE_MS`. **Siri's wait** isn't
documented anywhere (searched 2026-11-17: no limit for Get Contents of URL or Siri-run shortcuts; one report of
~10 s for Siri-run intents, and reports of Speak Text cut short on long text), so the budget is the server answering
in under 8 s with a one-sentence `say`; the `api-latency` dev row logs p50 / p95 / max and fails past 8 s.

**Logging:** one line per request, `{event: 'capture', ok, reason, ms, raw?, duplicate?, voice?, parseMs?,
fallback?}` (`fallback` why the model's reading wasn't used: `long`, `cap`, or the parse's failure reason), with fixed reason
codes. Never the text, header, token, hash or an error message. The parse's own line logs only `chars` and
token counts.

## 3. Token

A **scoped token** — a single-purpose device credential, the fourth class beside the Cognito JWT, the env
device/agent tokens and the place token. `scope: 'capture'` is the only one; a later one (an Apple Health
ingest, a client error beacon) adds a scope, a prefix and its own route — never an RPC method.

- **Named, several per scope** (at most 5): one for the phone, one for Raycast, revocable separately.
  Minted in Settings › Capture, shown once. Unlike the place token there is no rotate — make a new one,
  revoke the old.
- **Format:** `apc_` + 32 random bytes, base64url. Anything else is refused before any read (a JWT or a
  place token sent here costs nothing).
- **Storage, two rows, neither holding the token:**
  - `stoken#<sha256> / stoken` — the lookup, outside every user partition: `{userId, tokenId, scope}`.
    Never rewritten.
  - `u#<uid> / stoken#<id>` — the token, the authority: name, hint (last 4), hash, the counters and the
    duplicate guard. Never exported.
- **A request needs both rows, agreeing** on hash and scope — two consistent GetItems.
- **Mint:** the row, then the lookup, both only-if-absent; a failed lookup takes the row back out.
- **Revoke:** the lookup first (the token is dead at once), then the row. A revoke cut short leaves the row
  listed but dead; revoking again finishes it.
- **Counters** are written conditionally on the row's `updatedAt`, so a count racing a revoke can never
  bring the row back.

**Why scoped, not the agent token:** the agent token is a full app session
([mcp → ceiling](../mcp/index.md#the-agent-token-is-a-full-app-session--with-a-bounded-ceiling)). Sharing a
shortcut uploads what's embedded in it, and Shortcuts sync is end-to-end encrypted only with Advanced Data
Protection, so a leak is likely — the token has to be cheap to lose. The same token moves Raycast off the
agent token (closing mcp's deferred "create-only token").

### Caps

Per UTC day — guards, not UX:

- **200 captures per token** (`CAPTURE_DAILY_CAP`), then 429 with a spoken `say`. Duplicates count too.
- **40 model parses per user, across all their capture tokens** (`CAPTURE_PARSE_DAILY_CAP`; the maintainer,
  2026-11-17), then the line saves without the model (and says so). Only a real model call counts: a grammar
  line or a too-long one never does. Each token's row counts its own; a claim adds the user's other live rows,
  so claims racing through two tokens can overshoot by the race's width, and a revoked token's count leaves
  with it (revoking is the owner's move). The app's own parse (Cognito) isn't counted.
- **Duplicate guard:** the same line (case and spacing aside, voice and typed apart) within 60 s of the
  first is answered with the first's task, and never moves the window. The Shortcut never retries by itself,
  so only a manual retry after an unclear failure can double up. A first still unsaved after 20 s
  (`CAPTURE_IN_FLIGHT_MS` — past the Lambda's 15 s timeout) died, so the same line then is a new capture;
  inside those 20 s the answer hedges ("…if it isn't in the app in a minute, say it again").
- **Leaked tokens:** 40 × about $0.003–0.006 (Sonnet, 512 output tokens at most, 600 characters in; about $0.008 at most a
  parse) ≈ $0.12–0.24 a day, about $3.60–7.20 a month, however many tokens leak, plus junk tasks. The hard ceiling,
  with all five tokens racing their claims at once, is 5 × 40 = 200 parses a day (about $1.60). It sits inside the maintainer's Claude
  API credit, which his about-$1 rogue-cost rule doesn't cover (2026-11-17). Revoke in Settings stops it at once. Not
  capped: the request floor (a missing or malformed header costs nothing, an unknown token one GetItem);
  reserved concurrency would cap the whole shared BFF.

## 4. Time rules

Rule 2 — a past clock rolls forward — and the at/by fill below hold for typed quick add too (the app, Raycast,
`parse_task`; the maintainer, 2026-11-17, [quick-add](quick-add.md)): a typed clock with no day lands where a
spoken one would, while a day the typed line names stays as written ("today 9am" at 3pm is overdue). The bare hour, the day-parts and the delay are voice only (`voice: true`). The decisions (the
maintainer, 2026-11-16):

1. A bare "at N" is the next N o'clock, wrapping: 2 AM + "at 5" → 5 AM; 6 AM + "at 5" → 5 PM.
2. A spoken time already past rolls forward to its next occurrence, and `say` names the day.
3. "morning" is 9 AM, "tonight" 8 PM; "in N minutes/hours" is computed from the server clock, never by the
   model.

**The model reads the clock, the code places it** (since 2026-11-17, Sonnet; before, the grammar read it and the
model's time was ignored). Every spoken line gets the voice rules on top of the typed prompt — strip spoken times
and a leading "remind me to" from the title; `dueTime` the clock as said ("at 5" → 05:00, the hour as said;
"5 pm" → 17:00; "tonight" alone → 20:00, "morning" → 09:00; a delay → null); a day only when one was said. The
code then places it (`validateParsedTask`, `spokenTime.ts`): a delay ("in 20 minutes") is always the server
clock's; a model clock that agrees with the grammar's reading takes the grammar's placement (a bare hour wraps,
"at 1 tonight" is the small hours); one that disagrees wins — a bare hour when no half of the day is said in or beside
the clock (am/pm, a 24-hour clock, noon, morning…evening, tonight; a day word may sit between, "at 8 tomorrow
evening"; "at 9 book the night bus" says none), else as stated — and rolls forward like any time. With
no model clock the grammar's reading fills, as before. The grammar on its own (precedence: relative → a stated
clock → a bare hour → a day-part) is the fallback when the model doesn't run (§2 _Flow_).

Two checks keep the grammar honest:

- **The model's title is the cross-check.** A time applies only when the model took its words out of the
  title: "look at one of the leases", "email the team about the 3pm meeting" or "read John 3:16" keep their
  words, so they get no time. A delay ("in 20 minutes") is a time whatever the model did with its title, and so
  is a stated clock after "at" / "by" ("call the bank at 1 am") when it's the line's only stated clock; it then
  leaves the title — the model once returned that line unchanged with no time (2026-11-17). After both, the title is lined up
  against the words: a word the model dropped that no field used goes back ([quick-add](quick-add.md)).
- **A stated clock the model missed is filled from the words** — typed lines too (Raycast, the app's quick
  add): the 2026-11-16 dev check saw "call the bank at 6 pm" come back with today and no time. Only when the
  model took those words out of its title, or they're an at/by clock ("watch 9pm show" kept them: no time); a
  different time from the model stands.
- **A model clock needs words for it:** only when the line has a digit or an hour word in it, so an invented
  time is still dropped. "at quarter past five" with no half of the day is a bare hour: at 6 AM, 5:15 PM today.

| Said                                         | Now         | Lands                                            |
| -------------------------------------------- | ----------- | ------------------------------------------------ |
| in 20 minutes / in an hour / in half an hour | 2:10 PM     | now + N, rounded up to the minute: today 2:30 PM |
| at 5 / at five / 5 o'clock                   | 2 AM        | today 5 AM                                       |
| same                                         | 6 AM        | today 5 PM                                       |
| same                                         | 6 PM        | tomorrow 5 AM                                    |
| at 9 am / today at 9 am                      | 3 PM        | tomorrow 9 AM (rolled)                           |
| at 8 tonight / at 8 in the morning           | any         | the day-part picks PM / AM, then next occurrence |
| tonight                                      | 3 PM / 9 PM | today 8 PM / tomorrow 8 PM                       |
| this morning / tomorrow morning              | 10 AM       | tomorrow 9 AM                                    |
| friday at 5 (a named day, a bare hour)       | any         | Friday 5 PM — the daytime hour, 07:00–18:59      |
| at 12 tonight / at 1 tonight / at 11 tonight | 9 PM        | tomorrow 12 AM / tomorrow 1 AM / today 11 PM     |
| at five thirty / five thirty pm              | 6 AM        | today 5:30 PM                                    |
| noon / midnight / 17:00                      | any         | as said, rolled if past                          |
| half past five pm / quarter to six pm        | any         | 17:30 / 17:45 (2026-11-17), rolled if past       |

- A time equal to now is past ("at 5" at 5:00 PM → tomorrow 5 AM).
- A day the model gives is trusted unless it's calendar tomorrow and the words name no day (`DAY_WORD`:
  tomorrow, a weekday, a month, a date, "days") — a model that dated a bare "at 5" tomorrow on its own can't
  turn it into a daytime hour, while "in 2 days" or "Christmas Eve" keep the model's day. A minute the
  grammar can't read ("at five twenty pm") means no grammar time at all, so the model's clock takes over.
- A day counts as named only when it's after the calendar's today ("today at 9 am" rolls; a past day the
  model read, "monday" as last Monday, rolls too). "friday at 1 tonight" is the small hours after Friday.
- "afternoon" and "evening" stay day-only (not decided). A spoken line saved without the model keeps its words'
  own time (`spokenFallbackDue`): "today", "tonight" and "tomorrow" (the app's next day, as the model reads it)
  place it; any other day word means no time at all, since a wrong day is worse than none. Without the model's
  kept-words guard, the fallback can time a line whose number wasn't a time ("look at one of the leases" reads
  as 1 o'clock) — accepted: it is rare and the save is said out loud. A typed line saved without the model gets
  no time.
- `say` reads a timed task against the calendar date ("today 5 AM" said at 1 AM) and a day-only one against
  the app's day.
- A relative delay is never an estimate: the estimate guard reads the line with "in N …" taken out.

A timed task fires its Web Push reminder at that minute ([reminders](reminders.md)). Web Push can't be
marked time-sensitive, so a Focus that doesn't allow Aperture holds it (spike §3d).

## 5. The Shortcut

Settings › Capture → **Set up the Siri Shortcut** has the steps with this origin's URL and the header key
to copy. In short:

1. Shortcuts → + → name it **Aperture** — the word you say to Siri.
2. **Dictate Text**, Stop Listening **After Pause**.
3. **Copy to Clipboard** with Dictated Text — if the network step fails, the words are still there.
4. **Get Contents of URL**: `https://<prod host>/api/capture`, Method **POST**, header
   `x-aperture-authorization` = `Bearer <your capture token>`, Request Body **JSON**: `text` (Text) =
   Dictated Text, `voice` (Boolean) = True.
5. **Get Dictionary Value** `say` from Contents of URL → **If** it has any value → **Speak Text** it;
   **Otherwise** → **Speak Text** "Aperture didn't confirm. Check the app." End If.
6. In the shortcut's ⓘ, **Allow Running When Locked** if offered. Settings › Action Button → Shortcut →
   Aperture. Optionally a Control Center or Lock Screen control running it.

No capture ends silently: every route answer has a `say`, and an answer without one (a CloudFront error has
no body) speaks the fallback. No network: Shortcuts stops with an error (spoken or shown), and the words are
on the clipboard.

If dictation clips words through Siri, split it into two thin front ends — **Ask for Input** for Siri,
**Dictate Text** for the Action Button — both running one "Aperture send" shortcut (spike §3a).

A signed, importable `.shortcut` (built on the Mac with `shortcuts sign`) is a possible later convenience,
unverified; it must ask for the token at import, never embed one.

## 6. What only the phone settles

The real run is the maintainer's (spike §5): does "Hey Siri, Aperture" hear the name first time; locked runs
through Siri, the Action Button and a Lock Screen control (Face ID?); whether the first or every run asks
before contacting the domain; the 3–6 s wait and whether Speak Text gets cut off; whether Dictate Text clips
words under Siri; the Watch with the phone away; Mac Siri / Spotlight running the synced shortcut; whether
Get Contents of URL hands a non-2xx body on (so a 401's `say` is spoken) rather than stopping.

## 7. Decision log (2026-11-16)

- **Named scoped tokens, at most 5 per scope, a sibling of the place token** — separate revocation for the
  phone and the Mac, no rotate race, and the working place rows untouched. Only `bearerOf` is shared.
- **Parse deadline 5 s** (`CAPTURE_PARSE_DEADLINE_MS`), raised if the dev rows show raw saves.
- **A named day with a bare hour is the daytime one** (07:00–18:59): "friday at 5" is 5 PM.
- **"tonight" after 8 PM** rolls to tomorrow 8 PM (decision 2), and says so.
- **A duplicate answers 200 with the first id**, and counts toward the 200 — a retry should sound like
  success, and the cap stays provable without model calls.
- **Body `{text, voice?}`** — no `kind`, tasks only.
- **No "Test" button in Settings** — it would need the plaintext; the phone run is the test.
- **Recipe, not an importable shortcut** — `shortcuts sign` is unverified, and a file must never embed the
  token.
- **2026-11-17 (the maintainer):** typed lines roll a past clock with no day as spoken ones do (a day they
  name stays as written), and a stated clock after
  "at" / "by" is the due time even when the model kept it in its title — [quick-add's decision log](quick-add.md).
- **2026-11-17 (titles, autonomous):** a spoken title keeps every word the parse didn't use, as a typed one does;
  the spoken time, "tonight", "morning" and a leading "remind me to" are the parse's — [quick-add's titles
  log](quick-add.md).

- **2026-11-17 (Sonnet, autonomous build; the maintainer's calls in [quick-add's log](quick-add.md)):** the
  model reads every spoken clock and the code places it (§4); without the model a spoken line keeps its words'
  time and says "without AI"; a lost token-row race retries with jitter, then 409 "say it again" (F224); the
  parse cap is per user, 40 a day (the maintainer); lines over 600 characters skip the model. The Shortcut is
  unchanged.

## 8. Build record

- **shared:** `capture.ts` (scopes, caps, wire shapes, `captureSay`), `spokenTime.ts` (the voice grammar and
  resolver), `quickParse.ts` (`ParseContext.voice`), `dates.ts` (`fmtClockSpoken`, `fmtSpokenDay`), three RPCs
  (`listScopedTokens`, `mintScopedToken`, `revokeScopedToken`) in the contract.
- **lambdas:** `auth/scopedToken.ts` (mint, resolve, reserve, claim, record, forget), `ddb/scopedTokens.ts`,
  the keys, `BackendClient.captureForToken`, the route in `index.ts`, the voice prompt rules
  (`parsePrompt.ts`).
- **app:** Settings › Capture (`CaptureTokensSection.tsx`) against the stub first: mint, list, revoke, the
  recipe.
- **tools:** Raycast posts to the route with its own capture token.
- **cdk:** none — `/api/*` already allows every method and forwards the auth header to the same Lambda.
- **Dev check:** the `siri-capture` scenario (`scripts/src/devcheck/scenarios/siri-capture.ts`); titles, the
  `capture-titles` scenario.
