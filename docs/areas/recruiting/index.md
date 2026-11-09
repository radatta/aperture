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
below. The extension still runs the per-submission capture under _The shape_ until A2 rebuilds it around
sittings; its rows (`leetcodeAttempts`) are **retired**: still written, read by nothing, not exported, and
the old ingest method goes once the prod Safari build is rebuilt (PR D). The redesign's evidence (what
LeetCode exposes, from a HAR capture on 2026-11-08) and plan live in the lc-redesign worktree's
`localNotes/` until it lands; durable decisions are recorded here.

## Sittings

### The unit and its lifecycle

```
extension Start ──► lcSittingStart ──► a rep of settings.leetcodeRollId, in progress, titled "LeetCode · <problem>"
LeetCode traffic ─► lcSittingEvents ─► events stored raw; runs/submits/notes/timer fold into the head,
                                       snapshots/replay into the live row
Done on the rep ─────────────────────► sitting done          Drop ─► abandoned          delete ─► gone with it
```

- **One sitting = one problem = one Roll rep.** Start resumes a sitting already open on the same problem (or
  a repeat of the same Start), refuses another problem while one is open (`SITTING_ACTIVE_ERROR` — one
  open rep per roll), attaches the roll's open rep when no sitting holds it, and otherwise spawns a fresh
  rep on the sitting's day plan. The rep is shaped through the normal task paths (title, notes = the problem
  URL, start), so its calendar and reminder rows stay right. Unlinked roll → `LC_ROLL_UNLINKED_ERROR`
  (Settings → LeetCode).
- **A sitting ends only through its rep** (`transitionTask` / `deleteTask` hooks, only for tasks with a
  `rollId`). An Accepted submit never ends it — you may keep going.
- **The head's id is the Start's `clientSittingId`**, claimed put-if-absent before any rep write, so a
  double-fired Start makes one sitting and one rep.
- `startedAt` is the server's clock at Start (the sitting clock); the click's own time is kept as
  `clientStartedAt`. LeetCode's `solve_elapsed_ms` counts from the first time a problem was ever opened, so
  it's context only. `day` buckets `startedAt` by the client's tz offset and `dayStartHour`.

### What's stored, what's derived

All rules are in `packages/shared/src/sittings.ts` (the stub and the Lambda share them):

- **Head** (`lcsit#<id>`): the problem, rep, status, prep target (`General` until the company UI) and the
  `summary` fold — runs, submits, first/last verdicts, `submitsBeforeAccepted`, runs before the first
  submit, LeetCode's timer state. The fold is a cache of a pure function over the events; if its CAS loses
  four times running, the events stay stored but unfolded (rebuildable later).
- **Live row** (`lcs#<id>#live`): the newest code (the final code once ended), the snapshot `version` live
  reads report, and **facts** folded from the replay at ingest — first/last edit, edits, longest stall,
  rewrites, LeetCode's type-3 toggles raw (`focus`; meaning unconfirmed). Folded at ingest so they outlive
  the raw replay.
- **Events** (`lcs#<id>#ev#…`), payloads verbatim; **replay chunks** (`lcs#<id>#rp#…`), raw, never in
  `getSitting` (read with `listSittingReplay`); **problem doc** (`lcq#<slug>`): LeetCode's
  `questionDetail`, upserted per slug.
- **Derived, never stored:** `sittingMetrics` — first submit accepted (headline), submits before accepted,
  time to first submit — and the elapsed time.

### Storage and expiry

Kept forever: the head, the live row, every run, submit, note and timer event, the problem doc. The **raw
bulk** — snapshot and submit-detail events, replay chunks — is stamped `expiresAt` at write: 14 days past the
sitting's 24 h ingest window, deleted by DynamoDB's TTL (free). This is prod's one TTL'd row kind (TECH §2.3
rule 4), chosen so storage doesn't grow with keystrokes: kept data is ~25 KB a sitting. Export carries
heads, live rows, events and problems; the replay stays out like attachment bytes.

### Ingest: the device token and the caps

`lcSittingStart` and `lcSittingEvents` (`LC_INGEST_METHODS`) take the extension's device token **or** the
user's JWT (the dev check drives them as the test user); every other method — every read — is JWT only, so a
device token anywhere else 401s. Ingest bodies over 300 KB are refused before parsing (413). Per call ≤ 50
events / 256 KB; per event type a size cap (snapshot ≤ 64 KB, run/submit ≤ 96 KB …); per sitting ≤ 3,000
events / 16 MB; ≤ 20 Starts a day; events refused once the sitting ended or 24 h after Start. Each event is
idempotent on its id. The server recomputes everything it decides on (`userId`, `day`, `startedAt`,
verdicts, counters); payloads are opaque. A leaked device token can make junk sittings (visible reps) and
write within those caps; it can't read, delete, end a sitting, or reach any other partition.

### The page

`/recruiting` → **Sittings**: the open sitting pinned with its running clock, the rest by day with the
outcome (`first submit accepted` / `accepted on submit N` / `not accepted` / `no submit yet`), runs, and
`dropped`. Stories is the other tab.

## The shape (legacy capture — until A2)

Two paths that only meet at one place: the userId under which rows are written and read.

```
WRITE ─ browser extension ─────────────────────► device token ─┐
                                                                ├─ same DynamoDB PK
READ  ─ the PWA at /recruiting ────────────────► Cognito JWT ──┘
```

### Write path — capture

```
leetcode.com/problems/<slug>   (your tab)
  │  you hit Submit
  │
  ├─ LeetCode's OWN request:  POST /problems/<slug>/submit/     → { submission_id }
  └─ LeetCode's OWN poll:     GET  /submissions/detail/<id>/v2/check/
                                                                → { state, status_code, status_msg, … }
  ╎  observed — never blocked, altered, or re-issued
  ▼
inject-main.js          [MAIN world, document_start]
  • patches window.fetch + XMLHttpRequest (both transports LeetCode may use)
  • remembers submission_id → { slug, lang, question_id }
  • fires ONCE, on the first response with state === "SUCCESS"
  • reads the rendered DOM for title / difficulty pill / a[href*="/tag/"]
  │   ↳ LeetCode SERVER-RENDERS this — there is no client request to intercept
  │  dispatchEvent(CustomEvent("aperture-leetcode-attempt"))
  ▼   MAIN world cannot call browser.* — hence the bridge
content-relay.js        [ISOLATED world]  → runtime.sendMessage()
  ▼
background.js           [extension event page]
  • storage.local → { apiOrigin, deviceToken }
  • stamps tzOffsetMinutes = new Date().getTimezoneOffset()
  • in-memory dedupe (belt only; the server is authoritative)
  │  POST <apiOrigin>/api/recordLeetcodeAttempt
  │  x-aperture-authorization: Bearer <deviceToken>
  ▼
CloudFront  (stamps ORIGIN_SECRET)
  ▼
Lambda Function URL (auth NONE; origin-secret header) — lambdas/src/index.ts
  • origin-secret check → 403 on miss
  • method === 'recordLeetcodeAttempt' ?  YES → resolveDeviceUserId()  [timingSafeEqual]
                                          NO  → resolveUserId()        [Cognito JWT]
  ▼
BackendClient.recordLeetcodeAttempt()
  1. findLeetcodeBySubmissionId → already there? return it        (idempotent)
  2. verdict = normalizeVerdict(statusCode, statusMsg)            (shared, pure)
  3. day     = dayKeyForOffset(submittedAt, tzOffset, dayStartHour)
  ▼
DynamoDB   PK = u#<userId>   SK = lc#<YYYY-MM-DD>#<ulid>
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
removed at A1.

## Design decisions worth not re-litigating

**The extension is 100% passive toward LeetCode.** It never issues a request _to LeetCode_ — it only
observes calls LeetCode already made. No scraping, no polling, no automation. (It does make exactly one
request of its own: the `POST` to our own backend.) That's the best ToS posture available and the reason
this exists as an extension rather than a scheduled scraper.

**Metadata comes from the DOM, not GraphQL.** The first cut intercepted a `questionData` GraphQL call.
That call doesn't exist — LeetCode server-renders the problem header. Title, difficulty, and topic tags
are read off the page at capture time, and degrade to a slug-derived title and `null`/`null` when they
can't be found (e.g. topics hidden behind "Show Topics"). Don't reintroduce a network fetch for these.

**The server owns normalization.** The extension ships raw signals (`status_code`, `status_msg`,
`tzOffsetMinutes`) and stays dumb, because it can't import from the workspace and shouldn't need
redeploying when a rule changes. The server owns the verdict enum and — since it owns `dayStartHour` —
the day bucket. That's why the input shape isn't the `createLogEntry(text, day)` shape.

**Idempotency is on `leetcodeSubmissionId`.** The extension may fire twice for one submission; the
second write returns the existing row with its **original** verdict, never an overwrite.

**Attempt count is derived, never stored.** A stored counter is a second source of truth that drifts.

**The device token is scoped to exactly one method.** It's a static, long-lived key sitting in browser
storage — a different risk class from a JWT. A device token sent to any other method falls through to
`resolveUserId`, isn't a valid JWT, and 401s. Comparison is `timingSafeEqual`.

## Files

| Path                                                     | What                                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/`                                             | MV3 web extension — Safari daily (wrapped in an Xcode app), Firefox AMO-signed. No deps, no bundler, no build step. `README.md` there is the wire contract and the Safari build steps. |
| `packages/shared/src/types.ts`                           | `Sitting`, `SittingLive`, `SittingEvent`, `SittingReplayChunk`, `LeetcodeProblem`; `LeetcodeAttempt` (retired), `LeetcodeVerdict`                                                      |
| `packages/shared/src/sittings.ts`                        | the sittings' rules: normalizers, caps, `planSittingStart`, folds, `sittingMetrics`, the raw expiry                                                                                    |
| `packages/shared/src/api.ts`                             | the sitting methods, `SittingDetail`, `RecordLeetcodeAttemptInput` (legacy)                                                                                                            |
| `packages/shared/src/leetcode.ts`                        | `normalizeVerdict` — status_code first, status_msg fallback; `LC_INGEST_METHODS`                                                                                                       |
| `packages/shared/src/dates.ts`                           | `dayKeyForOffset` — bucket by the client's tz + `dayStartHour`                                                                                                                         |
| `packages/shared/src/contractTests.ts`                   | one suite, run 3× — stub, backend direct, backend via handleRpc (`lc sittings`)                                                                                                        |
| `app/src/pages/Recruiting/`                              | `SittingsSection.tsx` + `recruitingHelpers.ts` (outcome, summary, grouping, verdict tone)                                                                                              |
| `app/src/data/hooks/useSittings.ts`                      | React Query read hook                                                                                                                                                                  |
| `app/src/pages/Settings/index.tsx`                       | `LeetcodeSection` — the roll a sitting is a rep of                                                                                                                                     |
| `lambdas/src/index.ts`                                   | the ingest gate: device token or JWT for `LC_INGEST_METHODS`, the 300 KB pre-parse cap                                                                                                 |
| `lambdas/src/auth/verify.ts`                             | `resolveDeviceUserId`                                                                                                                                                                  |
| `lambdas/src/backend.ts`                                 | the sitting methods, the rep's end hooks; `recordLeetcodeAttempt` (legacy)                                                                                                             |
| `lambdas/src/ddb/keys.ts`, `repo.ts`                     | `lcsit#` / `lcs#<id>#…` / `lcq#` keys; `lc#<day>#<id>` (legacy)                                                                                                                        |
| `cdk/src/lib/data-stack.ts`                              | TTL on `expiresAt` (both stages)                                                                                                                                                       |
| `scripts/src/devcheck/scenarios/lc-sittings.ts`          | the dev check's rows for sittings                                                                                                                                                      |
| `cdk/src/config/ciSecrets.ts`, `cdk/src/bin/aperture.ts` | `stageSecret('DEVICE_TOKEN', stage)` / `deviceUserIdFor`                                                                                                                               |

## Operator setup

### 1. GitHub secrets + vars (do this before the first deploy)

- [ ] **secret** `DEVICE_TOKEN_DEV` — any long random hex string (`openssl rand -hex 24`).
- [ ] **secret** `DEVICE_TOKEN_PROD` — a _different_ one, in the `prod` GitHub environment (`gh secret set DEVICE_TOKEN_PROD --env prod`), not repo-level.
- [ ] **var** `DEVICE_USER_ID_DEV` — your **dev** Cognito `sub`.
- [ ] **var** `DEVICE_USER_ID_PROD` — your **prod** Cognito `sub`.

Both pairs are load-bearing, and they fail in different ways:

- `DEVICE_TOKEN_*` unset or misnamed → the CI synth **fails, naming the secret** (`stageSecret`, since
  prod-secrets). Before that guard, each CI deploy minted a fresh random token, so the token saved in your
  extension options silently stopped matching after any deploy. (A _local_ `cdk synth`
  reuses the gitignored `cdk/.secrets/device-token.<stage>` file, so it's stable there — which is
  exactly why this is easy to miss until CI runs.)
- `DEVICE_USER_ID_*` unset → the handler falls back to userId `'local'`, so attempts are written under
  `u#local` while the page reads under `u#<your sub>`. **Capture works, the page stays empty, and
  nothing errors anywhere.** This is the single most confusing failure mode in the feature.
- `DEVICE_USER_ID_*` also gates the **finance sync schedule** ([finances/](../finances/index.md)): unset →
  no scheduled sync on that stage (Refresh still works); wrong → the schedule syncs an empty partition,
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

Safari has been the daily browser since 2026-10-04; the Firefox install below is retained, not in use.

**1. Daily driver — the Safari prod app, prod origin, your personal Safari profile.**
This is the only one that needs to be permanent, and it genuinely does: a temporary extension you forgot
to re-load after a restart doesn't error, it just silently stops capturing. Same silent-failure family as
the identity seam. Build: `extension/README.md` → _Build it for Safari_.

**2. Stage validation — the Safari dev app (red icon), dev origin, an "Aperture Dev" Safari profile.**
A second app with its own bundle ID (`…ApertureLeetCodeDev`), so its options are separate, and enabled
only in that profile while prod is disabled there — exactly one capture path per profile, so real
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

Safari: Develop → **Add Temporary Extension…** → this repo's `extension/` folder (Safari 18.4+; the
Develop menu needs Settings → Advanced → _Show features for web developers_). Firefox: steps and the
128+ requirement in `extension/README.md` → _Load it in Firefox_. Options: README → _Configure_.
Temporary extensions don't survive a restart; re-add each time — acceptable for iteration, not for the
daily driver.

### Firefox: signing via AMO (2026-09-08, retained)

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

**Firefox:** two simultaneously-installed copies need two distinct `browser_specific_settings.gecko.id` values —
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
| New browser / profile / machine                                                      | paste the token there — `storage.local` is per-profile                                                                                  |
| Browser restart (temporary extension only)                                           | re-add it. The installed apps / signed add-on are unaffected                                                                            |
| Free Apple certificate expiry (2027-09-28)                                           | rebuild both Safari projects in Xcode, re-copy to `/Applications`, delete DerivedData                                                   |
| Apple Development cert revoked or replaced (e.g. Xcode on another Mac, a cert reset) | the extension stops loading — rebuild both projects. Development signatures carry no secure timestamp, so they don't outlive their cert |
| Extension code change                                                                | rebuild per README → _Build it for Safari_ (prod: re-copy files first; both: redo step 4)                                               |

**Every "paste the token" above needs its current value.** A GitHub secret can't be read back, so the
Lambda is the only place to recover it. Run on the Mac (the container has no AWS credentials), with
`<stage>` as `prod` or `dev`:

```
aws lambda get-function-configuration --function-name aperture-bff-<stage> --region us-west-1 --query 'Environment.Variables.DEVICE_TOKEN' --output text
```

Storage is keyed by extension ID, so the saved token should survive a temporary→signed transition with
the ID unchanged. Worth confirming on the first signed install rather than assuming.

### The Chrome alternative (no signing)

Chrome **persists unpacked extensions across restarts** (`chrome://extensions` → Developer mode → Load
unpacked) — the one property Firefox temporary add-ons lack. It nags with a bubble but stays loaded.
Chrome has supported `world: "MAIN"` since 111, and the code already does `browser.*` with a `chrome`
fallback. But the Chrome path is **untested** (see Open items), so this trades one AMO upload for an
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

Sittings log `{"event":"lc_sitting_start","sittingId":…,"attach":bool}` per Start and
`{"event":"lc_ingest","sittingId":…,"accepted":n,"duplicates":n,"bytes":n}` per events call — never code or
payloads. The legacy ingest logs one line: `{"event":"leetcode_ingest","problemSlug":…,"metaCaptured":true|false}`.
`metaCaptured` is the DOM-scrape hit rate — a run of `false` means the scrape broke. It's a CloudWatch
Logs Insights query, deliberately **not** a custom metric: at $0.30/month a metric would be the single
largest line item in this project.

## Open items

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
- **Dedup is a prefix scan.** `findLeetcodeBySubmissionId` reads the whole `lc#` prefix per ingest —
  same single-user tolerance as `findLog`/`findPlan`, flagged `TODO(scale)` in `repo.ts`. A
  `lcsub#<id>` pointer item makes it a direct read when volume justifies it.
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
