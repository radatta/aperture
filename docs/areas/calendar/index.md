# Google Calendar integration

Connect **two Google accounts** (personal + school), **read** their calendars into a morning "day
shape" number, and **write real events** onto them from tasks. Aperture owns the events it creates and
only ever touches those. Built in PR-C on branch `google-calendar`.

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
  event; all three are needed to delete it via the owning account.
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
- **Event write**: `insertCalendarEvent` routes to the target account, stores the pointers; one live event
  per task (a second insert throws). Time feeds the event only — never denormalized onto the task.
- **Delete-on-cancel**: dropping a task (`transitionTask → cancelled`) or `deleteCalendarEvent` removes the
  event via its owning account and clears the pointers. **`deleteTask` reuses the same path** (permanent
  delete hard-deletes the event, then tombstones the task) — so a failed Google call is swallowed there
  too, leaving the same silent orphan (expired token → the event stays, the pointer clears, no retry). Note
  `deleteTask` builds its tombstone from the task **returned** by `deleteCalendarEvent`, whose pointers are
  already nulled, so it can't re-write stale pointers. Edit-sync (a moved `dueDay`) is a **named, deferred
  gap** — the event does not move.

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
