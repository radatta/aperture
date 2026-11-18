# Recruiting — LeetCode

The Recruiting module follows how LeetCode is actually practised: a **sitting** is one go at one problem —
you open it, the extension's Start clears LeetCode's editor and starts its timer, you work, you mark the rep
Done in Aperture. Everything LeetCode itself sends while you work (your code as you type, every Run and
Submit with its full result, its replay stream, its timer) is captured raw, and `/recruiting` lists the
sittings with their outcome. The headline is **whether the first submit was accepted** — the same
calibration move as tasks, what it took versus what you thought. Presentation follows the anti-guilt rule:
accepted reads teal, everything else gold or muted, never red.

Rows are written by a **browser extension**, not by the app. There is no authoring UI and never will be.

**Redesign in progress (lc-redesign, 2026-11).** A1 — sittings: contract, server, list page — is the section
below; A2 — the extension rebuilt around sittings — is _The shape_. The old per-submission capture is gone
from the extension, and its rows (`leetcodeAttempts`, SK `lc#<day>#<id>`) are read-only history: PR D (2026-11)
removed the method that wrote them (`recordLeetcodeAttempt`: a device token now gets a 401, a JWT a 404 at the origin,
which CloudFront serves as `index.html`), and nothing migrates or deletes them. Since coach-fixes the coach folds
them as legacy attempts and the export carries them ([coach.md](coach.md) → _Legacy history_). The redesign's evidence (what LeetCode exposes, from a HAR capture on 2026-11-08) is archived with the branch's
notes (`/workspace/localNotes/archive/lc-redesign/lc-capture/`); durable decisions are recorded here.

## Sittings

### The unit and its lifecycle

```
extension Start ──► lcSittingStart ──► a rep of settings.leetcodeRollId, in progress, titled "LeetCode · <problem>"
LeetCode traffic ─► lcSittingEvents ─► events stored raw; runs/submits/notes/timer fold into the head,
                                       snapshots/replay into the live row
Done on the rep ─────────────────────► sitting done          Drop ─► abandoned          delete ─► gone with it
(stale: past 24 h, or its rep finished elsewhere ─► ended by the next Start)
(idle: 45 min with no activity ─► closed by the next read at last activity + 5 min ─► Reopen / coming back)
(ended: for 10 min still takes the events stamped before its end, inside its 24 h window)
```

- **One sitting = one problem = one Roll rep.** Start first ends stale open sittings — past their 24 h window
  (abandoned; its still-open rep is reused), rep finished some other way (done/abandoned), or a half-made
  Start on another problem. Then it resumes a sitting already open on the same problem (or a repeat of the
  same Start), refuses another problem while one is open (`SITTING_ACTIVE_ERROR` — one open rep per roll),
  attaches the roll's open rep, and otherwise spawns a fresh one. Unlinked or archived roll →
  `LC_ROLL_UNLINKED_ERROR` (Settings → LeetCode).
- **The rep is shaped through the normal task paths**, from the **stored** sitting — never the request — so
  its reminder rows stay right. A new sitting (or a rep the Start had to create) gets its title
  (`LeetCode · <problem>`), the problem URL as notes when empty, and a plan row on the sitting's day (id = the
  sitting's, so one however many Starts race; none for a timed rep — rolls.md D6); a linked calendar event is
  renamed with it, once. When that shaping completes the head is stamped `shapedAt`; a repeat Start of a
  sitting without it (a Start that died part-way, rep made or not) shapes it fully, with the sitting's own roll.
  After that a resume only starts the rep — it never renames or re-plans, so it can't undo your own edits.
- **A sitting ends through its rep** (`transitionTask` / `deleteTask` hooks, for tasks with a `rollId`; any
  other finish is caught at the next Start). Ending it refolds its summary first, so a fold lost just before
  Done heals. An Accepted submit never ends it — you may keep going. A repeat Start of an ended sitting returns
  it ended (`resumed: true`): the extension mints a new id for a new sitting — except one closed by idle the
  same app day, which it reopens (_Idle close_).
- **The Start gate** (`lcstart`, one row a user): every Start first counts an attempt there (a CAS, ≤ 400 a
  day — 4000 on a dev slot — refused ones included, before any read); a new sitting then **claims** it —
  refused while the gate holds another open sitting, or one claimed in the last two minutes that this Start can't see yet (a
  parallel Start) — and only then claims its head (put-if-absent on the Start's `clientSittingId`). Ending or
  deleting a sitting releases the gate (best-effort on a task's Done or Drop, which is already saved — a
  missed release lets go once its sitting reads ended). A rep-less open sitting counts as a dead half-made
  Start only after those same two minutes, so a parallel Start can't end one still being written. So parallel Starts open one sitting, and a double-fired Start makes
  one sitting, one rep, one plan row. Days are the user's (LA) day, never the client's tz.
- `startedAt` is the server's clock at Start (the sitting clock); the click's own time is `clientStartedAt`,
  which must be within a day of it — the clock event times and time-to-first-submit are measured on. The end
  (`endedAt`, server clock) is compared on that clock too, shifted by `startedAt − clientStartedAt`.
  LeetCode's `solve_elapsed_ms` counts from the first time a problem was ever opened, so it's context only.
  `day` buckets `startedAt` by the client's tz offset and `dayStartHour`.

### Idle close

A sitting nothing has touched for **45 minutes** (`SITTING_IDLE_MS`, the coach's 30-minute cap + 15) is closed
by the next read, never by a scheduled job ($0, no new resource).

- **Activity** is everything the server already hears, on its own clock: the Start, a reopen, every events call
  that keeps an event (the budget row's `updatedAt`) and every `live_sitting` pull (the reads row's `updatedAt`),
  so a hint conversation with Claude keeps it open. Event `at` times are the extension's clock and never count —
  a skewed Mac would close a sitting under use. The extension sends a snapshot only when the code changes, so
  45 minutes of thinking without typing closes it; the next keystroke reopens it.
- **The end is the last activity + 5 minutes** (`SITTING_IDLE_TAIL_MS`), never the moment it's noticed, so its
  minutes, the cap and the rep's Done prefill aren't inflated. The head records `closedBy: 'idle'`; status
  `abandoned`, its rep left in progress (as a stale sitting's is), the Start gate released.
- **Every read closes first** (`closeIdle` in the backend and the stub, on the shared `idleEnd`): `listSittings`
  (the Recruiting list, Home, `list_sittings`, `get_day`, the coach tools), `getSitting` (`get_sitting`),
  `pullLiveSitting` (before the pull counts), the coach's reads (`leetcode_today`, `coach_stats`), Start, events,
  and a rep's Done or Drop. Below the line (`mayBeIdle`, the head's own times) it costs nothing; past it, three
  consistent gets (the two stamps, then the rep once it's idle). The close is a CAS only an open head not reopened
  since passes, so reads at once write one close; fresher activity wins through its own path (an event or Start runs
  this first, then reopens). Its gate release frees only a claim no later than the end (`releaseStart`'s
  `claimedBy`) — a reopen's claim comes 40+ min after it — so a reopen racing the release keeps the gate. Accepted
  race: a snapshot landing between the activity read and the CAS doesn't stop the close; the next event reopens it.
- **MCP reads stay free.** Through `/mcp` (`RpcCall.idlePeek`) and on a smoke run, a read answers the closed view —
  the same end — and writes nothing; the app's next read, a Start or an event writes it. So CLAUDE.md's MCP rules
  hold: reads write nothing, `live_sitting` writes only its count (and none on an idle sitting). An MCP write that
  ends a rep (`complete_task`) still writes the close first, as any Done does.
- **A rep finished elsewhere** (a Done or Drop whose best-effort hook missed) ends its idle sitting as the rep did —
  `done` at its `completedAt`, or abandoned at its `cancelledAt`, never later than the idle end — not as idle, as the
  next Start used to.
- **Reopen** (`reopenSitting`, the button on its page) — refused unless closed by idle, inside its 24 h window,
  its rep still in progress, no other sitting open (`SITTING_ACTIVE_ERROR`) and no later sitting on its rep
  (`sittingReopenError`). In Start's order: the gate (`reclaimStart`, no Start counted), then the head, then its
  rep started as a resume does. The gap since the end goes to `idleMs`, which its minutes leave out
  (`sittingElapsedMs`), so coming back hours later never counts the hours. A Start that read the sitting ended
  can't take the gate from a reopen still writing (`claimStart`'s fresh-reclaim guard).
- **Coming back** the same app day reopens it on its own: a Start on its problem (or a repeat of its Start), or an
  events call with an event stamped after its end. Another day, or refused, a Start plans as usual (the roll's open
  rep is attached to a new sitting). A pull never reopens; there's no MCP reopen tool (an MCP write needs the
  user's go, and returning through the extension already reopens).
- **Stragglers**: an idle-closed sitting takes the events stamped before its end for its whole 24 h window (its end
  is already old when noticed, so the 10-minute grace would refuse the outbox's retries).
- **Done on its rep afterwards** turns it `done`, its end and `closedBy` kept; Drop leaves it abandoned. Unnoticed
  until the Done, it ends `done` at the idle end (as its rep, above).
- **The app never prefills from a stale head**: a page or Home left open holds the sitting as cached. Once a cached
  open head is past the line and older than 30 s (`useIdleRecheck`), it's read again and Done waits for it (the
  cached head still shows; a failed re-read stops the wait), so a morning's tab never prefills the hours since. A sitting a later Start took the rep from offers neither Reopen nor
  the rep's Done on its page; Home links a rep to its newest sitting closed by idle however old (the rep is still in
  progress, and its minutes are that sitting's).

### What's stored, what's derived

All rules are in `packages/shared/src/sittings.ts` (the stub and the Lambda share them):

- **Head** (`lcsit#<id>`): the problem, rep, status, prep target (`General` until the company UI), the user's review
  (`review`, _Review and the Claude draft_ below) and the `summary` — runs, submits, first/last verdicts (status message trimmed to 200), `submitsBeforeAccepted`,
  runs before the first submit, LeetCode's timer state, and `headEvents`, how many rows it folds.
  **Recomputed, never incremented:** any events call carrying a head event — fresh or a repeat — rebuilds it
  from every head row (`summarizeHeadRows`), and writes it only when it folds more rows than the stored one, so
  a lost write, a retry or a slower parallel call can't skew or roll back the headline.
- **Head rows** (`lcs#<id>#hd#<ulid>`): a run's, submit's, note's or timer read's compact verdict (`headRowOf`),
  ~200 B, so the recompute stays cheap however large the payloads. The run's, submit's or note's **full
  payload** sits beside it under `lcs#<id>#jd#<ulid>`, kept forever.
- **A Run's verdict** (`verdictOf`): LeetCode's "Accepted" (10) on a Run only says the code ran; its
  `correct_answer: false` makes it `wrong_answer`, "Wrong Answer" in our words (with no flag, fewer passed than
  run — an inference). An errored Run and every Submit stay as judged, so the outcome (submits only) is
  untouched. Every read — the timeline, `get_sitting`, `live_sitting`, the draft — judges from the payload, so
  sittings stored before the rule (2026-11-10) read right with no backfill. A Run's shown output is its answer
  (`code_answer`), not its prints (`code_output`).
- **Live row** (`lcs#<id>#live`): the newest code (the final code once ended — a late snapshot may still move
  it for the ten-minute grace, _Ingest_ below), the snapshot `version` live
  reads report, and **facts** folded from the replay at ingest — first/last edit, edits, longest stall,
  rewrites, LeetCode's type-3 toggles raw (`focus`; meaning unconfirmed). Folded at ingest so they outlive the
  raw replay. Incremental: a repeated snapshot counts nothing but still lands its code if it's the newest (so a
  lost fold heals the final code); `version` and the facts can come up a little short after a lost fold.
- **Raw bulk** (`lcs#<id>#ev#<ulid>`: snapshots, submit details) and **replay chunks** (`lcs#<id>#rp#<ulid>`,
  never in `getSitting`, read with `listSittingReplay`), keyed by their client ULID; **problem doc**
  (`lcq#<slug>`): LeetCode's `questionDetail`, upserted by a new sitting, filled in by a resume when missing.
- **Live-pull count** (`lcs#<id>#reads`): how many times Claude pulled the sitting live (_Claude watches live_,
  below), `liveReads` on `getSitting`.
- **Derived, never stored:** `sittingMetrics` — first submit accepted (headline), submits before accepted,
  time to first submit — and the elapsed time.

### Coach events

The extension's coaching (the trace card at the first Submit, the resubmit nudge — LeetCode coach epic, PR C) reports
as events of type `coach`, a head event like a run: a compact head row (`coachMarkOf`: the kind, how many of the
three inputs a trace filled, a config's switches) and the payload kept forever beside it. The payload is
`CoachEventPayload` in `packages/shared/src/types.ts`: `config` (what was on: trace card, hold, nudge — once per
sitting, so weeks with the gate on and off can be told apart), `trace` (the user's empty/boundary/normal inputs, each ≤ 300
chars), `trace-skip`, `untraced-submit` (a Submit seen with neither) and `nudge-shown`; ≤ 4 KB each. They fold into
`summary.coach` — `trace` is the state **at the first submit** (three inputs `traced`, one or two `partial`, none or a
skip `skipped`, a submit seen untraced `none`; a trace after the first submit changes nothing), plus the config and
a nudge count. A kind the server doesn't know is stored (its payload in full) and folds nothing — its head row keeps
`kind: null` for good, so an extension that ships a kind first loses that kind's fold on those sittings unless a
backfill re-reads the payloads. `summary.coach` is absent until a coach event folds — on every sitting before them, and with an
extension that sends none — so readers take `summary.coach ?? null`.

**The trace comment (coach-fixes, the server part).** In an interview the user writes the trace as a comment, so
the code itself is the only traced/untraced source (the card is going: extension-tidy removes it; nothing here reads
it). At ingest (`lcSittingEvents`), the earliest snapshot in the batch (a repeat too, so a retry finishes a call that died midway) before the sitting's first judged event (stored or in
the same batch) whose code holds a trace comment becomes the server's own head row — type `trace-comment` (never an
extension event), at the snapshot's time, keyed by its event id, once per sitting (`traceCommentRow`). The rule
(`traceComment.ts`, no model): a block is a Python `"""`/`'''` string, a `/* */`, or a run of at least 3 `#` or
`//` lines; it is a trace when it has an input line (`name = <literal>`, or one opening with input / example /
trace) and at least 2 other step lines (a digit and one of `->`, `=>`, `→`, `=`, `:`, `|`); LeetCode's starter
comments (`:type`, `@param`, "Definition for") never count; a block not yet closed isn't one. Known limit: three
commented-out literal assignments read as a trace.

The fold sets `summary.commentTrace`: `traced` from a `trace-comment` row with nothing judged before it; the first
Run or Submit sets `summary.firstJudgedAt` and `commentTrace` `none` unless already traced. Absent until judged, and
on sittings folded before the rule, which count nowhere — except a sitting open across the deploy: its next fold reads
`none`, its earlier snapshots never scanned (at most one, accepted). The coach's `traced` (stats, the Patterns tab),
`live_sitting.trace`, `get_sitting.trace`, the review's suggested cause and the draft's trace signal all read it.

### Claude watches live

The MCP tool `live_sitting` (`lambdas/src/mcp/leetcodeTools.ts`, over the `pullLiveSitting` RPC) is how Claude
sees a sitting while it happens: the problem, minutes since Start, the newest code in full, the newest Run and
Submit with the failing case, expected vs output and the error head (`judgeDetail`),
counts, LeetCode's timer, editing facts. The Start gate names the open sitting; a sitting is open while
`active` and inside its 24 h window (`isSittingOpen`). One past it reads closed with nothing written, and the
next Start ends it. With nothing open, the tool names the most recent sitting instead: one left active past
its window is marked `expired: true`, its minutes stopped at the window.

- **Freshness.** Code is at most ~30 s behind: the extension sends one snapshot per 30 s (the latest code)
  and the pending one right before each Run or Submit. A Run or Submit judged after the maintainer leaves the page
  still lands in its sitting (PR A2), so a pull a minute later may show more.
- **One read.** The head rows (compact, `hd#`) give the counts and which Run and Submit are newest, and only
  those two payloads (`jd#`) are read in full, so a verdict, its failing case and the counts always agree. A
  payload that never landed leaves its case null rather than borrowing an older one's. Every read is strongly
  consistent, so a pull right after a Start, snapshot, submit or Done sees it.
- **A pull counts.** Each pull of an open sitting adds one to its count row, by an atomic add on a row of its
  own. It isn't on the head, because a refold rewrites the head whole and would drop a concurrent add; and a
  conditional write would make ingest retry. The count is taken only once the reads are in hand, and a failed
  count still answers, with the stored one. A pull with nothing open writes nothing. The app never calls
  `pullLiveSitting`: a pull is Claude watching. A pull racing `deleteSitting` can leave its count row behind
  the sweep; nothing reads it.
- **Cost.** A pull reads the gate, the head, the head rows, the live row (up to 64 KB) and two payloads (up to
  96 KB each), all strongly consistent: typically ~5 read units, ~60 at the caps, plus 1 write unit. At 60 pulls
  a sitting and ~45 sittings a month that's cents; no fixed part.

### Review and the Claude draft

A sitting's review is the user's own words, on the head (`review`, `setSittingReview`): a one-liner, how much help it
took (`none` / `hint` / `solution`), up to 8 mistakes, how it went, up to 10 of the user's own pattern tags, and
`draftUsed`. One normalizer (`normalizeSittingReview`) folds whitespace, lowercases and dedupes the tags, refuses
anything over a cap naming the field, and turns a review that says nothing into `null`. It's on the head, not a
row of its own, so the list's reviewed dot and `list_sittings` read it free; a refold spreads the head and keeps
it, and a review and a refold racing are both CAS writes over the current head. Writable at any status, an open
sitting included. The form starts help on `hint` once a submit failed before the accepted one (`suggestedHelp`).
The form also carries the coach's cause chips and labels `solution` as **Peeked**; how it keeps a help or cause
Claude set over MCP while it was open: [coach.md → In the app](coach.md#in-the-app).

**Draft with Claude** (`draftSittingReview`) is a button, never automatic: one Haiku call (`claude-haiku-5-5`,
`lambdas/src/anthropic/sittingReviewPrompt.ts`, snapshot-tested) over the problem, the newest 8 judged Runs and
Submits with their cases (each field ≤ 400 chars), and the code at the first submit and the final code (≤ 4 KB
each; the user's code goes to the API — decided). It proposes **mistake lines only** — at most 5, each ≤ 160
characters, each naming a failing case or a concrete code change, describing and never judging; the one-liner and
how it went are never drafted. The same call proposes the coach's one cause tag or null, from the cases and four
signals: a suggestion for the form's cause ([coach](coach.md) → _The draft's cause_). The answer is made fit (`draftMistakes`,
`draftCause`): a line over 160 is cut to 160 ending "…" and only the first 5 are kept; only an answer that isn't a
list of text is `bad-shape`, and a cause that isn't a tag is null, the lines kept. It writes
nothing: the lines arrive unticked and editable, "Use all" ticks them, and only the ticked ones reach the review on
Save. Nothing judged yet → `nothing-to-draft` with no model call; a failure says why inline and the form keeps
working. A smoke run never reaches the model; the log line carries counts, never code. Cost: ≈ 2.5k tokens in and
150 out at $0.10 / $0.50 per MTok ≈ $0.0003 a draft — at one or three a sitting, ≈ $0.015–0.04 a month of API
credit; no AWS cost.

### Reading a sitting back

`get_sitting {id?}` (no id: the newest sitting) and `list_sittings {from?, to?, limit?}`, both read-only, for the
talk-through after a sitting and for prep planning. `get_sitting` carries the problem statement as text
(`problemStatementText`, ≤ 3 KB) and the companies that asked it lately (`problemCompanies`), the timeline
(`timelineOf`: every judged Run and Submit with verdict and case, each case field ≤ 300 chars, the newest 30, and
`codeChanged` markers counting the snapshots between them — snapshots expire with the raw bulk, so an older
sitting has none), the final code in full, editing facts and the review. `list_sittings` rows are heads only:
day, problem, status, minutes, outcome, prep target, `reviewed` and the user's tags; at most 100, `more` when cut.

### Storage and expiry

Kept forever: the head, the live row, the live-pull count, the head rows and the runs', submits' and notes'
payloads, the problem doc. The **raw bulk** — snapshot and submit-detail events, replay chunks — is stamped `expiresAt` at write: 14
days past the sitting's 24 h ingest window, deleted by DynamoDB's TTL (free). This is prod's one TTL'd row kind
(TECH §2.3 rule 4), chosen so storage doesn't grow with keystrokes: kept data is ~25 KB a sitting. Every item
builder strips table attributes from the entity it writes, so no patched-in `expiresAt` (or `PK`) can ride a
write. Tombstones (a deleted sitting's rows, its problem doc once unused) carry only keys, `id`, `deletedAt`
and `updatedAt`, keeping a raw row's `expiresAt`. Export carries alive sittings' heads, live rows, head rows and
problems; payloads, the raw bulk and the replay stay out (bulk, and the export is one Lambda response — whose
6 MB limit the whole export will meet eventually, a follow-up beyond this module).

### Ingest: the device token and the caps

`lcSittingStart` and `lcSittingEvents` (`LC_INGEST_METHODS`) take the extension's device token (compared as
SHA-256 digests) **or** the user's JWT (the dev check drives them as the test user); every other method —
every read — is JWT only, so a device token anywhere else 401s. Ingest bodies over 300 KB are refused before
parsing (413). Sizes are UTF-8 bytes. Per call ≤ 50 events / 256 KB; per event type a size cap (snapshot ≤
64 KB, run/submit ≤ 96 KB …); payloads nested ≤ 20 deep with exact numbers (what DynamoDB stores as given);
per sitting ≤ 3,000 events / 16 MB, any type, held by a **budget row** (`lcs#<id>#budget`) that every call
reserves in — a CAS, duplicates included — before writing anything, so parallel calls and retries can't pass
it; the Start gate's ≤ 100 Starts and ≤ 400 attempts a day (1000 and 4000 on a dev slot, by the BFF's `STAGE`:
DEV-CHECK.md → _Dev slots_); events refused 24 h after Start, or timed off the
sitting's clock. **The grace:** for 10 minutes after its end (`SITTING_END_GRACE_MS`; Done, Drop or a later
Start — never past the 24 h window, so a sitting ended for staleness gets none) a sitting still takes the events
stamped before the end on the extension's clock, plus 60 s for the Start's latency (`SITTING_END_SKEW_MS`) —
the outbox's retries land after Done. The rest of the call is skipped, not refused, and the budget reserves
only the kept events. Past the grace every call is refused — except on a sitting closed by idle, which takes them
for its whole window, or reopens (_Idle close_). A known risk, accepted as unlikely: a late call
racing a delete (`tombstoneSitting` queries the children, then tombstones them) can leave a late raw or judged row
under a deleted sitting — possible only in the 10 minutes after a Drop followed by a delete. Each event is idempotent on its id. The server recomputes everything
it decides on (`userId`, `day`, `startedAt`, verdicts, counters); payloads are opaque.

**Statuses** (the extension's outbox retries 409, 429 and 5xx; anything else it keeps as failed): 200
`{accepted, duplicates, skipped, version, status}` — inside the grace `status` is `done` or `abandoned` (the
extension learns the end from it) and `skipped` counts the after-end events, even when all were; 400 a refused
input (`SITTING_ENDED_ERROR` past the grace) (our own refusals, and an AWS error with a 4xx status such as `ValidationException`), 401 a bad token,
409 a lost race (`ConflictError`), 413 over the body cap, 429 DynamoDB pushing back (incl.
`RequestLimitExceeded`), 500 any other AWS fault or a bug in our code (a `TypeError` is retried, never dropped).

**A leaked device token** (or a hostile leetcode.com page driving the extension, which can use the token
without seeing it — the server caps are the boundary, not the token's secrecy): within the caps it can make
junk sittings (visible reps, each renamed once — and a linked calendar event with it) and write events — into
the open sitting too, so it could forge that sitting's headline. It can read only what Start and Events return
(the open sitting's head, by trying slugs), end only stale or half-made sittings, use up the day's 400 Start
attempts (then the user's own Starts are refused until the LA day rolls over — accepted, visible), and never delete, mark a task
done, or reach another partition. `problem.raw` is LeetCode's HTML: nothing renders it today, and anything that
ever does must sanitise it.

### The page

`/recruiting` → **Sittings**: the open sitting pinned with its running clock, the rest by day with the
outcome (`first submit accepted` / `accepted on submit N` / `not accepted` / `no submit yet`, or `no submit` once ended), runs, and
`dropped` (or `closed automatically`, _Idle close_); a dot marks a reviewed one. Patterns ([coach.md](coach.md) → _The Patterns tab_), Progress ([coach.md](coach.md) → _The Progress tab_) and Stories are the other tabs.

Each row opens **`/recruiting/sittings/:id`**: the problem (linked to LeetCode) with its tags and companies; the
outcome, time to first submit, duration, runs and submits, and "Claude watched live · N pulls"; the timeline
(teal accepted, gold otherwise — never red — with the failing case folded away); the final code, collapsed; and
the review form, one Save for all of it. While the sitting is open and its rep in progress, **End sitting** opens
the rep's Done form prefilled with the sitting's minutes (Start to now) and the Roll's estimate when the rep lost
one; Mark done ends the sitting through the rep, Cancel writes nothing. On Home, a LeetCode rep whose sitting is
open links to that page ("End the LeetCode sitting →"), shows the sitting's minutes (not the rep's own, 0 while
no timer ran), and its Done prefills from the sitting too, the Roll's estimate included; the list is read only while a LeetCode-roll rep is in progress, so an ordinary day costs no
read. Both Done forms wait for the Rolls before opening — the form copies its estimate once, so it must be the
Roll's, not the 30-minute fallback (used only when the Rolls can't be read).

A sitting closed by idle says **"Closed automatically: 45 min with no activity"** on its page, with **Reopen**
while the server would take it (a refusal shows inline, the button kept) and, while its rep is in progress,
**Mark rep done**: the rep's Done form on the minutes up to the close. Home links its rep there ("LeetCode
sitting closed automatically →") with those minutes and that prefill.

## The shape

Two paths that only meet at one place: the userId under which rows are written and read.

```
WRITE ─ browser extension ─────────────────────► device token ─┐
                                                                ├─ same DynamoDB PK
READ  ─ the PWA at /recruiting ────────────────► Cognito JWT ──┘
```

### Write path — capture

The full mechanics (the overlay's steps, the event mapping, statuses, storage keys) are
`extension/README.md`; this is the outline.

```
leetcode.com/problems/<slug>   (your tab)
  │  LeetCode's OWN traffic: updateSyncedCode (your code as you type), /submit/ + /v2/check/,
  │  /interpret_solution/ + /check/, submissionDetails, questionDetail, updateNote, the replay stream
  ╎  observed — never blocked, altered, or re-issued
  ▼
inject-main.js          [MAIN world, document_start] — evidence only
  • patches window.fetch + XMLHttpRequest; ships the raw URL, request and response text (a blob XHR's
    read as text: Safari's GraphQL) — parses nothing
  • each message tagged HMAC-SHA256(per-load nonce, body) with a sequence number
  │  dispatchEvent(CustomEvent("aperture-lc"))  — nothing ever comes back
  ▼
content.js              [ISOLATED world]
  • the relay: tag, sequence, raw shape; lib/wire.js parses here; then the problem on screen (its own
    location) and a sitting it opened → else dropped; a problem doc is kept by its own slug, used on screen
  • the overlay (closed shadow roots): Start → lcSittingStart → LeetCode's reset → its confirm → its timer
  • the binding sitting:<slug> (a reload resumes); LeetCode's QD_TIMER_STATE every 2 s; 3 s batches,
    one snapshot per 30 s (the latest — live code ≤ 30 s behind)
  ▼   runtime.sendMessage()
background.js           [extension event page]
  • storage.local → { apiOrigin, deviceToken }; the outbox (persisted, one in flight, in order, backoff)
  │  POST <apiOrigin>/api/lcSittingStart | lcSittingEvents
  │  x-aperture-authorization: Bearer <deviceToken>
  ▼
CloudFront (stamps ORIGIN_SECRET) → Lambda Function URL — lambdas/src/index.ts
  • LC_INGEST_METHODS take the device token (resolveDeviceUserId) or the JWT; everything else the JWT
  ▼
BackendClient.lcSittingStart / lcSittingEvents  — _Sittings_ above
```

### Read path

```
PWA /recruiting → useSittings() → api.listSittings(range?)        (every task write invalidates it: a Done ends one)
  │  Cognito JWT, same-origin /api/*
  ▼
Lambda → resolveUserId → userId = JWT `sub`
  ▼
Repo: query PK=u#<sub>, SK begins_with 'lcsit#' → range filter by day → sort startedAt DESC
  ▼
recruitingHelpers.sittingOutcome()   ← "first submit accepted" … derived at render (sittingMetrics), never stored
```

The legacy attempts' read path (`listLeetcodeAttempts`, the Attempts tab, `list_leetcode_attempts`) was
removed at A1, and their write path (`recordLeetcodeAttempt`, its dedup scan, the `sk.lc*` keys) at PR D.

## Design decisions worth not re-litigating

**The extension is 100% passive toward LeetCode.** It never issues a request _to LeetCode_ — it only
observes calls LeetCode already made. No scraping, no polling, no automation. (It does make exactly one
request of its own: the `POST` to our own backend.) That's the best ToS posture available and the reason
this exists as an extension rather than a scheduled scraper.

**The problem doc is LeetCode's own `questionDetail`, the DOM the fallback.** A fresh load carries it
server-rendered in `__NEXT_DATA__`, and LeetCode fetches it after a submit, and for the next problem from
the old page before the Next click (2026-11-08 capture; 2026-11-10 and 2026-11-13 debug logs; Safari over blob
XHRs). So the extension keeps a fetched doc by its own slug, used only while the address names it, and reads
the page's copy, for the problem the document was loaded for only, as names and text — never a question id —
and a fetched doc wins over it; without either,
Start reads title, difficulty and tags off the page (degrading to a slug-derived title and `null`s). A doc
that comes after the Start goes in a repeat Start that fills it in. How, and the 64 KB fit:
`extension/README.md` → _The sitting, from LeetCode's side_, step 8. Don't add a fetch of our own for it: the
extension stays passive.

**The Submit hold is the one place the extension stands between the user and LeetCode's UI** (the
maintainer, 2026-11-16: hold once, re-click). The first real Submit click of a sitting is swallowed so the trace
card can ask for three hand-traced inputs; no request is made, altered or re-issued, and the user clicks Submit
again. The extension never clicks Submit — an automated submit was rejected. It fails open (a keyboard submit,
a missing selector or the hold off pass untouched and are logged `untraced-submit`), and each part is off-able
in Options. How: `extension/README.md` → _The sitting, from LeetCode's side_, step 9.

**The page's world is evidence, never authority** (the maintainer, 2026-11-08). Any script on leetcode.com can
spoof what the MAIN world sees, so: only the isolated-world overlay can Start a sitting, on a real click on
an overlay that is really showing; a page message can only add events to the sitting the extension itself
opened, for the problem in the tab's address and made from that problem's page (a run or submit made there
and judged after you left goes to that problem's open sitting); nothing from Aperture ever flows back into the page (the
overlay's shadow roots are closed — the page sees only whether it shows); and messages carry an HMAC tag
keyed by a per-load nonce, with a sequence number. The MAIN world ships raw text and the isolated world
parses it; everything MAIN calls is bound at load, and `then` is pinned on what its promises settle with, so
the key can't be read and a later patch can't make what's recorded differ from what LeetCode got; a Response
counts only if the browser fetched it from leetcode.com (`extension/README.md` → _How it works_). A Start is
never forged: Aperture is asked first, and only the overlay asks. **Accepted residual:** a hostile
leetcode.com script that patched `fetch`/`XMLHttpRequest` or the built-ins before our script ran (Safari may
run ours late), drives the real editor, fakes traffic LeetCode itself receives, hides an event from us, or
points the address at the open sitting's problem can still forge or lose events in the one open sitting —
the server's caps are the boundary.

**The server owns normalization.** The extension ships raw signals (`status_code`, `status_msg`,
`tzOffsetMinutes`) and stays dumb, because it can't import from the workspace and shouldn't need
redeploying when a rule changes. The server owns the verdict enum and — since it owns `dayStartHour` —
the day bucket. That's why the input shape isn't the `createLogEntry(text, day)` shape.

**Idempotency is on the extension's ids.** A Start repeats on its `clientSittingId` (a reload, a retry, a
second tab) and resumes; every event carries its own ULID, so a resent batch counts its repeats as
duplicates. (Legacy attempts were idempotent on `leetcodeSubmissionId`.)

**Attempt count is derived, never stored.** A stored counter is a second source of truth that drifts.

**The device token is scoped to the ingest methods** (`LC_INGEST_METHODS` — _Ingest_ above). It's a static, long-lived key sitting in browser
storage — a different risk class from a JWT. A device token sent to any other method falls through to
`resolveUserId`, isn't a valid JWT, and 401s. Comparison is `timingSafeEqual`.

## Files

| Path                                                     | What                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/`                                             | MV3 web extension — Safari (wrapped in an Xcode app); the Firefox AMO install is retired. No runtime deps, no bundler, no build step. `README.md` there is the wire contract, how it works and the Safari build steps; `test/` its unit and jsdom tests. |
| `scripts/src/lc-e2e/`                                    | the extension's E2E: headless Chromium, a fake LeetCode page, A1's BFF run locally                                                                                                                                                                       |
| `packages/shared/src/types.ts`                           | `Sitting`, `SittingLive`, `SittingEvent`, `SittingReplayChunk`, `LeetcodeProblem`, `LeetcodeVerdict`                                                                                                                                                     |
| `packages/shared/src/sittings.ts`                        | the sittings' rules: normalizers, caps, `planSittingStart`, folds, `sittingMetrics`, the raw expiry; the review's normalizer, the draft's validator, `timelineOf`, the problem doc's text                                                                |
| `packages/shared/src/api.ts`                             | the sitting methods, `SittingDetail`                                                                                                                                                                                                                     |
| `packages/shared/src/leetcode.ts`                        | `normalizeVerdict` — status_code first, status_msg fallback; `LC_INGEST_METHODS`                                                                                                                                                                         |
| `packages/shared/src/dates.ts`                           | `dayKeyForOffset` — bucket by the client's tz + `dayStartHour`                                                                                                                                                                                           |
| `packages/shared/src/contractTests.ts`                   | one suite, run 3× — stub, backend direct, backend via handleRpc (`lc sittings`)                                                                                                                                                                          |
| `app/src/pages/Recruiting/`                              | `SittingsSection.tsx` + `recruitingHelpers.ts` (outcome, summary, grouping, verdict tone); `SittingDetail.tsx`, `SittingTimeline.tsx`, `ReviewForm.tsx` — the sitting's page                                                                             |
| `app/src/data/hooks/useSittings.ts`                      | the list and one sitting, the review save, the draft (a mutation), `useOpenSittingFor` (Home)                                                                                                                                                            |
| `app/src/pages/Home/RightNowCard.tsx`                    | the rep's link to its open sitting, and Done's prefill from it                                                                                                                                                                                           |
| `lambdas/src/anthropic/sittingReviewPrompt.ts`           | the draft's prompt, data and output schema (`gateway.ts` / `liveAnthropic.ts` carry the call)                                                                                                                                                            |
| `app/src/pages/Settings/index.tsx`                       | `LeetcodeSection` — the roll a sitting is a rep of                                                                                                                                                                                                       |
| `lambdas/src/index.ts`                                   | the ingest gate: device token or JWT for `LC_INGEST_METHODS`, the 300 KB pre-parse cap                                                                                                                                                                   |
| `lambdas/src/auth/verify.ts`                             | `resolveDeviceUserId`                                                                                                                                                                                                                                    |
| `lambdas/src/backend.ts`                                 | the sitting methods, the rep's end hooks, `pullLiveSitting`                                                                                                                                                                                              |
| `lambdas/src/mcp/leetcodeTools.ts`                       | `live_sitting` — _Claude watches live_; `get_sitting`, `list_sittings` — _Reading a sitting back_                                                                                                                                                        |
| `lambdas/src/ddb/keys.ts`, `repo.ts`                     | `lcsit#` / `lcs#<id>#…` / `lcq#` keys; `lc#` holds the legacy rows, read-only (no writer)                                                                                                                                                                |
| `cdk/src/lib/data-stack.ts`                              | TTL on `expiresAt` (both stages)                                                                                                                                                                                                                         |
| `packages/shared/src/coach.ts`, `neetcode150.ts`         | the LeetCode coach's engine and catalog — [coach.md](coach.md) (its own files table)                                                                                                                                                                     |
| `scripts/src/devcheck/scenarios/lc-sittings.ts`          | the dev check's rows for sittings                                                                                                                                                                                                                        |
| `scripts/src/devcheck/scenarios/lc-extension.ts`         | the dev check's rows for the extension (all off dev or Needs you)                                                                                                                                                                                        |
| `cdk/src/config/ciSecrets.ts`, `cdk/src/bin/aperture.ts` | `stageSecret('DEVICE_TOKEN', stage)` / `deviceUserIdFor`                                                                                                                                                                                                 |

## Operator setup

### 1. GitHub secrets (do this before the first deploy)

- [ ] **secret** `DEVICE_TOKEN_DEV` — any long random hex string (`openssl rand -hex 24`).
- [ ] **secret** `DEVICE_TOKEN_PROD` — a _different_ one, in the `prod` GitHub environment (`gh secret set DEVICE_TOKEN_PROD --env prod`), not repo-level.
- [ ] **secret** `DEVICE_USER_ID_DEV` — your **dev** Cognito `sub`, repo-level.
- [ ] **secret** `DEVICE_USER_ID_PROD` — your **prod** Cognito `sub`, in the `prod` environment (`gh secret set DEVICE_USER_ID_PROD --env prod`).

The `sub` grants nothing, but it identifies the account, and a variable would print in clear in every public run log; a secret prints `***` (INFRA §9 → Public repo). They were repo variables until `deploy-log-quiet` (2026-11).

Both pairs are load-bearing:

- `DEVICE_TOKEN_*` unset or misnamed → the CI synth **fails, naming the secret** (`stageSecret`, since
  prod-secrets). Before that guard, each CI deploy minted a fresh random token, so the token saved in your
  extension options silently stopped matching after any deploy. (A _local_ `cdk synth`
  reuses the gitignored `cdk/.secrets/device-token.<stage>` file, so it's stable there — which is
  exactly why this is easy to miss until CI runs.)
- `DEVICE_USER_ID_*` unset → the CI deploy **fails in deploy-stage's `Validate mode`, naming the secret**
  (dev and prod; devb never has one). Before that check, the handler fell back to userId `'local'`, so
  attempts were written under `u#local` while the page read under `u#<your sub>`: **capture worked, the
  page stayed empty, and nothing errored anywhere** — still what a wrong value, or a local synth with
  no `device-user-id.<stage>` file, does. The single most confusing failure mode in the feature.
- `DEVICE_USER_ID_*` also gates the **finance sync schedule** ([finances/](../finances/index.md)): unset →
  no schedule on that stage — only devb or a local synth now, since dev and prod CI refuse it (Refresh
  still works); wrong → the schedule syncs an empty partition,
  silently.

Find your `sub`: sign in to the app, then decode the access token's payload, or read it from the Cognito
console (User pools → your pool → Users → the user → "sub" attribute).

### 2. Load the extension

See **Deployment & install** below — the setup differs depending on whether you're capturing for real or
validating a stage.

## Deployment & install

### The origins

| Stage | Origin                                |
| ----- | ------------------------------------- |
| prod  | `https://aperture.rahuldatta.dev`     |
| dev   | `https://dev.aperture.rahuldatta.dev` |

Both have been live on their custom domains since 2026-08 (INFRA §8). **There is no local origin** — the
Vite dev server has no `/api/*` route and there's no local API script, so "point it at localhost" has
nothing on the other end. "Dev" here always means the deployed AWS stage, never your machine.

### Three layers, each matched to its job

Safari has been the daily browser since 2026-10-04. The Firefox install below is **retired and removed**
(2026-11-10): it ran v1, whose write PR D removed; the AMO notes stay as the record of how it was signed.

**1. Daily driver — the Safari prod app, prod origin, a dedicated Recruiting Safari profile.**
The LeetCode tab group lives in that profile; the personal profile has neither build.
This is the only one that needs to be permanent, and it genuinely does: a temporary extension you forgot
to re-load after a restart doesn't error, it just silently stops capturing. Same silent-failure family as
the identity seam. Build: `extension/README.md` → _Build it for Safari_.

**2. Stage validation — the Safari dev app (red icon), dev origin, an "Aperture Dev" Safari profile.**
A second app with its own bundle ID (`…ApertureLeetCodeDev`), so its options are separate, ticked in
that profile for good while prod is never enabled there — exactly one capture path per profile, so real
practice never lands in dev. Its Xcode project references `extension/` live, so picking up a code change
is a rebuild plus the re-copy (README step 4). This is where the four ingest checks get run.

**3. Extension code iteration — the dev app, or a temporary extension, no endpoint needed.** See
_Testing_ → "Extension against no live endpoint" (the log strings, and how the capture half was verified
on 2026-08-09).

### Safari: free signing (layer 1 and 2)

**A free Apple ID Personal Team signature is enough** — built in Xcode, signed `Apple Development`,
Safari lists and keeps it across quit and reboot with "Allow Unsigned Extensions" off (verified
2026-10-04). This contradicts the earlier research, which assumed only a paid Developer ID gives a
permanent install. Unsigned and "Add Temporary Extension" builds reset on quit (or after 24h) — fine for
layer 3, never the daily driver.

**The free certificate expires 2027-09-28.** What Safari does at expiry is unverified, and so is
renewal: a rebuild before then likely re-signs with the same expiring certificate. Renew it in Xcode →
Settings → Accounts → Manage Certificates (or rebuild after expiry), then rebuild both projects (README
steps 2–4).

The packager warns that `world` is unsupported — wrong: `world: "MAIN"` works in Safari 26 (capture
verified end-to-end 2026-10-04). An extension that isn't enabled in the _current_ profile just looks
like a failed patch (`window.fetch` stays `[native code]`).

### Loading a temporary extension (layer 3)

Only in the "Aperture Dev" profile, in the dev app's place: untick the dev app while it is loaded, and tick it
again after. Safari: Settings → **Developer** → **Add Temporary Extension…** → this repo's `extension/` folder, then
tick it under Extensions → _Temporary_ (the Developer tab needs Settings → Advanced → _Show features for
web developers_; Apple, "Running your Safari web extension", checked 2026-11-13). Options: README →
_Configure_.
Safari drops temporary extensions on quit or after 24 h; re-add each time — acceptable for iteration,
not for the daily driver.

### Firefox: signing via AMO (2026-09-08; retired and removed 2026-11-10)

Firefox's layer 2 was a temporary add-on in a **separate Firefox profile** (`about:profiles` → create a
profile → load it from `about:debugging`): separate profiles have separate extension storage, so there's
no ID collision with the signed copy and no chance of real practice landing in dev.

Firefox **Release and Beta enforce extension signatures and cannot be told not to** —
`xpinstall.signatures.required` only takes effect on Developer Edition, Nightly, and ESR. So permanent
install means signing.

Signing does **not** mean publishing. addons.mozilla.org accepts **unlisted** submissions: upload the
zipped extension, get back a signed `.xpi` for self-distribution, never shown in the public directory,
free. Install it via `about:addons` → gear icon → **Install Add-on From File**. Each new upload needs a
`version` bump in `manifest.json`.

**The extension ID is permanent once signed.** It's `aperture-leetcode@rahuldatta.dev` — changing it
later makes it a _different_ add-on, meaning a reinstall and a lost stored token. Settle it before the
first submission, not after.

**`data_collection_permissions` is required.** New submissions are rejected without
`browser_specific_settings.gecko.data_collection_permissions`. We declare `{"required": ["none"]}` —
attempt data goes only to the user's own backend, with no third party, and the `required` enum accepts
only sensitive categories (PII, health, financial, auth, personal communications) plus `none`. Activity
categories like `websiteActivity` exist **only** in `optional`, which would create a user-toggleable
consent the extension doesn't check before POSTing — worse than not declaring it.

**Two AMO error messages that mislead.** A schema failure can surface as _"Your add-on should end with
.zip, .xpi or .crx"_ on a perfectly valid `.zip` — ignore the filename advice and look for the real
error in the validation results. And the review-history panel may render raw `$action_label` /
`$comments` template placeholders; that's an AMO front-end bug, not information about your submission.

**Status: signed and permanently installed, 2026-09-08.** AMO cleared it in under an hour, against
Mozilla's own stated 3-days-to-3-weeks range for anything entering manual review — treat the fast path
as luck, not the expectation. Verified by restarting Firefox and capturing a submission afterward, which
is the specific thing a temporary add-on cannot do.

**Do not re-upload a version to hurry a pending submission** — Mozilla staff confirmed (2026-03)
that resubmitting **resets your queue position**. Polling the API doesn't help either. If a future
version sits more than 48–72 hours, posting on discourse.mozilla.org is the only lever observed to move
things.

### Why not two permanent installs (one per stage)

**Firefox** (the reasoning while it ran; retired 2026-11-10): two simultaneously-installed copies need two distinct `browser_specific_settings.gecko.id` values —
the ID _is_ the add-on's identity. That's two manifests, two names, two AMO submissions, and two signing
rounds on every change, forever. And what it buys is two live capture paths, which is the opposite of
what you want: real practice should land in exactly one stage. A separate profile gets the same
isolation for free.

**Safari does run two** — a second bundle ID costs one more free Xcode build and no review, and per-profile
enabling still keeps exactly one capture path per profile.

### What ever invalidates the setup

The token exists in three places — the GitHub secret (source of truth), the Lambda env var (re-derived
automatically on every deploy), and the extension's `storage.local` (manual, **never** syncs). Only the
third one is ongoing work, and only for these events:

| Event                                                                                | What you redo                                                                                                                           |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Any normal deploy                                                                    | **nothing**                                                                                                                             |
| Rotating the token deliberately                                                      | update the GitHub secret → redeploy → re-paste in the extension                                                                         |
| Cognito pool replaced                                                                | new `sub` → update the GitHub var → redeploy. Data stack is `RETAIN`, so realistically never                                            |
| Origin changes                                                                       | re-paste `apiOrigin` + re-grant the host permission. Not expected; the domains have been live since 2026-08                             |
| New browser / profile / machine                                                      | paste the origin and token there — Options start blank in each profile (`storage.local` is per-profile)                                 |
| Browser restart (temporary extension only)                                           | re-add it. The installed apps are unaffected                                                                                            |
| Free Apple certificate expiry (2027-09-28)                                           | rebuild both Safari projects in Xcode, re-copy to `/Applications`, delete DerivedData                                                   |
| Apple Development cert revoked or replaced (e.g. Xcode on another Mac, a cert reset) | the extension stops loading — rebuild both projects. Development signatures carry no secure timestamp, so they don't outlive their cert |
| Extension code change                                                                | rebuild per README → _Build it for Safari_ (prod: re-copy files first; both: redo step 4)                                               |

**Every "paste the token" above needs its current value.** A GitHub secret can't be read back, so the
Lambda is the only place to recover it. Run on the Mac (the container has no AWS credentials), with
`<stage>` as `prod` or `dev`:

```
aws lambda get-function-configuration --function-name aperture-bff-<stage> --region us-west-1 --query 'Environment.Variables.DEVICE_TOKEN' --output text
```

While Firefox ran (retired 2026-11-10), storage was keyed by extension ID, so the token was expected to
survive the temporary→signed move with the ID unchanged. In Safari a Temporary Extension and the Xcode
app are separate extensions, so each one needs the token entered in its own Options.

### The Chrome alternative (no signing)

Chrome **persists unpacked extensions across restarts** (`chrome://extensions` → Developer mode → Load
unpacked) — the one property Safari's temporary extensions lack (layer 3). It nags with a bubble but stays loaded.
Chrome has supported `world: "MAIN"` since 111, and the code already does `browser.*` with a `chrome`
fallback. But the Chrome path is **untested** (see Open items), so this trades the free Xcode build for an
unknown amount of debugging. Only worth it if you already live in Chrome.

## Testing: what each surface proves

There are **three** testable surfaces here, not two, and conflating the first two is easy: the extension
never talks to the app's dev server. It POSTs to whatever origin you type into its options page, so
`pnpm dev` is irrelevant to it in both directions.

|           | App locally (`pnpm dev`)         | Extension, no live endpoint | dev stage (deployed)        |
| --------- | -------------------------------- | --------------------------- | --------------------------- |
| API       | `StubClient`, localStorage       | —                           | real Lambda + DynamoDB      |
| Auth      | bypassed, `local@aperture.dev`   | —                           | real Cognito JWT            |
| Data      | `seed.ts` (5 attempts, two arcs) | —                           | what you actually submitted |
| Proves    | the whole UI surface             | interception + DOM scrape   | the ingest half             |
| Iteration | instant HMR                      | reload the add-on           | full CI deploy              |

**App locally** proves the page renders, ordinals and the summary line are right, verdict tones are
right, all three list states (loading / error / empty) are right, and the ApiClient contract holds —
including that the export carries every collection and no tombstones. That's the entire UI, which is why it
was built this way — page-first, backend-second. There is no `/api/*` proxy on the Vite server and no
local API script, so this surface never involves the extension.

**Extension against no live endpoint** is a real test and was how the capture half got verified on
**2026-08-09**. Load the add-on, submit on leetcode.com, watch the console — `background.js` logs the
outcome either way (`recorded attempt … -> 200`, `backend rejected attempt … <status>`, or `failed to
POST attempt …`). Everything upstream of the POST runs normally. This is how the GraphQL→DOM correction
was found: the interceptor was watching for a `questionData` call that LeetCode never makes.

**The extension's own tests (A2)** cover what used to need a live tab: `extension/test/` runs the real
scripts — the page-world capture in jsdom over both transports, both worlds over a fake LeetCode page, the
background in a vm — and `scripts/src/lc-e2e/` runs the real extension in headless Chromium on that fake
page (served at `leetcode.com` by a route) against A1's BFF locally, as the test user. None of them prove
Safari or LeetCode's real DOM: real Safari sittings do — proving the shipped selectors (the debug session
found them) and one sitting against dev (the `lc-extension` scenario's _Needs you_ rows).

**Only a deployed stage** can prove the ingest half — no test covers any of it:

1. The device token round-trips: extension → CloudFront → `resolveDeviceUserId` → 200.
2. **`DEVICE_USER_ID` matches your JWT `sub`** — the seam above. Only observable end-to-end.
3. Day bucketing lands on the right day for a real submission in your real timezone.
4. Idempotency under a real double-fire.

**All four verified on dev 2026-09-07** (and previously 2026-08). A wrong-then-correct pair on `two-sum`,
6s apart, produced two rows with the right verdicts, `userId` matching `DEVICE_USER_ID_DEV`, and
difficulty + topic tags captured. Day bucketing is the one worth spelling out: submitted 22:57 PDT on
2026-09-07 (05:57 UTC on the **8th**) and stored as `day: "2026-09-07"` — naive UTC bucketing would have
filed it on the wrong day, so the tz-offset + `dayStartHour` path is genuinely exercised.

So none of these are unknowns; they're re-verify-on-drift, alongside the interceptor matching LeetCode's
live request shapes. Two things silently invalidate them: LeetCode changing its request or page shape,
and a **prod** run being the first exercise of a separate stage's secrets (different token, different
Cognito pool, different `sub`).

Since a submission is a real write to real data, dev is where you do this — not prod. Smoke tests use
`testMode` with a synthetic user and a no-op writes object, so they never exercise the ingest path.

### Watching an ingest

Sittings log `{"event":"lc_sitting_start","sittingId":…,"attach":bool}` per Start,
`{"event":"lc_sitting_idle_close","sittingId":…,"idleMs":n}` per idle close (`idleMs`: from the end to its noticing),
`{"event":"lc_sitting_reopen","sittingId":…,"via":"button"|"start"|"event","idleMs":n}` per reopen (and
`lc_sitting_reopen_refused` when an event's return was refused), and
`{"event":"lc_ingest","sittingId":…,"accepted":n,"duplicates":n,"skipped":n,"late":bool,"bytes":n}` per events
call (`late`: the sitting had ended; `skipped` is what the grace dropped) — never code or payloads. The legacy
ingest's `{"event":"leetcode_ingest",…}` line went with it at PR D, so one appearing in a log predates that deploy.
Watching is a CloudWatch Logs Insights query, deliberately **not** a custom metric: at $0.30/month a metric would be
the single largest line item in this project. A refused legacy call (a stray v1 build) logs nothing server-side —
it's only a Lambda invocation and a 401 in that browser's extension console.

## Open items

- **LeetCode's controls are set from the maintainer's debug session (2026-11-10)** (`extension/README.md` →
  _LeetCode's controls_), and proven in Safari the same day: from a running countdown, a paused one and an idle
  one (the opener reads "Timer"). Still unproven: an expired countdown's state.
- **One real Safari sitting on dev** through the temporary extension is A2's last proof.
- **One manifest for both browsers.** The shipped manifest keeps `background.scripts` (Safari's shape); the
  E2E patches a copy for Chrome. A manifest with both `scripts` and `service_worker` may suit both — verify
  in Safari before dropping the patch.

- **Verified end-to-end on dev 2026-09-07, and on prod the same day** (three attempts ingested
  2026-09-07; confirmed 2026-09-26). Also validated on dev in 2026-08,
  after which `dev` was force-moved onto another feature branch — so **the branch pointer retains no
  trace of that; GitHub Actions run history is the only record.** Don't re-derive deployment history
  from `git log origin/dev`; it will tell you this never happened.
- **Prod's secrets were exercised by that 2026-09-07 ingest.** `DEVICE_TOKEN_PROD` and
  `DEVICE_USER_ID_PROD` were set the same day. Repeat the extension check against
  `aperture.rahuldatta.dev` after any rotation — a wrong `DEVICE_USER_ID_PROD` renders an empty page and
  errors nowhere.
- **The summary line is hidden until there's data.** `0 solved · 0 problems · 0 attempts` sits outside
  `EmptyState`'s reach, so it would have kept asserting a total while the query was still loading or had
  failed. Revisit if a zero-state summary ever earns its place.
- ~~Not signed yet.~~ **Done 2026-09-08** (_Firefox: signing via AMO_ → Status). Superseded as the
  daily driver by Safari on 2026-10-04 (_Safari: free signing_).
- ~~Is the free build really permanent past 7 days?~~ **No 7-day clock (2026-10-04).** Free Personal Team
  _provisioning profiles_ expire after 7 days on iOS, but this build embeds none: no
  `embedded.provisionprofile` in the app or the `.appex`, and the extension's entitlements are only
  `app-sandbox`, `files.user-selected.read-only` and `get-task-allow` (`codesign -d --entitlements -`),
  none of which needs a profile on macOS (Apple TN3125; Apple DTS on forum thread 705932: free profiles
  last 7 days on macOS too, but "if there's no profile then the only thing that could expire is the
  signing identity's certificate"). Only the certificate's 2027-09-28 expiry — or its revocation — applies. Re-check if a
  future build adds a capability (App Groups, etc.) — that would embed a profile.
- ~~Does the saved token survive a Safari rebuild?~~ **Yes (2026-10-05)** — regenerating the prod project
  with the same bundle ID and team kept the saved origin and token.
- **Chrome path untested.** `world: "MAIN"` is supported there since 111 and the code has a `chrome`
  fallback, but neither has been run.
- **No aggregate views.** No per-topic breakdown, no difficulty mix, no time-to-solve. V2, and per
  **[EvaluatingChanges.md](../../product/EvaluatingChanges.md)** those wait for real usage rather than being designed
  against a guess.
