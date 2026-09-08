# Recruiting — LeetCode attempt capture

The Recruiting module records **every** LeetCode submission you make — accepted *and* wrong — and shows
them at `/recruiting` as a reverse-chron list with a derived per-problem attempt count ("attempt 2 of 2").

Wrong attempts are the point. A solved-problems counter is a scoreboard; the wrong→accepted arc is the
same **calibration** move as tasks — what it actually took versus what you thought. Presentation follows
the anti-guilt rule: accepted reads teal (positive), everything else reads gold (attention), never red.

Rows are written by a **browser extension**, not by the app. There is no authoring UI and never will be.

## The shape

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
Lambda Function URL (OAC) — lambdas/src/index.ts
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
PWA /recruiting → useLeetcodeAttempts() → api.listLeetcodeAttempts(range?)
  │  Cognito JWT, same-origin /api/*
  ▼
Lambda → resolveUserId → userId = JWT `sub`
  ▼
Repo: query PK=u#<sub>, SK begins_with 'lc#'  → range filter → sort submittedAt DESC
  ▼
recruitingHelpers.withAttemptOrdinals()   ← "attempt N of M" computed at render, never stored
```

## Design decisions worth not re-litigating

**The extension is 100% passive toward LeetCode.** It never issues a request *to LeetCode* — it only
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

| Path | What |
| --- | --- |
| `extension/` | Firefox MV3 add-on. No deps, no bundler, no build step. `README.md` there is the wire contract. |
| `packages/shared/src/types.ts` | `LeetcodeAttempt`, `LeetcodeVerdict` |
| `packages/shared/src/api.ts` | `RecordLeetcodeAttemptInput`, the two `ApiClient` methods |
| `packages/shared/src/leetcode.ts` | `normalizeVerdict` — status_code first, status_msg fallback |
| `packages/shared/src/dates.ts` | `dayKeyForOffset` — bucket by the client's tz + `dayStartHour` |
| `packages/shared/src/contractTests.ts` | one suite, run 3× — stub, backend direct, backend via handleRpc |
| `app/src/pages/Recruiting/` | page + `recruitingHelpers.ts` (ordinals, summary, verdict tone) |
| `app/src/data/hooks/useLeetcodeAttempts.ts` | React Query read hook |
| `lambdas/src/auth/verify.ts` | `resolveDeviceUserId` |
| `lambdas/src/backend.ts` | `recordLeetcodeAttempt` / `listLeetcodeAttempts` |
| `lambdas/src/ddb/keys.ts` | `lc#<day>#<id>` sort keys |
| `cdk/src/bin/aperture.ts` | `deviceTokenFor` / `deviceUserIdFor` |

## Operator setup

### 1. GitHub secrets + vars (do this before the first deploy)

- [ ] **secret** `DEVICE_TOKEN_DEV` — any long random hex string (`openssl rand -hex 24`).
- [ ] **secret** `DEVICE_TOKEN_PROD` — a *different* one.
- [ ] **var** `DEVICE_USER_ID_DEV` — your **dev** Cognito `sub`.
- [ ] **var** `DEVICE_USER_ID_PROD` — your **prod** Cognito `sub`.

Both pairs are load-bearing, and they fail in different ways:

- `DEVICE_TOKEN_*` unset → `deviceTokenFor()` mints a **fresh random token on every CI deploy**, so the
  token saved in your extension options silently stops matching after any deploy. (A *local* `cdk synth`
  reuses the gitignored `cdk/.secrets/device-token.<stage>` file, so it's stable there — which is
  exactly why this is easy to miss until CI runs.)
- `DEVICE_USER_ID_*` unset → the handler falls back to userId `'local'`, so attempts are written under
  `u#local` while the page reads under `u#<your sub>`. **Capture works, the page stays empty, and
  nothing errors anywhere.** This is the single most confusing failure mode in the feature.

Find your `sub`: sign in to the app, then decode the access token's payload, or read it from the Cognito
console (User pools → your pool → Users → the user → "sub" attribute).

### 2. Load the extension

See **Deployment & install** below — the setup differs depending on whether you're capturing for real or
validating a stage.

## Deployment & install

### The origins

| Stage | Origin |
| --- | --- |
| prod | `https://aperture.rahuldatta.dev` |
| dev | `https://dev.aperture.rahuldatta.dev` |

Both have been live on their custom domains since 2026-08 (INFRA §8). **There is no local origin** — the
Vite dev server has no `/api/*` route and there's no local API script, so "point it at localhost" has
nothing on the other end. "Dev" here always means the deployed AWS stage, never your machine.

### Three layers, each matched to its job

**1. Daily driver — one signed extension, prod origin, your main Firefox profile.**
This is the only one that needs to be permanent, and it genuinely does: a temporary add-on you forgot to
re-load after a restart doesn't error, it just silently stops capturing. Same silent-failure family as
the identity seam, and the reason signing is worth the one-time effort.

**2. Stage validation — a temporary add-on in a SEPARATE Firefox profile, dev origin.**
`about:profiles` → create a profile → load the add-on there from `about:debugging`. Separate profiles
have separate extension storage, so there's no ID collision with the signed copy and no chance of your
real practice landing in dev. This is where the four ingest checks get run.

**3. Extension code iteration — temporary add-on, no endpoint needed.**
`background.js` logs every outcome (`recorded attempt … -> 200`, `backend rejected attempt … <status>`,
`failed to POST attempt …`), and everything upstream of the POST runs regardless. This is how the capture
half was verified on 2026-08-09.

### Loading a temporary add-on (layers 2 and 3)

Firefox 128+ (needs `content_scripts` `world: "MAIN"`).

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `extension/manifest.json`.
2. Open its **options** page and set **API origin** (scheme + host, no path) and **Device token**.
3. Accept the optional host-permission prompt for that origin — the POST can't be sent without it.

Temporary add-ons don't survive a Firefox restart; re-add each time. Acceptable for validation work,
not for the daily driver.

### Signing for permanent install (layer 1, one-time)

Firefox **Release and Beta enforce extension signatures and cannot be told not to** —
`xpinstall.signatures.required` only takes effect on Developer Edition, Nightly, and ESR. So permanent
install means signing.

Signing does **not** mean publishing. addons.mozilla.org accepts **unlisted** submissions: upload the
zipped extension, get back a signed `.xpi` for self-distribution, never shown in the public directory,
free. Install it via `about:addons` → gear icon → **Install Add-on From File**. Each new upload needs a
`version` bump in `manifest.json`.

**The extension ID is permanent once signed.** It's `aperture-leetcode@rahuldatta.dev` — changing it
later makes it a *different* add-on, meaning a reinstall and a lost stored token. Settle it before the
first submission, not after.

### Why not two permanent installs (one per stage)

Two simultaneously-installed copies need two distinct `browser_specific_settings.gecko.id` values —
the ID *is* the add-on's identity. That's two manifests, two names, two AMO submissions, and two signing
rounds on every change, forever. And what it buys is two live capture paths, which is the opposite of
what you want: real practice should land in exactly one stage. A separate profile gets the same
isolation for free.

### What ever invalidates the setup

The token exists in three places — the GitHub secret (source of truth), the Lambda env var (re-derived
automatically on every deploy), and the extension's `storage.local` (manual, **never** syncs). Only the
third one is ongoing work, and only for these events:

| Event | What you redo |
| --- | --- |
| Any normal deploy | **nothing** |
| Rotating the token deliberately | update the GitHub secret → redeploy → re-paste in the extension |
| Cognito pool replaced | new `sub` → update the GitHub var → redeploy. Data stack is `RETAIN`, so realistically never |
| Origin changes | re-paste `apiOrigin` + re-grant the host permission. Not expected; the domains have been live since 2026-08 |
| New browser / profile / machine | paste the token there — `storage.local` is per-profile |
| Firefox restart (temporary add-on only) | re-add it. The signed install is unaffected |

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

| | App locally (`pnpm dev`) | Extension, no live endpoint | dev stage (deployed) |
| --- | --- | --- | --- |
| API | `StubClient`, localStorage | — | real Lambda + DynamoDB |
| Auth | bypassed, `local@aperture.dev` | — | real Cognito JWT |
| Data | `seed.ts` (5 attempts, two arcs) | — | what you actually submitted |
| Proves | the whole UI surface | interception + DOM scrape | the ingest half |
| Iteration | instant HMR | reload the add-on | full CI deploy |

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

**All four passed on dev in 2026-08**, alongside the capture half on 2026-08-09. So none of these are
unknowns — they're re-verify-on-drift, in the same bucket as the interceptor matching LeetCode's live
request shapes and the DOM scrape finding the difficulty pill. Two things can silently invalidate them:
LeetCode changing its request or page shape, and a **prod** run being the first exercise of a separate
stage's secrets (a different token, a different Cognito pool, a different `sub`). Nothing warns you.

Since a submission is a real write to real data, dev is where you do this — not prod. Smoke tests use
`testMode` with a synthetic user and a no-op writes object, so they never exercise the ingest path.

### Watching an ingest

Every ingest logs one line: `{"event":"leetcode_ingest","problemSlug":…,"metaCaptured":true|false}`.
`metaCaptured` is the DOM-scrape hit rate — a run of `false` means the scrape broke. It's a CloudWatch
Logs Insights query, deliberately **not** a custom metric: at $0.30/month a metric would be the single
largest line item in this project.

## Open items

- **Validated on dev in 2026-08, but never merged to `main`.** The branch was pushed to `dev`, deployed,
  and the Recruiting page confirmed working there — `DEVICE_TOKEN_DEV` has been set since. `dev` was
  later force-moved onto another feature branch, so **the branch pointer retains no trace of this; the
  GitHub Actions run history is the only record.** Don't re-derive deployment history from
  `git log origin/dev` — it will tell you this never happened. Prod has never had the feature.
- **The summary line is hidden until there's data.** `0 solved · 0 problems · 0 attempts` sits outside
  `EmptyState`'s reach, so it would have kept asserting a total while the query was still loading or had
  failed. Revisit if a zero-state summary ever earns its place.
- **Dedup is a prefix scan.** `findLeetcodeBySubmissionId` reads the whole `lc#` prefix per ingest —
  same single-user tolerance as `findLog`/`findPlan`, flagged `TODO(scale, pre-deploy)` in `repo.ts`. A
  `lcsub#<id>` pointer item makes it a direct read when volume justifies it.
- **Not signed yet.** Every install so far has been a temporary add-on. Signing is a one-time AMO
  unlisted submission (see Deployment & install) and should happen *after* the dev-stage validation
  passes — signing first just means signing twice.
- **Chrome path untested.** `world: "MAIN"` is supported there since 111 and the code has a `chrome`
  fallback, but neither has been run.
- **No aggregate views.** No per-topic breakdown, no difficulty mix, no time-to-solve. V2, and per
  **[EvaluatingChanges.md](EvaluatingChanges.md)** those wait for real usage rather than being designed
  against a guess.
