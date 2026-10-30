# Google Calendar integration

Connect **two Google accounts** (personal + school), **read** their calendars into a morning "day
shape" number, and **write real events** onto them from tasks. Aperture owns the events it creates and
only ever touches those — and since two-way sync (2026-10-05), edits you make to *those* events in Google
come back onto their tasks. Built in PR-C on branch `google-calendar`.

## Why "shape", not "hours free"

A single "6 hours free" number lies: six hours in one block is a different day from six hours in twelve
30-minute slivers. So the headline is the **longest uninterrupted free stretch** plus a **fragment
count** (free gaps shorter than a fixed 45 min). Never "effective hours." The math is a pure function,
`computeDayShape` in `packages/shared/src/calendar.ts`, run **client-side** from raw busy intervals the
BFF returns — so the server does no date math and the shape re-clips for daytime mode without refetching.

## Multi-account (the core shape of the feature)

The school calendar lives on a university Workspace whose admin blocks external write-sharing. A
personal-account share is read-only forever — but the school account can **authorize Aperture directly**
(verified against the live consent screen, no `admin_policy_enforced`). So there is **no shared calendar
and no read-only import**: two first-class OAuth grants, each read+write on its own real calendars.

```
Aperture ──grant #1──▶ personal @gmail    (read + write)
         ──grant #2──▶ school   @school.edu (read + write — owner, no share needed)

READS : merge across BOTH accounts' selected calendars, each via its own token
WRITES: route to the target calendar's OWNING account's token
```

Everything account-scoped keys off the Google **`sub`** (stable across email changes). `sub` → refresh
token in SSM; the connected-account list + email live in `Settings`.

## The two traps

- **7-day refresh-token expiry.** A consent screen in *Testing* status issues refresh tokens that die in
  7 days — the same bug class as the Cognito daily re-login. Fix: **publish** the consent screen (status
  *In production*, unverified is fine for a personal app). One client covers both accounts. Verify
  empirically day 8–10 after the first real connect.
- **Silent normalization bugs.** Parsing `events.list` fails quietly — a plausible wrong number, never an
  error. Every rule is fixture-tested (`lambdas/src/google/normalize.test.ts`): all-day vs timed, `end`
  exclusive, drop declined/cancelled/transparent/`focusTime`, all-day → a count not a block, and a
  DST-transition fixture proving committed minutes come from the RFC3339 offset, not the wall clock.

## Architecture — two gated seams

External side-effects are gated exactly like the DDB `Writes` seam, so a smoke/testMode run touches
nothing real (no SSM token read, no Google fetch, no burned refresh token):

| Effect | Seam | Live | testMode |
| --- | --- | --- | --- |
| DynamoDB writes | `Writes` | `liveWrites` | `noopWrites` |
| Google + SSM | `GoogleGateway` | `LiveGoogle` (index.ts only) | `noopGoogle` |

`GoogleGateway` (`lambdas/src/google/gateway.ts`) is account-aware — every method takes the `sub`. Three
impls: `LiveGoogle` (real `fetch` + SSM, rolled by hand — no `googleapis` lib), `noopGoogle`
(testMode), `InMemoryGoogle` (stateful test fake). Both seams are switched together in `handleRpc`.

**Blast-radius safety rule:** the `calendar.events` scope can touch any event, but Aperture only ever
patches/deletes an event whose `eventId` it stored (`task.gcalEventId`, on `gcalAccountId` +
`gcalCalendarId`). Discipline, not scope, keeps it off real meetings.

**Primary-calendar-only (a scope consequence).** `calendar.events` grants event read/write but **not**
`calendarList.list` — listing an account's calendars 403s ("insufficient scopes"; that needs
`calendar.readonly` / `calendar.calendarlist.readonly`). Rather than broaden the grant, we use each
account's **primary** calendar only (its `calendarId` is the account email): `listGoogleCalendars`
returns the primary synthetically (no API call), and connect defaults that primary into the shape set +
write default. `events.list`/`events.insert` on the primary work with the scope we have. To offer a
non-primary picker later, add `calendar.calendarlist.readonly` and restore the gateway's `listCalendars`
(still on the interface) — at the cost of re-consent + a consent-screen scope addition.

## Data model

- `Task` + `gcalAccountId | gcalCalendarId | gcalEventId` (all null-default) — the pointer to a created
  event; all three are needed to patch or delete it via the owning account. `gcalSyncError` (null-default)
  holds the last auto-sync failure (§ Auto-sync).
- `Settings.autoCalendar` (default `true`) — the auto-sync toggle (both directions).
- The gateway's insert/patch inputs carry an optional `marker` — a parent's due marker (§ Auto-sync →
  Parent + parts): `true` sends `transparency: transparent` + `colorId "8"` (graphite), `false` turns it
  back into a block (`opaque`, `colorId: null` — null deletes the override in a patch; verify once on dev).
  Absent leaves how the event shows alone. Never read back.
- Two-way bookkeeping on `Task`, all **optional** (sync state, not task data; old rows lack them):
  `gcalSeen` (the event's title + window as Aperture last knew it, plus Google's `updated` for that
  state — the merge base and the stale line — and `marker`, the look Aperture last sent: set by every
  create, absent on a block linked by the picker or before looks were recorded) and `gcalPulled` (`{at, note}` — the "updated from Google"
  mark).
- `GcalSyncState` (`gcal#sync#<sub>`, one per account): the `events.list` `syncToken`, `lastPulledAt`
  (attempt — the throttle), `lastSyncedAt` (success; Settings' "Checked …"), `lastPullError`. Exported like `financeSyncStates`; tombstoned on disconnect.
- `Settings` + `googleAccounts[{sub,email}]`, `calendarShapeRefs[{accountSub,calendarId}]`,
  `calendarWriteDefault`, `dayFocusStart` (8), `dayEndHour` (22) — the waking window, **separate** from
  `dayStartHour`'s 4am rollover.
- **No calendar events in DynamoDB** — gcal is the source of record. Only the pointers + settings persist;
  shape numbers and event content are fetched/computed per request. New fields read `undefined` on old
  rows → `ensureSettings` backfills defaults over the existing row.

## Flows

- **Connect** (per account): `googleConnectUrl` builds an HMAC-signed-`state` consent URL → Google →
  `GET /api/google/callback?code&state`, a **real redirect route special-cased in `index.ts`, outside the
  RPC dispatch**. It verifies the state (carrying the Cognito userId — no JWT on the navigation), exchanges
  the code, stores the token, records the account, and 302s back with `?google=connected`.
- **Shape read**: `getCalendarBusy({day, windowStartMs, windowEndMs})` — the client computes the window
  bounds via local `Date` (DST-safe) and sends epoch ms; the BFF reads each shape ref via the right token,
  normalizes, and returns raw merged-later intervals + an all-day count. React Query `staleTime` (~10 min)
  is the only cache — no Lambda or DDB cache.
- **Event write (manual)**: `insertCalendarEvent` routes to the target account, stores the pointers; one
  live event per task (a second insert throws). The picker is for a task with a due day but no time —
  and for a timed task only while auto-sync can't place blocks (off, or no write default); a timed task
  with auto-sync on gets the one-tap "Add to calendar" at its deadline instead, and
  `insertCalendarEvent` refuses it (`AUTO_PLACED_ERROR`, both impls, so MCP gets it too — its way out there is `sync_calendar_event`, [mcp](../mcp/index.md)). The picked
  start feeds the event only; a task with a `dueTime` prefills the block that ends at it. A block on a
  timed task is its auto block, whatever placed it: the next push moves it to the deadline.
- **Delete-on-cancel**: dropping a task (`transitionTask → cancelled`) or `deleteCalendarEvent` removes the
  event via its owning account and clears the pointers. **`deleteTask` reuses the same path** (permanent
  delete hard-deletes the event, then tombstones the task) — so a failed Google call is swallowed there
  too, leaving the same silent orphan (expired token → the event stays, the pointer clears, no retry). Note
  `deleteTask` builds its tombstone from the task **returned** by `deleteCalendarEvent`, whose pointers are
  already nulled, so it can't re-write stale pointers.
- **Auto-sync** (timed tasks, below) — create, edit-sync, and remove on clear.

## Auto-sync (timed tasks) — 2026-10-05

A task with a due **time** (`dueTime`, [due-dates.md](../tasks/due-dates.md)) gets an event automatically:
it **ends at the deadline** and is as long as the estimate (`DEFAULT_EVENT_MIN` = 30 without one), on
`calendarWriteDefault`. One pure planner, `calendarSyncPlan` (`packages/shared/src/calendarSync.ts`), runs
after every task write in **both** `ApiClient` impls — `BackendClient.syncCalendar` executes it against the
gateway, the stub against a fake id — so app, bulk add and MCP all get the same behaviour.

| Task change | Event |
| --- | --- |
| gains a time (create, edit, bulk, MCP) — no event | created |
| gains a time — a block already exists | **moved** to end at the deadline (no duplicate) |
| day / time / estimate / title changes | patched (`events.patch`) — **only what the event lacks** (the window moves as one) |
| untimed task with a block, renamed | title patched; a day move leaves it (gcal owns that clock) |
| time or day cleared | deleted, pointers cleared |
| done | left alone · cancel → delete-on-cancel (above) |
| a **parent** (has parts) with a time | its **due marker**: 15 min ending at the deadline, free, graphite — moved by a due change (Parent + parts, below) |

- **Timed only** — no all-day events for day-only tasks; a rename or estimate change alone never
  creates one (so an event you removed by hand isn't resurrected).
- **Toggle off → nothing auto-syncs**, in either direction: no create, patch or delete, and no pull;
  existing events stay where they are. No backfill when it's turned back on (an edit made meanwhile
  reaches Google with the next change — Two-way sync). Needs a write default (the toggle is disabled without one).
  Not gated by it: delete-on-cancel (above), a done split moving a timed task's link to its follow-up
  (no Google call — the pointer just moves), and an **owed removal** (below) — asked for while sync was on,
  it's carried out on the next sync either way.
- **Only what the event lacks.** A patch sends the fields where the task differs from `gcalSeen` (the
  event as Aperture last knew it) — so an Aperture rename can't undo a drag made in Google that hasn't
  been pulled yet, while a change that never reached Google (a failed push, a move made with sync off)
  goes with the next one. The retry (`ensure`) sends both. Without a `gcalSeen` (linked before two-way
  sync) any change sends everything, once; a window not known (first seen all-day) moves only when the
  task's time does. A done task never pushes — its unsent edits still win a conflict on the pull. A
  block placed off the deadline (picked while sync was off, or before the task had a time) differs from
  the task's window, so the next push — a rename, an estimate change or Retry — moves it to the deadline.
  Creating or inserting an event clears a stale "Removed in Google Calendar" mark.
  Moving a window sends `start/end: { date: null, dateTime }`: a patch merges nested objects, and the
  `null` clears the `date` an all-day conversion left (verify once on dev — the docs don't cover this case).
- An event **deleted** in Google (patch → 404/410, or 200 with `status: "cancelled"` — Google keeps
  deleted events restorable) is treated as gone: the pointer is dropped and the event is not resurrected;
  a later time change creates a fresh one. The pull (below) usually finds it first.
- **Failure never fails the task write.** The task is saved first; a gateway error lands on the task as
  `gcalSyncError` ("Couldn’t add/update/remove the calendar event (…)", logged as `gcal_sync_failed`),
  shown on the row and in the editor with **Retry** (`syncCalendarEvent` — an "ensure" pass of the
  planner). A failed **remove** keeps the event linked (never a silent orphan), and its note marks it as
  still owed a removal (`isPendingRemoval`): the next sync of any kind — the retry, or just a rename —
  finishes it, never adopting the event as a manual one. The note clears on the next success, or once
  there's nothing to retry (no time + no event, sync off, or the task is done/cancelled — a finish clears
  it directly). The exception is an **owed removal**: finishing (or splitting) the task carries it out
  through the same reporting path, so it's never dropped. Unlike delete-on-cancel — still best-effort —
  the auto-sync remove does not swallow Google errors.
- **Writes only the calendar fields, onto a fresh read** (`putGcal`) — the sync spans a Google round-trip,
  and a write that lands meanwhile (a session closing) must survive it.
- **Every Google fetch has a 4 s timeout** (`LiveGoogle`), so one sync's worst case (token refresh +
  call, ~8 s; the SSM token read has none) fails into `gcalSyncError` inside the 15 s Lambda timeout.
- **A timed task with no event** (timed while sync was off — no backfill — or its event removed) shows
  "Not on your calendar" + **Add to calendar** in the editor, which runs the same ensure pass (MCP:
  `sync_calendar_event`).
- **Timezone.** The Lambda is UTC, so it resolves `dueDay`+`dueTime` via `zonedEpoch(…, USER_TIME_ZONE)`
  (`America/Los_Angeles`, shared `dates.ts`; DST-correct); the browser uses `localEpochFromDayTime`.
- **Bulk creates** sync timed rows four at a time (a Google round-trip each; settings read once) within a
  3 s budget measured from the call's start: no new Google call starts after it, or after the first
  failure (Google is likely down for all of them) — the remaining timed rows get a "not attempted — retry"
  note instead (each onto a fresh read). Worst case ≈ 3 s + one sync's two 4 s fetches = 11 s, plus a fast
  SSM read and a few DynamoDB writes. The
  tasks are already saved, so a Lambda timeout here would report a failed paste and invite a duplicating
  resubmit. Untimed rows skip it.
- **Parent + parts** ([tasks/parts.md](../tasks/parts.md) D8, D12, D13): a parent's one event is its **due
  marker** — `MARKER_MIN` (15) ending at its deadline (`syncWindow(…, parent)`), free and graphite, titled
  with its plain title. `calendarSyncPlan` takes `opts.parent` (the impls compute it from the task list on
  every sync but a fresh create, Add/Retry/Send included). Every create carries `marker` (`true` for a
  parent), and a patch carries it only when the event's recorded look (`gcalSeen.marker`) differs from
  the task's — never on a plain block that was never a marker. A timed task that takes its first part has its block patched into
  the marker; its last part going patches it back, and a failed switch heals on the next push. An untimed parent has no marker, and an event it had goes
  whatever the toggle says. `insertCalendarEvent` refuses a parent (`PARENT_NO_EVENT_ERROR`) before its
  other checks. Lazy: nothing is backfilled — a marker appears on a due change, a split or Break down, or
  **Add due marker**. A part's own time (`dueDay`/`dueTime`) is when its block ends, so its block is an
  ordinary auto block, named after its parent (`P2 · Part 1`, `blockTitle`; `opts.parentTitle`). A parent
  rename re-sends each linked open part's block.
- **Split** ([tasks/split.md](../tasks/split.md) — a split never cancels, and always yields parent + parts). The
  new parent of a timed task gets its due marker, synced once it has its parts; Part 1 keeps the original's
  id, time and event, renamed `Parent · Part 1`. **Done** with this part: a **timed** task's event (the block
  before its deadline, whatever placed it) moves to the follow-up (a part, never the parent) — the
  link carries what Aperture knows about the event (`gcalSeen`; the follow-up's new title and window are
  unsent, so they win a conflict) — which renames/re-times it: no
  delete + re-create, no duplicate block. **Kept going**: each part owns a block — the original keeps
  (and re-times) its event, and the follow-up, a new timed task, gets its own from the planner, so two
  blocks end at the deadline; dragging either in Google moves only that part's time (Two-way sync).
  A block on an untimed original stays on the original either way, and an
  owed removal is carried out (reporting).

## Two-way sync (Google → task) — 2026-10-05

Edits made in Google Calendar to the events Aperture created come back onto their tasks. One pure planner,
`calendarPullPlan` (`packages/shared/src/calendarPull.ts`), decides per changed event in **both**
`ApiClient` impls (the outgoing half stays `calendarSyncPlan`).

**Pull, not push.** `pullCalendar` runs on app open and whenever it returns to the foreground
(`useCalendarPull`, mounted in `AppShell`), at most once a minute per account — throttled server-side on
`GcalSyncState.lastPulledAt`, failures included. MCP `list_tasks` does **not** pull; it reads what the
app's last pull left. No `events.watch`: it only says "something changed" (you still list), needs an
unauthenticated webhook and weekly channel renewal.

**The delta.** Per account, `events.list` on its primary with a `syncToken`. Every request of a sync uses
the same query — `singleEvents=false` (we never create recurring events, and expanding someone's
unbounded series is how a pull would blow its budget), `showDeleted=true` (required with a token),
`maxResults=250`; the token-less request adds `timeMin = now − 7 d` (Google rejects `timeMin` with a
token). A **410** clears the token and re-syncs in full inside the same call. **8 s budget**
(`PULL_BUDGET_MS`): past it the pull stops before the next page and stores no token, so the old one
replays the same delta next time. Unverified: whether the first sync's `timeMin` bounds later deltas
(Google doesn't say) — either way is benign.

**Matching.** By stored pointer (`gcalAccountId`, `gcalCalendarId`, `gcalEventId`) over one `listTasks`
scan; everything else in the delta — real meetings — is dropped untouched. New events are tagged
`extendedProperties.private.apertureTaskId`, for provenance only (a Google "Duplicate" carries the tag
with a new id and is never adopted). **The pull never writes to Google**, and never re-runs the push:
the task now matches its event, except where a pull kept Aperture's value — that goes with the next push.

| Google change (to an Aperture event) | Task |
| --- | --- |
| end moved | `dueDay` / `dueTime` (wall clock in `USER_TIME_ZONE`) — the plan day never moves |
| start moved (length changed) | `estimateMin` = the new length, rounded to the minute — never `estimateLockedMin` |
| renamed | `title` (trimmed; a blank title is ignored). A part's block: a leading `Parent · ` is stripped first; without it the whole title is taken |
| deleted, or moved to another calendar | unlinked (pointers cleared), never resurrected |
| made all-day | time ignored, link kept, title still syncs; the next Aperture time change re-times it |
| made recurring | ignored |
| a parent's **due marker**: end moved / start moved | `dueDay` / `dueTime` / nothing — its length maps to no field (a parent has no estimate) |

- **Status.** Done: the end and title apply, a start drag is ignored (the estimate is history — revisit
  task in prod). Cancelled: nothing (its event went with the cancel). In-progress: the start sets the
  working estimate, matching the editable-estimate rule.
- **Untimed tasks**: an event on a task with no due time syncs its title only — there's no window to map.
- **A three-way merge.** `gcalSeen` is the base: Google changed a field iff the event differs from it
  (instants, not wall clocks — so both DST edges are idempotent). Our own push echoing back is a no-op,
  including a no-estimate task's default 30-minute block (no `estimateMin = 30`), and a field only
  Aperture changed is never "taken" from Google's stale copy. Aperture changed the time iff the task no
  longer maps to the base the way a pull would map it — the deadline as the same instant or the same
  wall-clock minute (a fall-back hour's second 1:30, an end with seconds), the length in whole minutes
  (not on a done task, whose start never maps) — so a Google change the pull declines (a done task's
  start drag, a block a few seconds off the minute) never reads as Aperture's later. Only an end that
  moved touches the deadline (a start drag on a deadline in the skipped spring-forward hour leaves its
  wall clock alone). Every pull that sees the event records it as the new `gcalSeen` (except a stale,
  recurring or owed-removal one) — a newer state with nothing to map too, so its version advances; a
  push records what it sent. Titles compare trim-insensitively.
- **One clock, Aperture wins.** `gcalSeen.updatedMs` is **Google's** `updated` for the state the base
  describes — from the push's response (never the Lambda's clock, which reads *after* Google stamps the
  write and would make our own push's echo look stale) or from the pulled event. An event state older
  than it is stale: nothing applies and nothing is recorded — it predates our push, whose echo carries
  anything newer (so a Google edit to a field we didn't send rides in on it). A field **both** sides
  changed keeps Aperture's unsent value (a failed push, sync off, a done task, a dead token): the base
  takes Google's, so it isn't re-detected, the next push sends Aperture's, and the row says so ("Kept
  your title — renamed in Google Calendar too"). A successful push already resolves a conflict that way;
  Google's `updated` is per event, not per field, so "the later edit wins" couldn't be decided per field.
  Deletion always wins. An owed removal is never pulled into.
- **First sight on the first sync only remembers.** An event linked before two-way sync has no
  `gcalSeen`. The account's first sync (token-less: every event from the last week on) records each such
  event as Google has it, with its `updated`, and honours a deletion. Nothing changes on the task — no
  burst of changed deadlines. Where the event differs from the task (an edit made in Google before
  two-way sync, or a block placed off the deadline by the picker or MCP), the task's value is Aperture's
  unsent one: under one-way rules it was due to overwrite Google's anyway, so the next push sends it — a
  timed task's block moves to its deadline, never the deadline to the block — and a Google edit to that
  field before then is kept out (with its note). Fields in step apply as usual.
- **First sight in a later delta applies.** After the first sync, an event with no `gcalSeen` is one
  that sync didn't see (ended before its lookback) or didn't record (cancelled, an owed removal, a failed
  push) — it shows up again by changing in Google. So the task as it is (`seenFromTask`) stands in for
  the base, and Google's change applies like any other, with its note — unless the task holds a failed
  push (`gcalSyncError`): that's Aperture's unsent value, so Google's state is only remembered, as on the
  first sync. (A 410 re-sync counts as later — the account has a token — and its full listing can carry
  an unchanged event with no base, which then reads as a Google change.) Left as is, all rare (an old
  linked task that's still open, or edited since):
  - **A task edit that never reached Google** without a trace (made with sync off, or after done — a
    done task never pushes) loses to any Google change to that event — a colour change will do — with
    the note.
  - **A block placed off the deadline before two-way sync** (picker with sync off, MCP) moves the
    deadline — and an open task's estimate, never `estimateLockedMin` — to the block on any Google
    change to it; an untimed task's manual event with its own title renames the task.
  - **An Aperture edit before that pull** (the app, or MCP while the app is closed — days, possibly)
    still sends everything (the push branch above), silently undoing an unpulled Google edit — the
    original bug, in a narrower window.
- **Planned on a fresh read.** The delta can land seconds after the task scan, so each write re-reads the
  task and re-plans; a task deleted, unlinked or edited during the fetch isn't overwritten. (The write
  itself is a plain put: an edit landing in the milliseconds between that re-read and the put is lost,
  as with every fresh-read write here.) The writes spend the 8 s budget too — past it the pull stops
  with no token stored, and the replay is idempotent.
- **Shown, never silent.** A pull's write sets `gcalPulled` (`{at, note}`) — one line, latest wins:
  "Moved to Oct 9 5pm · Now 45m · Renamed to “pset 3” in Google Calendar", "Removed in Google
  Calendar", "Kept your title — renamed in Google Calendar too" (also "Kept your time — moved …", "Kept
  your title and time — changed …"; "time" is the block: deadline and length), or both kinds at once
  ("Moved to Oct 9 5pm in Google Calendar · Kept your title"). The row shows a gold "updated from
  Google" — "kept over Google" when only a kept-out change is noted; the editor's Calendar section shows
  the line. A later successful push doesn't clear a kept note. Beside a note with a kept part (alone or
  mixed), while the task still holds a value its event lacks (`hasUnsent`), the editor offers **Send to
  Google** — the same `ensure` push as Retry, so it also re-times a block first seen all-day; not on a
  done task (it never pushes), with sync off, while settings load, or beside a sync error (Retry is
  there). `hasUnsent` resolves the window in the device's zone (like the stub); away from
  `USER_TIME_ZONE` it can read a pushed block as unsent and the button lingers until the note clears —
  a tap just re-sends.
  Both clear at the next 4am rollover (`isPullFresh`), or as soon as you change that task's title, time
  or estimate yourself (the note no longer describes it). Settings shows each account's "Checked …" or
  "Couldn’t check for changes (…) — retries next time you open the app".
- **Failure.** A pull never throws to the app: a Google error (timeout, `invalid_grant`) lands on that
  account's `GcalSyncState.lastPullError`, logged `gcal_pull_failed`; other accounts still pull.
  testMode: `noopGoogle` returns an empty delta and `noopWrites` persists nothing.
- **Stub (page-first).** The same planner over a dev queue: `localStorage['aperture:stub:gcalEdits']`, a
  JSON array of edits (`{taskId, end?: "YYYY-MM-DD HH:MM", durationMin?, title?, allDay?, cancelled?}` or
  `{failAccount, error}`), consumed by the next pull and bypassing the stub's throttle (the app's hook
  still waits a minute — reload to see it). A task with no `gcalSeen` takes its own block as the known
  event (`seenFromTask`, as the backend's later-delta first sight; the queue is only deliberate edits).

## Resilience (the Cognito model, per account)

No accounts → fall back to the manual capacity number, show a connect prompt. One account's `invalid_grant`
→ mark just that account `reconnectRequired` (surfaced by `getGoogleStatus`), keep using the others; a dead
token is a recoverable expected state, not a crash.

## Infra gotchas (CDK)

- **CloudFront strips the `/api/*` query string by default** → the callback would arrive with no
  `code`/`state` (invisible locally). The origin-request policy now allow-lists `code`, `state`, `error`.
- **`APP_URL` only when a custom domain is set** — the CloudFront domain is a token that would form a
  Lambda→distribution→FunctionURL→Lambda cycle. Both stages have custom domains, so this is always set in
  practice; unset only in an unconfigured stack. **Consequence: calendar connect requires a domained
  stage** — with no `APP_URL` the OAuth `redirect_uri` is relative and the consent flow can't complete.
- **SSM IAM is path-scoped**: read `/aperture/<stage>/google/*` (client creds + tokens), write+delete
  `.../google/tokens/*` (the dynamic `<sub>` needs the wildcard; cdk-nag IAM5 acknowledged for both stages).

## Operational prerequisites (done by the user in Google Cloud)

One OAuth client per env (same id/secret in both, in SSM SecureString at `/aperture/<stage>/google/client_id`
+ `client_secret`), redirect URI `<APP_URL>/api/google/callback`, scope
`openid email https://www.googleapis.com/auth/calendar.events`, consent screen **published**. Per-account
refresh tokens are written by the app at connect time — never pre-created.

## Dependency note

`@aws-sdk/client-ssm@3.1102.0` (lambdas) is the one added dependency. Justification (CONVENTIONS A/B):
**B** — the AWS control-plane client for reading client creds and reading/writing per-account refresh
tokens; hand-rolling SigV4 for SSM is exactly the security-critical, subtle-correctness code the rule
says not to own. Footprint is ~zero: pinned to the repo's existing SDK version and bundled `external`
(`@aws-sdk/*` already ships in the Lambda runtime). Google's REST + OAuth are still rolled by hand (a few
`fetch` calls) — no `googleapis` lib.
