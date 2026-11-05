# Aperture — Technical Spec

Implements `../product/PRODUCT.md`. AWS-native PWA, web-first, online-first. Solo build, single user.
Status: built — see [`docs/index.md`](../index.md). Started: 2026-08-02.

> Product is the source of truth. If this doc and `../product/PRODUCT.md` disagree, product wins.

---

## 1. Stack & architecture

**AWS-native serverless BFF.** Multi-device sync is structural, not built: DynamoDB is the shared source of truth, so laptop + phone just hit the same API.

```
React PWA (S3 + CloudFront) --Cognito JWT--> Lambda Function URL (auth NONE + origin-secret header) --> Lambda BFF --> DynamoDB (SoR)
```

**Frontend**
- **Framework:** Vite + React + TypeScript.
- **PWA:** `vite-plugin-pwa` — manifest, service worker, installable. App shell caches for offline load; **data is online-first** (see below).
- **Client data:** **React Query** — fetch/cache/mutate against the Lambda API. (Dexie/local-first dropped in the AWS pivot; may return later only as an offline cache.)
- **Routing:** React Router. **UI/session state:** React Context + hooks (home mode, running timer).
- **Styling:** **Tailwind (v4, CSS-first)** with theme colors as **CSS custom properties** (`--surface`, `--fg`, `--accent-gold`, …) → auto light/dark is a one-line flip. Anti-generic: semantic token layer + a few primitive components, not raw utilities everywhere.
- **Testing:** Vitest. **Lint/format:** ESLint + Prettier.
- **Dates:** **roll our own** small helpers (day-start offset + ISO-week cadence are small, targeted) — only reach for a date lib if DST edge cases prove genuinely gnarly. Per [CONVENTIONS.md](../product/CONVENTIONS.md).
- **Charts:** deferred; v1 viz is hand-rolled CSS/SVG.

**Backend / infra (resolved — the blueprint is [INFRA.md](INFRA.md))**
- **Hosting:** S3 (static) + CloudFront (CDN + HTTPS — required for the PWA service worker).
- **Auth:** Cognito (multi-device identity → JWT validated by the API).
- **Compute:** Lambda(s), TS/esbuild.
- **Data:** DynamoDB, on-demand. Logical entities per §2; the physical model (keys / access patterns) is §2.4 — DDB is access-pattern-first, not relational.
- **Cost:** effectively free at single-user scale — breakdown in INFRA §11.

**Resolved (as built):** Lambda Function URL, not API Gateway (INFRA §4) · Cognito (§6) · single-table DDB (§5) · one multi-route Lambda (§4) · CDK (§3) · custom domain (§8).

**Offline stance (v1):** online-first. PWA installs and the shell loads offline, but data reads/writes need connectivity. Offline editing + a sync-on-reconnect write queue is a **later enhancement**, not v1.

**Version discipline:** check the registry (`npm show <pkg> version`) before pinning — the rule lives in `CLAUDE.md`.

---

## 2. Data model

Logical entities below are **storage-agnostic**; the physical DynamoDB shape is §2.4 (single-table, as built).

### 2.1 Global conventions
- **IDs:** client-generated **ULIDs** (unique across devices, time-sortable). Exception: Plaid-owned finance rows (items and their sync states, accounts, transactions) use Plaid's ids — [finances/](../areas/finances/index.md).
- **Ownership:** every item scoped to `userId`.
- **Timestamps:** epoch-ms. `day` / `date` strings are computed with the **configurable day-start offset** (`settings.dayStartHour`, default **4am** — so late-night work lands on the right day).
- **Soft-delete everywhere:** every entity has `createdAt`, `updatedAt`, `deletedAt`. **Never hard-delete**; queries filter out tombstones. One live violation — see **[Tech debt](#tech-debt)**.
- **`exportData` excludes tombstones.** The "you own your data" snapshot returns live rows only, on both impls, asserted by the export contract test. So a soft-deleted row is **unrecoverable from an export** — deliberate while the export is a one-way download with no import path. If restore/merge ever lands it will need tombstones plus a versioned envelope; revisit then. The bundle's shape is the shared `ExportBundle` type, and every collection is required — omitting one is a compile error, not a silent gap (which is how `leetcodeAttempts` once shipped missing).

### 2.2 Entities

**logEntries** — `id · createdAt · day · text`. Edit allowed; soft-delete allowed.

**tasks** — the signature module.
- `id · title · status · categoryId · seriesId? · rollId? · dueDay? · dueTime? · notes? · reflection? · createdAt · startedAt? · completedAt? · cancelledAt?`
- `rollId` (id | null) — set when the task is a **rep** of a [Roll](../areas/home/rolls.md). Required-nullable; readers compare `=== id` / `!rollId` (pre-existing rows read back `undefined`). The contact-sheet momentum is derived from done tasks carrying this — no counter.
- `status`: `backlog | planned | in_progress | done | cancelled`.
- `dueDay` (`YYYY-MM-DD` | null) — **when it's due**, distinct from `taskPlans.day` (*when I'll work it*). Free metadata: set in the scope pass, editable at any status, **never part of the estimate lock**. Design: [areas/tasks/due-dates.md](../areas/tasks/due-dates.md).
- `dueTime` (`HH:MM` 24h local | null) — the deadline's clock time, only with a `dueDay` (clearing the day clears it). Drives the urgency colour and calendar auto-sync (`gcalSyncError` holds a failed sync; `Settings.autoCalendar` is the toggle — [areas/calendar/index.md](../areas/calendar/index.md) → Auto-sync).
- Two-way calendar sync bookkeeping — `gcalSeen` (with Google's `updated`) and `gcalPulled` — is **optional** on `Task` (absent on old rows and literals), the one exception to required-nullable: sync state, not task data. A Google edit can set `title`, `dueDay`/`dueTime` and `estimateMin` ([areas/calendar/index.md](../areas/calendar/index.md) → Two-way sync).
- `notes` (string | null, ≤ 5,000 chars) — free-form light markdown, editable at any status, **never part of the estimate lock**. Required-nullable; pre-existing rows read back `undefined`, so readers use `!notes`. Design: [areas/tasks/notes.md](../areas/tasks/notes.md).
- `reflection` (string | null, ≤ 1,000 chars) — the look back written at completion, same markdown as notes, editable at any status, **never part of the estimate lock**. Required-nullable; old rows read `undefined` → `!reflection`. Design: [areas/tasks/reflection.md](../areas/tasks/reflection.md).
- **Estimate handling:** `estimateMin` + `bufferMin` (the **working** estimate) are editable at any open status — not `done`/`cancelled`. On the **first transition out of planning** (→ `in_progress` or `done`), `estimateLockedMin` is snapshotted and frozen; a later edit never touches it. **Calibration = `actualAccruedMin` vs `estimateLockedMin`.** Work that turned out bigger is **split** (this part done or kept going + a linked follow-up), never by editing the locked estimate.
- `parentId` (string | null) — the task this one is a part of (2026-10-08; replaced `splitFromId`, whose stored attribute is inert on old rows). One level; parenthood is derived, never stored. A parent holds the deadline and never takes plans, sessions or its own estimate; its `estimateLockedMin` freezes when its first part starts (the one lock that's ever cleared: a parent whose last part goes is plain again, and its lock goes with them), and its `actualAccruedMin` is stamped with Σ done parts when it's marked done (refused while a part is open). Every part, and a done parent, is a calibration point. A parent's one calendar event is its due marker; a part's block is named after it (v2a). Required-nullable; old rows read `undefined` → `!parentId`. Design: [areas/tasks/parts.md](../areas/tasks/parts.md).
- `actualAccruedMin` — **denormalized**, bumped when a *work* session closes onto an open task (excludes breaks + paused time; a session stopped onto a `done`/`cancelled` task keeps its minutes in history and adds none — shared `accruesTime`). Avoids scanning sessions.
- `cancelled` tasks are excluded from calibration.
- **Drop vs Delete are different.** Drop = `transitionTask(→cancelled)`, which keeps the row as history (excluded from calibration). Delete = `deleteTask`, a **permanent** action that tombstones the task **and cascades** — its plan rows and attachment metadata are tombstoned too, and any calendar event is hard-deleted via the [cancel path](../areas/calendar/index.md#delete-on-cancel); each attachment's S3 bytes are deleted first ([attachments D7](../areas/tasks/attachments.md)). Delete is hidden on a recurring occurrence (`seriesId != null`) — `getDay` would just respawn it; Drop, or `deactivateSeries` for the whole series, is the tool there.

**taskPlans** — scheduling (the *when*), separate from the task (the *what*). Enables multi-day + ordering.
- `id · taskId · day · plannedMinutes · order`. A task may have plan rows on several days. A **timed** task (`dueDay` + `dueTime`) has none: its day is its time, and `upsertPlan` refuses it ([lenses.md](../areas/tasks/lenses.md) D13). Morning "planned hours" for a day = Σ `plannedMinutes` on that day. "Remaining" = `estimateMin − actualAccruedMin` (the working estimate).
- **Stale sweep (lazy rollover).** `getDay(today)` moves every `planned` task with no alive plan row on today or later back to `backlog`, and every timed `planned` task whatever its rows — a recurring untimed occurrence already superseded by its series' copy today is dropped (`cancelled`) instead. Plan rows stay as history; `in_progress` is untouched. Rule: shared `stalePlannedMoves`. It runs on app open, not on a schedule (the server has no timezone), so MCP reads lag until the app loads today. `getDay` must only ever be called with the client's current day — a future day would sweep today's plan.

**taskSeries** — recurrence template.
- `id · title · categoryId · defaultEstimateMin · rule · active · anchorDate`.
- `rule` (**simple** for v1): `{ kind: daily | weekdays | weekly | everyN, interval?, daysOfWeek?[] }`. Full RRULE (nth-weekday-of-month, exceptions) is deferred.
- Each occurrence is a real **task** instance with `seriesId` → its own estimate/actual → **its own calibration point**. Editing one occurrence doesn't touch siblings; editing the series affects future occurrences. Generation horizon/strategy (client vs scheduled Lambda) is an infra detail.

**ideas** — `id · text · createdAt · status(open | triaged | discarded)`.

**habits** — `id · name · categoryId · cadencePerWeek · active`. (Recurring *behaviors*, binary, no estimate — distinct from recurring tasks.)
**habitChecks** — `id · habitId · date`. Compound uniqueness on `(habitId, date)`.

**rolls** — `id · name · categoryId · estimateMin · active`. Deadline-free ongoing *efforts* (LeetCode daily, study). A "rep" is a done **task** with `rollId` — momentum is **derived** from those (no stored counter, no streak). Picking one for a day creates a planned rep on that day's plan (`pickRollToday`, reuses an open rep). Distinct from habits (a timed task vs a binary check). Design: [areas/home/rolls.md](../areas/home/rolls.md).

**pomodoroSessions**
- `id · taskId? · categoryId · wasWork · kind · startedAt · endedAt? · day · activeMinutes · status · lastHeartbeatAt`
- `kind`: `work | break` — **only `work` accrues** to `task.actualAccruedMin` + time-budget.
- `wasWork`: **snapshot** of the category's `isWork` at write time → immutable balance history.
- `categoryId`: **follows the task** when `taskId` is set; manual only for taskless freeform focus.
- **Pauses supported** — `activeMinutes` accumulates only un-paused time; paused time never counts.
- `status`: `running | completed | discarded`. Running sessions are persisted with a **heartbeat** (`lastHeartbeatAt`); on next open, a stale running session prompts **keep (capped at last heartbeat) / discard** — no orphans.

**days** — per-day singleton: `date(pk) · capacityHours · intent · reflectionPrompt · reflectionText`.

**categories** — `id · label · isWork · order · active`.
- **Retire** = `active: false` (Settings → Retire…, or MCP `update_category`): hidden from every picker, sorted after active ones in Settings, but the label still resolves on existing tasks and an edit form shows the item's own retired category as "X (retired)". On update `order`/`active` are patch-style — omitted keeps the current value, so a rename never un-retires.
- Referenced by **id**. **Labels resolve live** (renames propagate to display). **`isWork` is snapshotted** onto sessions (`wasWork`) so history is frozen. Flipping `isWork` prompts an **optional retroactive backfill** ("also reclassify N past records?"). **Deleting** forces reassignment of all referencing items to another category first, then soft-deletes the empty one.

**leetcodeAttempts** — one row per LeetCode submission, accepted **and** wrong. Written by a browser extension, never by the app.
- `id · day · problemSlug · problemTitle · verdict · submittedAt · lang · runtimeMs? · memory? · leetcodeSubmissionId · frontendId? · difficulty? · topicTags?`
- `verdict`: `accepted | wrong_answer | time_limit | runtime_error | compile_error | memory_limit | other`. **Normalized server-side** from LeetCode's raw `status_code`/`status_msg` — the dep-free extension forwards raw signals only.
- `day` is bucketed server-side from `submittedAt` + the client's reported tz offset + `dayStartHour` (the server owns `dayStartHour`, so a foreign client can't compute the day key itself).
- **Idempotent on `leetcodeSubmissionId`** — a re-fire returns the existing row, original verdict intact.
- **Attempt count per problem is DERIVED at read time**, never a stored counter.
- Ingest is the one method authenticated by a static **device token** instead of a Cognito JWT. Full design + operator setup: **[recruiting/](../areas/recruiting/index.md)**.

**stories** — behavioral-interview STAR stories, authored in-app (the one place structured-at-entry is right — a story is a slowly-tightened artifact, not a capture).
- `id · title · competencyTags[] · situation · action · result`
- `competencyTags`: the fixed `CompetencyTag` union (`leadership · conflict · ownership · failure · ambiguity · impact`), a shared constant — not the editable `Category` entity. Multi-select.
- Title required; S/A/R may be empty (a title-only stub is valid). List is `updatedAt`-desc; soft-delete like everything else. Full design: **[recruiting/story-bank.md](../areas/recruiting/story-bank.md)**.

**attachments** — files on a task (receipt, spec, screenshot); the first entity whose payload is **bytes**, not JSON.
- `id · taskId · filename · contentType · size · s3Key · status(pending|ready)` — metadata only; the bytes live in a separate **precious S3 bucket** at `u/<userId>/<taskId>/<id>`, never in DynamoDB.
- Bytes move browser↔S3 directly via **presigned URLs** the Lambda signs but never carries — the JSON RPC edge stays binary-free. `pending` until the browser confirms the PUT; only `ready` rows list/export. Delete removes the object (the versioned bucket keeps it 30 days), then tombstones the metadata. Full design: **[tasks/attachments.md](../areas/tasks/attachments.md)**.

**finance** — Plaid-synced bank data: `financeItems` (a bank login), `financeSyncStates` (per item: cursor, lock, request/refresh stamps), `financeAccounts`, `financeTransactions`, `financeRules` (ULID ids). Transaction fields are Plaid-owned (amount, date, merchant…) except the **user-owned** ones a sync never overwrites: `bucket · bucketSetBy · periodOverride · note · refundOfId · startsPeriod`. Design: [finances/](../areas/finances/index.md).

**settings** — singleton: `dayStartHour` (default 4), pomodoro work/break durations, theme override, `financeBudgetCents` (default 60000), `financePaymentDay` (default 20), etc.

### 2.3 Rules distilled (from the poke-holes pass)
1. The calibration baseline (`estimateLockedMin`) freezes on first exit from planning; calibration uses the frozen value; the working estimate stays editable until done/cancelled; bigger-than-thought ⇒ split (split.ts).
2. Categories: id-referenced, live labels, snapshotted `isWork`, reassign-on-delete, opt-in backfill on flip.
3. Sessions: heartbeat-persisted, `work|break`, pauses excluded, category follows task, orphan ⇒ keep/discard.
4. Never hard-delete — `deletedAt` tombstones everywhere.
5. ULIDs, `userId` on everything, `updatedAt` for last-write-wins across devices.
6. Day buckets use the configurable `dayStartHour` (default 4am).

### 2.4 Physical model — DynamoDB single-table (as built; `lambdas/src/ddb/keys.ts`)
```
PK = u#<userId>            (one partition per user — fine at single-user volume)
SK (type-prefixed range keys):
  log#<day>#<ulid>              day's log entries          (begins_with log#<day>)
  task#<ulid>                   task by id
  plan#<day>#<order>#<ulid>     day's planned tasks, sorted (begins_with plan#<day>)
  sess#<day>#<ulid>             sessions for a day / week range
  sess#running#<ulid>           running timers (direct get for the heartbeat; moved to the day bucket on stop)
  lc#<day>#<ulid>               LeetCode attempts, day-bucketed  (begins_with lc#)
  flux#<day>#<ulid>             Flux sets, day-bucketed; the client mints the ulid (idempotent put-if-absent; soft-delete tombstones)
  hcheck#<date>#<habitId>       habit checks (also enforces one-per-day)
  day#<date>                    day singleton (direct get)
  attach#<taskId>#<ulid>        a task's attachments        (begins_with attach#<taskId>)
  habit#<id> · roll#<id> · cat#<id> · idea#<ulid> · series#<id> · story#<ulid> · settings
  fin#item#<id> · fin#sync#<itemId> · fin#acct#<id> · fin#txn#<id> · fin#rule#<ulid>   finances
  gcal#sync#<sub>               calendar two-way sync cursor, one per Google account
  place#<id> · ptoken           errand places; the place token's pointer {hash|null, createdAt, hint, retiring[], updatedAt}
PK = placetoken#<sha256hex> / SK = placetoken
                                the place token's lookup row {userId, …} — the one non-u# partition: the
                                Shortcut route resolves a user from a token (tasks/places.md §4)
```
- **One GSI, two key spaces:** calibration — done tasks by completion date (`GSI1PK = u#<userId>#done`, `GSI1SK = <completedAt>`); finance — transactions by date (`GSI1PK = u#<userId>#fintxn`, `GSI1SK` = the date's UTC-midnight epoch ms).
- **Attachment bytes are NOT in this table** — only the metadata item above. Bytes live in the precious S3 Files bucket (INFRA §3), reached via presigned URLs.
- **Denormalized** `task.actualAccruedMin` → no session-scan for "remaining".
- **Balance / time-budget aggregate in the Lambda** over the day/week range (no GSI needed at this volume).
- Access patterns as built: the keys above satisfy them with prefix reads + the one GSI's two key spaces.

---

## 3. Routing & state

**Routes (React Router):**
- `/` — the glanceable **home** (auto morning/day/night by clock, manual override). The hub; ≤5 things per mode.
- `/log · /tasks · /recruiting (+ /recruiting/stories) · /finances (+ /finances/all, /finances/rules) · /habits · /rolls · /flux (+ /flux/:exerciseId) · /inbox · /settings` — the **deep views** (full backlog, browse past log days, LeetCode attempts + the story bank, the budget's sort queue + ledger + rules, manage habits, manage rolls + their contact sheets, guided neck exercises on the camera, triage ideas, edit categories / durations / theme / export). **Home = glance, deep views = work.**
- **Pomodoro is not a route** — a persistent element; the running (heartbeat-backed) timer follows you across views.
- **Capture bar is global** — always present, not a route.

**State — three layers:**
- **Server/data → React Query.** One query per access pattern. Task writes are **written through**: what a write returns goes straight into the one tasks list (`app/src/data/taskCache.ts`), newer `updatedAt` wins, and the app remembers its own writes for 60 s so the BFF's eventually consistent `listTasks` (not retried) never undoes one; the invalidate still runs for rows a write changes without returning (a parent's lock, plan rows, the day's sweep). The backlog derives from that list. On the BFF, any task read whose copy is written back is strongly consistent (`mustTask` and kin), so two quick RPCs on one task never lose the first (plan rows, sessions and the day row still read eventually).
- **UI/session → React Context.** Current home mode, running timer, capture-bar state.
- **Auth → Cognito session** in a context provider. Frontend lib: **`react-oidc-context` + Cognito Hosted UI** (PKCE auth-code grant, no client secret).

**Session persistence.** Tokens live in **`localStorage`**, not oidc-client-ts's `sessionStorage` default — `sessionStorage` dies with the browsing context, and the OS reclaims a standalone PWA's process routinely, which discarded a still-valid refresh token and forced a Hosted-UI sign-in roughly daily. The refresh token is what carries the session across relaunches: with one present, `signinSilent` renews against the token endpoint and never touches an iframe or the Hosted UI (whose own session cookie is fixed at 1 hour and isn't renewed by a token refresh). `refreshTokenValidity` is capped at **7 days** on the app client (Cognito's default is 30, max 3650) — short because the token sits in `localStorage`, so a leaked one has a bounded life. Access/ID tokens stay at the 1-hour default.

We build the `UserManager` ourselves (`app/src/auth/userManager.ts`) instead of letting `react-oidc-context` construct one from props, because the context wraps every navigator method to swallow rejections into `null` — which hides whether a failed renew was the network or the authority rejecting the grant.

**How renewal decides.** One rule shapes the rest: **wakeups retry a renewal the session already owes; they never start one.** A renew is owed only when the library says the token expired, when a silent renew errored, or when the BFF returns 401 — so `online` and `visibilitychange` are pure retries, and coming back to the app on a fresh token costs zero token requests. `userLoaded` and `userUnloaded` are the only points that reset the state, because the library raises them whoever did the work (us, `SilentRenewService`, or the redirect callback); resetting inside our own success path instead left the UI one expiry away from dropping the whole tree. Renewal clears the session **only** on `invalid_grant` — a network failure never discards the refresh token, it backs off (~30s over five attempts) and stays owed. After that the sign-in button appears: a render-only escape so an offline relaunch can't hang on the loading screen, with the stored token left intact. Retrying continues quietly behind that button every 60s — the `online`/`visibilitychange` listeners only catch failures the browser announces, and a Cognito 5xx, a captive portal or a DNS failure never flips `navigator.onLine`. A session that ends this way is expected rather than broken, so the underlying `invalid_grant` isn't surfaced as an error; asking for a sign-in clears that suppression, since from then on the user is acting and deserves to see what happens. On relaunch the renew is also asked for up front rather than waiting on the expiry timer — but never during the OAuth redirect callback, where it would race the code exchange on the old stored user. A 401 from the BFF routes into the same path via `tokenStore` and invalidates queries on success so panels that failed mid-401 recover; it is capped at **two renewals**, charged only when one actually starts, so a burst of concurrent 401s can't spend the budget without doing work. Uncapped, a 401 that *isn't* about the token (audience or issuer mismatch, clock skew) loops against the BFF and Cognito at network speed.

This machine is unit-tested against an injected fake `UserManager` in `app/src/auth/renewal.test.tsx`. `OidcBridge` takes the manager as a prop precisely so http-mode auth is reachable under vitest, where `API_MODE` is `stub` and `AuthProvider` would otherwise always take the bypass path — that blind spot is where every regression in this logic landed.

---

## 4. Folder structure & tooling

pnpm workspaces monorepo.

```
aperture/
  app/                 # React PWA (Vite)
    src/
      pages/           # Home, Log, Tasks, Recruiting, Habits, Rolls, Finances, Flux, Inbox, Settings (a dir each)
      modules/         # calendar, calibration, capture, finances, flux, habits, home, log, pomodoro, reflection, rolls, tasks
      components/      # primitives: Card, Text, … (anti-generic token layer)
      data/            # React Query hooks + the api clients (stubClient, httpClient) + seed
      lib/             # cx, format, useDisclosure, useRowAction (ulid/dates live in packages/shared)
      auth/            # Cognito/OIDC glue (userManager, OidcBridge, AuthProvider)
      styles/          # Tailwind tokens (CSS-var theme)
  lambdas/src/         # BFF — index.ts, handler.ts, backend.ts; auth/ (verify), ddb/ (keys, repo, writes,
                       #   mapping, DocClient), google/, mcp/, s3/
  cdk/src/             # CDK app — bin/aperture.ts, lib/ (data, app, cicd, billing stacks, monitoring), config/
  extension/           # Firefox MV3 add-on — LeetCode capture. No deps/bundler/build step; NOT a
                       #   pnpm workspace member, and excluded from eslint + prettier
  packages/shared/     # shared TS types + contract across app + lambda (also ulid, dates, machines, contractTests)
  scripts/             # dev + CI utilities
  tools/               # user-side clients run on the Mac (raycast/ quick-add) — not a pnpm workspace member
  docs/  ·  localNotes/
```

**Tooling:** pnpm (workspaces) · Vitest · Vite · TS project refs · ESLint + Prettier · esbuild-via-CDK for Lambda bundling · GitHub Actions CI. The rules (pnpm-only, one runner with Node parity, packages resolve from source + the `dist/`/TS6310 note, command shape, dependency discipline) are in **[CONVENTIONS.md](../product/CONVENTIONS.md)**; the toolchain pins as built and the version-pin gotchas are in **[V1_PLAN.md](../V1_PLAN.md) → Phase 0 (as built)**.

---

## 5. The AI seam (v1.1+, boundary only)

Reflection isn't built — just a clean boundary so it's additive later. The first model call that *is* built is quick add's parse ([tasks/quick-add](../areas/tasks/quick-add.md), 2026-10-12), and it set the pattern.
- **Server-side only:** the Lambda calls the model; never from the browser. This is why sending journal text out is a Lambda concern. The call is a **gated gateway** (`lambdas/src/anthropic/`): noop under testMode/smoke, a fake in tests, live fetch + the SSM key (INFRA §10) only in the Lambda entrypoints.
- **The 2026-10-09 carve-out is closed (2026-10-12):** the Raycast quick-add (`tools/raycast/`) used to call Haiku from the Mac with the user's own key in Keychain; a second client (the app's capture bar) wanted parsing, so the parse moved behind `parseTask` / the `parse_task` MCP tool and the Mac holds no model key ([areas/mcp → Raycast](../areas/mcp/index.md)).
- **Substrate already exists:** reflection reads `logEntries` / `tasks` / `pomodoroSessions` over a date range — existing access patterns. **No schema change** needed for basic reflection.
- **Reserved entity** (not built): `reflections` — `id · periodType(week|month|year) · periodKey · generatedAt · promptVersion · content`.
- **Model:** Claude (Anthropic API), latest at build time, per repo norms.

---

## Tech debt

Known deviations and defects, each named with the rule or invariant it breaks. An entry stays until
it's fixed or the rule changes — not until people stop noticing it.

### Worktree-blind git hooks — RESOLVED 2026-09-19 (`fix-hooks`)

Kept as a record. **Defect (surfaced 2026-09-17):** the git-aware hooks did `cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"`,
which is the main checkout even in a worktree session — `precommit-guard`'s credential scan ran
`git diff --cached` on the wrong index and `main-branch-guard` gated on the wrong branch. **Fix:**
`.claude/hooks/_hook-common.sh` → `hook_cd "$INPUT"` cd's to the hook stdin's `.cwd` (the worktree root),
falling back to `CLAUDE_PROJECT_DIR` then `$(pwd)`; verified empirically both ways. The rule for new
hooks: `.claude/hooks/README.md`. Note the fix only takes effect once merged to `main` and the main
checkout pulls it — the executing copy is always `${CLAUDE_PROJECT_DIR}`'s (the main checkout).

### Hard-deletes — breaks §2.1 "Soft-delete everywhere"

**The rule: nothing is ever hard-deleted.** Every entity carries `deletedAt`, deleting sets it, reads
filter tombstones. This isn't fastidiousness. `updatedAt` is **last-write-wins across devices**, so a row
that simply vanishes is indistinguishable from a row that never synced — the tombstone is the only way
one device can tell another that something was deliberately removed rather than lost. Destroy the row and
a stale device silently resurrects it on next write.

**Live violation: `uncheckHabit`.** `BackendClient.uncheckHabit` calls `repo.deleteCheck`, a real
DynamoDB `DeleteItem` — the row is gone. The stub soft-deletes the same row. Every other delete in the
app follows the rule (`deleteCategory` and `removePlan` both write `deletedAt`), so this is the lone
outlier, and two things make it worse than an ordinary bug:

*(Grepping `writes.delete` finds two other hits — a plan's old SK when it moves day, and the running-copy
of a session on stop. Those are **key migrations**: the entity still exists under a different sort key.
`deleteCheck` is the only one that destroys a row. The attachment delete's S3 `DeleteObject` (2026-11-01) isn't an entity delete: the metadata row is the tombstone, and the versioned bucket keeps the bytes 30 days. The place token's lookup rows (`placetoken#<hash>`, 2026-11-04) are deleted for real on rotate and revoke, on purpose: a credential that must stop working, not synced data — a tombstoned lookup row would still be a row a bug could read as valid. The token's pointer is never deleted; revoke writes it inactive ([tasks/places](../areas/tasks/places.md#4-the-shortcut-route)).)*

- **No test can see it.** Both implementations return `[]` from `listHabitChecks` afterwards, and since
  `exportData` now excludes tombstones too, **no `ApiClient` method reveals the difference**. The
  contract suite — the mechanism that exists to keep stub and backend honest — is structurally blind
  here. It will drift further without anything going red.
- **It's the delete most likely to be hit by accident.** Unchecking a habit is a one-tap action on a
  mis-tap, and it's the one delete in the app that destroys data.

Fix: `uncheckHabit` sets `deletedAt` like everything else, `listHabitChecks` filters. The regression test
can't live in the contract suite (see above) — it belongs in `lambdas/`, asserting the raw item still
exists via a direct repo/table read after the delete. That asymmetry is the real lesson: **a contract
test proves two impls agree, not that either is correct.**

**Before adding any delete path**, check it writes `deletedAt` rather than removing the row, and that
something outside the contract suite can tell the difference.
