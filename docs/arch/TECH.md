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
- **Styling:** **Tailwind (v4, CSS-first)** with theme colors as **CSS custom properties** (`--surface`, `--ink`, `--gold`, …; `app/src/styles/tokens.css`) → auto light/dark is a one-line flip. Anti-generic: semantic token layer + a few primitive components, not raw utilities everywhere.
- **Fonts:** Hanken Grotesk, self-hosted via `@fontsource-variable/hanken-grotesk` (no font CDN).
- **On-device vision:** `@mediapipe/tasks-vision` — Flux's face tracking runs in the browser; video never leaves the device ([flux](../areas/flux/index.md)).
- **Testing:** Vitest. **Lint/format:** ESLint + Prettier.
- **Dates:** **roll our own** small helpers (day-start offset + ISO-week cadence are small, targeted) — only reach for a date lib if DST edge cases prove genuinely gnarly. Per [CONVENTIONS.md](../product/CONVENTIONS.md).
- **Charts:** deferred; v1 viz is hand-rolled CSS/SVG.

**Backend / infra (resolved — the blueprint is [INFRA.md](INFRA.md))**

- **Hosting:** S3 (static) + CloudFront (CDN + HTTPS — required for the PWA service worker).
- **Auth:** Cognito (multi-device identity → JWT validated by the API).
- **Compute:** Lambda(s), TS/esbuild.
- **Data:** DynamoDB, on-demand. Logical entities per §2; the physical model (keys / access patterns) is §2.4 — DDB is access-pattern-first, not relational.
- **Cost:** effectively free at single-user scale — breakdown in INFRA §11.

**Resolved (as built):** Lambda Function URL, not API Gateway (INFRA §4) · Cognito (§6) · single-table DDB (§5) · one multi-route BFF Lambda (§4; the others: _Beyond the BFF_, below) · CDK (§3) · custom domain (§8).

**Beyond the BFF** (each in INFRA — §1, §3, §4 or §10 — and its area doc): the MCP Lambda ([mcp](../areas/mcp/index.md)), the push dispatch ([tasks/reminders](../areas/tasks/reminders.md)), the coach worker (the LeetCode coach's AI pick, [recruiting/coach](../areas/recruiting/coach.md)), the finance sync ([finances](../areas/finances/index.md)), the Google gateway (`lambdas/src/google/`, [calendar](../areas/calendar/index.md)), the Files bucket ([tasks/attachments](../areas/tasks/attachments.md)) and the dev account's kill switch (INFRA §3). The RPC boundary — argument shapes checked before any read or write, one failure-status mapping — is INFRA §4.

**Offline stance (v1):** online-first. PWA installs and the shell loads offline, but data reads/writes need connectivity. Offline editing + a sync-on-reconnect write queue is a **later enhancement**, not v1 — bar per-feature crash-safety outboxes since: capture's (`app/src/modules/capture/captureOutbox.ts`), Flux sets' ([flux](../areas/flux/index.md)) and the extension's ([recruiting](../areas/recruiting/index.md)).

**Version discipline:** check the registry (`npm show <pkg> version`) before pinning — the rule lives in `CLAUDE.md`.

---

## 2. Data model

Logical entities below are **storage-agnostic**; the physical DynamoDB shape is §2.4 (single-table, as built).

### 2.1 Global conventions

- **IDs:** client-generated **ULIDs** (unique across devices, time-sortable). Exception: Plaid-owned finance rows (items and their sync states, accounts, transactions) use Plaid's ids — [finances/](../areas/finances/index.md).
- **Ownership:** every item scoped to `userId`.
- **Timestamps:** epoch-ms. `day` / `date` strings are computed with the **configurable day-start offset** (`settings.dayStartHour`, default **4am** — so late-night work lands on the right day).
- **Soft-delete everywhere:** every entity has `createdAt`, `updatedAt`, `deletedAt`. **Never hard-delete**; queries filter out tombstones (dev's table alone expires them: §2.3, rule 4). No live violation since `day-guards` (2026-11) — the last, `uncheckHabit`, is kept as a record under **[Tech debt](#tech-debt)**.
- **`exportData` excludes tombstones.** The "you own your data" snapshot returns live rows only, on both impls, asserted by the export contract test. So a soft-deleted row is **unrecoverable from an export** — deliberate while the export is a one-way download with no import path. If restore/merge ever lands it will need tombstones plus a versioned envelope; revisit then. The bundle's shape is the shared `ExportBundle` type, and every collection is required — omitting one is a compile error, not a silent gap (which is how `leetcodeAttempts` once shipped missing).

### 2.2 Entities

**logEntries** — `id · createdAt · day · text · private?`. Edit allowed; soft-delete allowed. `private` hides an entry's text from every MCP read (the entry, its day and time stay) and keeps it out of MCP search; older rows read back `undefined` = not private ([log](../areas/log/index.md)).

**tasks** — the signature module.

- `id · title · status · categoryId · seriesId? · seriesDay? · rollId? · parentId? · place? · dueDay? · dueTime? · notes? · reflection? · createdAt · startedAt? · completedAt? · cancelledAt?`
- `rollId` (id | null) — set when the task is a **rep** of a [Roll](../areas/home/rolls.md). Required-nullable; readers compare `=== id` / `!rollId` (pre-existing rows read back `undefined`). The contact-sheet momentum is derived from done tasks carrying this — no counter.
- `status`: `backlog | planned | in_progress | done | cancelled`.
- `dueDay` (`YYYY-MM-DD` | null) — **when it's due**, distinct from `taskPlans.day` (_when it gets worked_). Free metadata: set in the scope pass, editable at any status, **never part of the estimate lock**. Design: [areas/tasks/due-dates.md](../areas/tasks/due-dates.md).
- `dueTime` (`HH:MM` 24h local | null) — the deadline's clock time, only with a `dueDay` (clearing the day clears it). Drives the urgency colour and calendar auto-sync (`gcalSyncError` holds a failed sync; `Settings.autoCalendar` is the toggle — [areas/calendar/index.md](../areas/calendar/index.md) → Auto-sync).
- Two-way calendar sync bookkeeping — `gcalSeen` (with Google's `updated`) and `gcalPulled` — is **optional** on `Task` (absent on old rows and literals), an exception to required-nullable: sync state, not task data (the other exception is `estimateSource`, stamped only at done). A Google edit can set `title`, `dueDay`/`dueTime` and `estimateMin` ([areas/calendar/index.md](../areas/calendar/index.md) → Two-way sync).
- `notes` (string | null, ≤ 5,000 chars) — free-form light markdown, editable at any status, **never part of the estimate lock**. Required-nullable; pre-existing rows read back `undefined`, so readers use `!notes`. Design: [areas/tasks/notes.md](../areas/tasks/notes.md).
- `reflection` (string | null, ≤ 1,000 chars) — the look back written at completion, same markdown as notes, editable at any status, **never part of the estimate lock**. Required-nullable; old rows read `undefined` → `!reflection`. Design: [areas/tasks/reflection.md](../areas/tasks/reflection.md).
- **Estimate handling:** `estimateMin` + `bufferMin` (the **working** estimate) are editable at any open status — not `done`/`cancelled`. On the **first transition out of planning** (→ `in_progress` or `done`), `estimateLockedMin` is snapshotted and frozen; a later edit never touches it. **Calibration = `actualAccruedMin` vs `estimateLockedMin`.** Work that turned out bigger is **split** (this part done or kept going + a linked follow-up), never by editing the locked estimate.
- **Done gate** ([areas/calibration/integrity.md](../areas/calibration/integrity.md)): `taskTransition(→ done)` refuses a calibrated task (`isCalibrated`: not an errand) without `estimateMin ≥ 1` and `actualAccruedMin ≥ 1`, and a parent bypasses it (`completeParent`). Done also sets `estimateLockedMin` from `estimateMin` when there's no baseline (null or 0), and `estimateSource` (`planned | revised | retro | null`, optional on `Task` like the sync bookkeeping: older rows, parents and errands have none). The one write into a finished estimate: `withEstimate` on a done calibrated task with no lock, once.
- `parentId` (string | null) — the task this one is a part of (2026-10-08; replaced `splitFromId`, whose stored attribute is inert on old rows). One level; parenthood is derived, never stored. A parent holds the deadline and never takes plans, sessions or its own estimate; its `estimateLockedMin` freezes when its first part starts (the one lock that's ever cleared: a parent whose last part goes is plain again, and its lock goes with them), and its `actualAccruedMin` is stamped with Σ done parts when it's marked done (refused while a part is open). Every part, and a done parent, is a calibration point. A parent's one calendar event is its due marker; a part's block is named after it (v2a). Required-nullable; old rows read `undefined` → `!parentId`. Design: [areas/tasks/parts.md](../areas/tasks/parts.md).
- `actualAccruedMin` — **denormalized**, bumped when a _work_ session closes onto an open task (excludes breaks + paused time; a session stopped onto a `done`/`cancelled` task keeps its minutes in history and adds none — shared `accruesTime`). Avoids scanning sessions.
- `place` (slug | null) — the errand list the task is on; a slug edit rewrites its tasks. Required-nullable; old rows read `undefined` → `!place`.
- `cancelled` tasks are excluded from calibration, and so are errands (a task with a `place`, [tasks/places](../areas/tasks/places.md)).
- **Drop vs Delete are different.** Drop = `transitionTask(→cancelled)`, which keeps the row as history (excluded from calibration). Delete = `deleteTask`, a **permanent** action that tombstones the task **and cascades** — its plan rows and attachment metadata are tombstoned too, and any calendar event is hard-deleted via the [cancel path](../areas/calendar/index.md#flows); each attachment's S3 bytes are deleted first ([attachments D7](../areas/tasks/attachments.md)). Delete is hidden on a recurring occurrence (`seriesId != null`) — `getDay` would just respawn it; Drop, or `deactivateSeries` for the whole series, is the tool there.

**taskPlans** — scheduling (the _when_), separate from the task (the _what_). Enables multi-day + ordering.

- `id · taskId · day · plannedMinutes · order`. One alive row per (task, day): an id-less `upsertPlan` for a task already on that day returns it (`day-guards`, 2026-11). A task may have plan rows on several days. A **timed** task (`dueDay` + `dueTime`) has none: its day is its time, and `upsertPlan` refuses it ([lenses.md](../areas/tasks/lenses.md) D13). Morning "planned hours" for a day = Σ `plannedMinutes` on that day. "Remaining" = `estimateMin − actualAccruedMin` (the working estimate).
- **Stale sweep (lazy rollover).** `getDay(today)` moves every `planned` task with no alive plan row on today or later back to `backlog`, and every timed `planned` task whatever its rows — a recurring untimed occurrence already superseded by its series' copy today is dropped (`cancelled`) instead. Plan rows stay as history; `in_progress` is untouched. Rule: shared `stalePlannedMoves`, fed one consistent range read of the plan rows dated today or later (`listPlansFrom` — `SK BETWEEN plan#<today># AND plan#\uffff`; rows before today never decide a move, and plan history only grows — `day-guards`, 2026-11). It runs on app open, not on a schedule (the server has no timezone), so MCP reads lag until the app loads today. `getDay` refuses a day after the user's app day (`FUTURE_DAY_ERROR` → HTTP 400, both impls; a malformed key is `Invalid day`), since a future day would sweep today's plan; past days are allowed (`day-guards`, 2026-11).

**taskSeries** — recurrence template ([areas/tasks/recurring.md](../areas/tasks/recurring.md)).

- `id · title · categoryId · defaultEstimateMin · rule · active · anchorDate · dueOffsetDays? · until?`. `dueOffsetDays` is the cadence: an occurrence spawns planned on its day, due that many days later, untimed (`null` = no due date). `until` is the last day it spawns (inclusive); past it the row stays `active` and reads "ended". Both read back `undefined` on older rows → `?? null`.
- `rule` (**simple** for v1): `{ kind: daily | weekdays | weekly | everyN, interval?, daysOfWeek?[] }`. Full RRULE (nth-weekday-of-month, exceptions) is deferred.
- Each occurrence is a real **task** instance with `seriesId` → its own estimate/actual → **its own calibration point**, stamped `seriesDay` (the day it was spawned for). `getDay` spawns once per `(seriesId, seriesDay)` — shared `seriesHasOccurrence` — so an unplanned occurrence is never respawned (recurring.md §4). Editing one occurrence doesn't touch siblings; editing the series affects future occurrences. `deleteSeries` tombstones the template (API only, the dev check's cleanup); `deactivateSeries` is the user's Stop.

**ideas** — `id · text · createdAt · status(open | triaged | discarded)`.

**habits** — `id · name · categoryId · cadencePerWeek · active`. (Recurring _behaviors_, binary, no estimate — distinct from recurring tasks.)
**habitChecks** — `id · habitId · date`. Compound uniqueness on `(habitId, date)`.

**rolls** — `id · name · categoryId · estimateMin · active`. Deadline-free ongoing _efforts_ (LeetCode daily, study). A "rep" is a done **task** with `rollId` — momentum is **derived** from those (no stored counter, no streak). Picking one for a day creates a planned rep on that day's plan (`pickRollToday`, reuses an open rep). Distinct from habits (a timed task vs a binary check). Design: [areas/home/rolls.md](../areas/home/rolls.md).

**pomodoroSessions**

- `id · taskId? · categoryId · label? · wasWork · kind · startedAt · endedAt? · day · activeMinutes · status · lastHeartbeatAt · blocks?`
- `label`: a taskless timer's focus name — how concurrent timers are told apart. `blocks`: the blocks the timer runs to, raised by Again; absent = 1.
- `kind`: `work | break` — **only `work` accrues** to `task.actualAccruedMin` + time-budget.
- `wasWork`: **snapshot** of the category's `isWork` at write time → immutable balance history.
- `categoryId`: **follows the task** when `taskId` is set; manual only for taskless freeform focus.
- **Pauses supported** — `activeMinutes` accumulates only un-paused time; paused time never counts.
- `status`: `running | completed | discarded`. Running sessions are persisted with a **heartbeat** (`lastHeartbeatAt`); on next open, a stale running session prompts **keep (capped at last heartbeat) / discard** — no orphans. A stop carries `capMin`, the most its final beat may still credit (shared `completeSession`): the client sends what's left to the block's target for a timer on "done" (the wait before Stop isn't work; a block that ended behind a locked phone keeps its last stretch) and 0 for a paused one; omitted (older JS) = uncapped. The live count-up and the Actual prefill hold at the target on "done" too (`workedSec`). Again is `extendSession`: the same cap, the clock restarts, and the session's `blocks` rises, so a reload or another device keeps the new target. `mustSession` reads the running row consistently, so a stop right after a pause's beat sees it.

**days** — per-day singleton: `date(pk) · capacityHours · intent · reflectionPrompt · reflectionText`.

**categories** — `id · label · isWork · order · active · area`.

- **`area`** — the life area the category belongs to: `school | aperture | recruiting | personal | null` (a fixed set, `shared/src/areas.ts`); `null` and a row from before the field both list as `null` and read as Personal. Set in Settings (Area…) or MCP; patch-style on update, so a rename or retire keeps it. A live grouping — never snapshotted — so changing it regroups history. The Backlog folds the Aperture area away; Home's "+ Add" counts the rest. Design: [areas/tasks/areas.md](../areas/tasks/areas.md).
- **Retire** = `active: false` (Settings → Retire…, or MCP `update_category`): hidden from every picker, sorted after active ones in Settings, but the label still resolves on existing tasks and an edit form shows the item's own retired category as "X (retired)". On update `order`/`active` are patch-style — omitted keeps the current value, so a rename never un-retires.
- Referenced by **id**. **Labels resolve live** (renames propagate to display). **`isWork` is snapshotted** onto sessions (`wasWork`) so history is frozen. Flipping `isWork` offers an **optional retroactive backfill** ("also reclassify past focus sessions?", then reports how many changed). **Deleting** a category that tasks, habits, series or rolls still use requires a reassignment target first, then soft-deletes the empty one; focus sessions keep the old id (their `wasWork` is already a snapshot).

**sittings** — one go at one LeetCode problem, written by the browser extension through the ingest methods; the model, its folds and its caps live in [recruiting](../areas/recruiting/index.md) → _Sittings_ (`packages/shared/src/sittings.ts`).

**leetcodeAttempts** — **read-only history**: no writer since PR D (2026-11) removed `recordLeetcodeAttempt`; read again since coach-fixes, by the coach's fold as legacy attempts ([coach.md](../areas/recruiting/coach.md) → _Legacy history_), and exported (`legacyLeetcodeAttempts`). No migration, no delete, no put in `repo.ts`; SK prefix `lc#` (`keys.ts`). As written: one row per LeetCode submission, accepted **and** wrong, by the v1 browser extension (device token), never by the app.

- `id · day · problemSlug · problemTitle · verdict · submittedAt · lang · runtimeMs? · memory? · leetcodeSubmissionId · frontendId? · difficulty? · topicTags?`
- `verdict`: `accepted | wrong_answer | time_limit | runtime_error | compile_error | memory_limit | other`, normalized server-side from LeetCode's raw `status_code`/`status_msg` (`normalizeVerdict`, which the sittings still use).
- `day` was bucketed server-side from `submittedAt` + the client's reported tz offset + `dayStartHour` (`dayKeyForOffset`, likewise still used).
- Writes were idempotent on `leetcodeSubmissionId` (a re-fire returned the existing row, original verdict intact); attempt counts were derived at read time, never stored.

**stories** — behavioral-interview STAR stories, authored in-app (the one place structured-at-entry is right — a story is a slowly-tightened artifact, not a capture).

- `id · title · competencyTags[] · situation · action · result`
- `competencyTags`: the fixed `CompetencyTag` union (`leadership · conflict · ownership · failure · ambiguity · impact`), a shared constant — not the editable `Category` entity. Multi-select.
- Title required; S/A/R may be empty (a title-only stub is valid). List is `updatedAt`-desc; soft-delete like everything else. Full design: **[recruiting/story-bank.md](../areas/recruiting/story-bank.md)**.

**attachments** — files on a task (receipt, spec, screenshot); the first entity whose payload is **bytes**, not JSON.

- `id · taskId · filename · contentType · size · s3Key · status(pending|ready)` — metadata only; the bytes live in a separate **precious S3 bucket** at `u/<userId>/<taskId>/<id>`, never in DynamoDB.
- Bytes move browser↔S3 directly via **presigned URLs** the Lambda signs but never carries — the JSON RPC edge stays binary-free. `pending` until the browser confirms the PUT; only `ready` rows list/export. Delete removes the object (the versioned bucket keeps it 30 days), then tombstones the metadata. Full design: **[tasks/attachments.md](../areas/tasks/attachments.md)**.

**finance** — Plaid-synced bank data: `financeItems` (a bank login), `financeSyncStates` (per item: cursor, lock, request/refresh stamps), `financeAccounts`, `financeTransactions`, `financeRules` (ULID ids). Transaction fields are Plaid-owned (amount, date, merchant…) except the **user-owned** ones a sync never overwrites: `bucket · bucketSetBy · periodOverride · note · refundOfId · startsPeriod`. Design: [finances/](../areas/finances/index.md).

**places** — `id · name · slug · lastReadAt`. A store you run errands at; tasks reference it by `slug` (the word in `@slug`, the Shortcut's URL, the lens link). No address — the geofence lives in the iPhone's Shortcuts automation. `lastReadAt` is the last Shortcut read, the setup's heartbeat. The place token is a credential: never exported (§2.4). Design: [tasks/places](../areas/tasks/places.md).

**pushSubs** — `id · endpoint · p256dh · auth · label · lastOkAt · lastError · lastErrorAt`. One device's Web Push subscription; `id` is a `sha256(endpoint)` prefix, so re-subscribing upserts. A credential: never exported or returned. Design: [tasks/reminders](../areas/tasks/reminders.md).

**fluxSets** — one finished Flux set: `id · day · exerciseId · kind · side · condition · count · avgPeakDeg · avgErrorDeg · rom · calibrated · delegate · durationSec · completedAt · repTaskId · stoppedEarly · planned`. The client mints the ULID (idempotent put); `repTaskId` is the Roll rep it counted toward. **The week note** — one cached line per week (`weekStart · text` ≤ 140 chars `· generatedAt`, plus the server's `fingerprint` cache key), written by Haiku from that week's sets, or the deterministic line when it can't be, rebuilt when they change; derived, not exported. Design: [flux](../areas/flux/index.md).

**gcalSyncStates** — the two-way calendar cursor, one per connected Google account (`id = sub`): `calendarId · syncToken · lastPulledAt · lastSyncedAt · lastPullError · lastPullErrorAt`. Exported, no credentials; a null token means a full resync ([calendar](../areas/calendar/index.md) → Two-way sync).

**settings** — singleton: `dayStartHour` (default 4), pomodoro work/break durations, theme override, `financeBudgetCents` and `financePaymentDay` (defaults in `finance.ts`), the reminder toggles `remindTimed` / `remindDueDay` / `remindPlanned` (default on), etc. Also the calendar wiring — `googleAccounts` (up to two, `sub · email`; `sub` is the key and the refresh token lives in SSM under it; written server-side only, never client-patched), `calendarShapeRefs`, `calendarWriteDefault`, `autoCalendar`, the waking window `dayFocusStart` / `dayEndHour` — and the Roll links `fluxRollId` / `leetcodeRollId`, and `leetcodePremium` (default on: the LeetCode coach may pick Premium problems), `coachPlanMode` (default `auto`: the coach's slot mix).

### 2.3 Rules distilled (from the poke-holes pass)

1. The calibration baseline (`estimateLockedMin`) freezes on first exit from planning; calibration uses the frozen value; the working estimate stays editable until done/cancelled; bigger-than-thought ⇒ split (split.ts). No calibrated task reaches done without an estimate and an actual of at least 1 minute (machines.ts).
2. Categories: id-referenced, live labels, snapshotted `isWork`, reassign-on-delete, opt-in backfill on flip.
3. Sessions: heartbeat-persisted, `work|break`, pauses excluded, category follows task, orphan ⇒ keep/discard.
4. Never hard-delete — `deletedAt` tombstones everywhere. Both tables have TTL on `expiresAt`, and `toEntity` strips it:
   - **Dev expires tombstones:** `liveWrites` stamps `expiresAt` when `STAGE` is `dev` (`lambdas/src/ddb/writes.ts`; due at deletion, flux a week later, finance and a removed push device never; AWS deletes some time after a row is due).
   - **Prod's one exception (2026-11, lc-redesign):** a LeetCode sitting's raw bulk — snapshot and submit-detail events, replay chunks — is stamped at write to expire 14 days past the sitting's 24 h ingest window (`sittingRawExpiresAt`). What a sitting keeps forever (head, live row with the final code and facts, every run and submit) is never stamped; prod tombstones aren't stamped either — a deleted raw row just keeps the `expiresAt` it had. [recruiting](../areas/recruiting/index.md) → _Storage_.
5. ULIDs, `userId` on everything, `updatedAt` for last-write-wins across devices.
6. Day buckets use the configurable `dayStartHour` (default 4am).

### 2.4 Physical model — DynamoDB single-table (as built; `lambdas/src/ddb/keys.ts`)

```
PK = u#<userId>            (one partition per user — fine at single-user volume)
SK (type-prefixed range keys):
  log#<day>#<ulid>              day's log entries          (begins_with log#<day>)
                                across days for the MCP log tools (BETWEEN log#<from>#..log#<to>#\uffff)
  task#<ulid>                   task by id
  (any tombstone on dev; a sitting's raw bulk on both)  expiresAt: DynamoDB TTL attribute, epoch seconds (§2.3 rule 4)
  plan#<day>#<order>#<ulid>     day's planned tasks, sorted (begins_with plan#<day>)
  sess#<day>#<ulid>             sessions for a day / week range
  sess#running#<ulid>           running timers (direct get for the heartbeat; moved to the day bucket on stop)
  lc#<day>#<ulid>               legacy LeetCode attempts — no writer since PR D (2026-11); read by the coach (coach-fixes)
  lcsit#<id>                    LeetCode sitting head (id = the Start's clientSittingId; put-if-absent)
  lcs#<id>#live                 a sitting's live row: newest code, snapshot version, replay facts
  lcs#<id>#budget               a sitting's capture budget (reserved before every events write; internal)
  lcs#<id>#reads                Claude's live pulls of a sitting — a counter bumped by UpdateItem ADD (Writes.add), the one
                                write that isn't a whole-item put: beside the head, which refolds rewrite whole
  lcs#<id>#hd#<ulid>            a sitting's head rows: a run's/submit's/note's/timer read's compact verdict (the summary's source)
  lcs#<id>#jd#<ulid>            a run's, submit's or note's full payload (kept forever)
  lcs#<id>#ev#<ulid>            a sitting's raw bulk events: snapshots, submit details (expiresAt)
  lcs#<id>#rp#<ulid>            a sitting's replay chunks, raw (expiresAt)
  lcq#<slug>                    LeetCode's questionDetail for a problem, raw, one per slug
  lcstart                       the user's LeetCode Start gate: attempts/Starts a day, the open sitting it let through
  flux#<day>#<ulid>             Flux sets, day-bucketed; the client mints the ulid (idempotent put-if-absent; soft-delete tombstones)
  fluxnote#<weekStart>          Flux's weekly note cache (direct get, consistent): {text, fingerprint, generatedAt} — derived from the sets, rebuilt when they change, so no userId/ulid/updatedAt
  hcheck#<date>#<habitId>       habit checks (also enforces one-per-day)
  day#<date>                    day singleton (direct get)
  attach#<taskId>#<ulid>        a task's attachments        (begins_with attach#<taskId>)
  habit#<id> · roll#<id> · cat#<id> · idea#<ulid> · series#<id> · story#<ulid> · settings
  fin#item#<id> · fin#sync#<itemId> · fin#acct#<id> · fin#txn#<id> · fin#rule#<ulid>   finances
  gcal#sync#<sub>               calendar two-way sync cursor, one per Google account
  place#<id> · ptoken           errand places; the place token's pointer {hash|null, createdAt, hint, retiring[], updatedAt}
  stoken#<ulid>                 a scoped device token (capture): name, hint, hash, the day's counters and the
                                duplicate guard — the authority; no userId attribute, like ptoken (a credential,
                                never exported or returned; tasks/capture.md §3)
  pushsub#<sha256(endpoint) prefix>  a device's Web Push subscription (a credential: never exported or returned;
                                a user's Remove tombstones it keyless, a push-service 404/410 deletes it)
  psent#<fireAt 13d>#<key> · pcount#<LA day> · ptest#<ulid> · pushhealth · pusharm
                                the reminder poller's dedup rows (swept after 48 h), daily guard counter,
                                Send-test candidates, this user's last send / error, and when each reminder
                                toggle was last switched back on (tasks/reminders.md)
  (task# / plan# rows on the remind index also carry remindArmedAt — table-only, never on the entity: when
  their current fire time was set, for the armed-before-it-fires rule)
PK = placetoken#<sha256hex> / SK = placetoken
                                the place token's lookup row {userId, …}: the Shortcut route resolves a user
                                from a token (tasks/places.md §4)
PK = stoken#<sha256hex> / SK = stoken
                                a scoped token's lookup row {userId, tokenId, scope}: the capture route resolves
                                a user from a token (tasks/capture.md §3)
PK = push / SK = user#<userId> · health
                                the reminder poller's registry (who has a device) and its stage-wide
                                heartbeat — derived, never client-set, never exported (tasks/reminders.md)
```

- **Three non-`u#` partitions:** `placetoken#<hash>`, `stoken#<hash>` and `push`. Everything else is under the user's.
- **One GSI, three key spaces:** calibration — done tasks by completion date (`GSI1PK = u#<userId>#done`, `GSI1SK = <completedAt>`); finance — transactions by date (`GSI1PK = u#<userId>#fintxn`, `GSI1SK` = the date's UTC-midnight epoch ms); reminders — what may ping, by when (`GSI1PK = u#<userId>#remind`, `GSI1SK` = fire time epoch ms) on open dated tasks, plans and Send-test rows, set atomically with the item's own write.
- **Attachment bytes are NOT in this table** — only the metadata item above. Bytes live in the precious S3 Files bucket (INFRA §3), reached via presigned URLs.
- **Denormalized** `task.actualAccruedMin` → no session-scan for "remaining".
- **Balance / time-budget aggregate in the Lambda** over the day/week range (no GSI needed at this volume).
- Access patterns as built: the keys above satisfy them with prefix reads + the one GSI's three key spaces.

---

## 3. Routing & state

**Routes (React Router):**

- `/` — the glanceable **home** (auto morning/day/night by clock, manual override). The hub; ≤5 things per mode.
- `/log · /tasks · /recruiting (+ /recruiting/sittings/:id, /recruiting/patterns, /recruiting/progress (+ /:slug), /recruiting/stories) · /finances (+ /finances/all, /finances/rules) · /habits · /rolls · /flux (+ /flux/:exerciseId, /flux/history) · /inbox · /settings` — the **deep views** (full backlog, browse past log days, LeetCode sittings, the coach's patterns + the story bank, the budget's sort queue + ledger + rules, manage habits, manage rolls + their contact sheets, guided neck exercises on the camera, triage ideas, edit categories / durations / theme / export). **Home = glance, deep views = work.**
- **Pomodoro is not a route** — a persistent element; the running (heartbeat-backed) timer follows you across views.
- **Capture bar is global** — always present, not a route (hidden on a Flux exercise view, `/flux/:exerciseId`, through the route's `handle.hideCapture`).

**State — three layers:**

- **Server/data → React Query.** One query per access pattern. Task writes are **written through**: what a write returns goes straight into the one tasks list (`app/src/data/taskCache.ts`), newer `updatedAt` wins, and the app remembers its own writes for 60 s so the BFF's eventually consistent `listTasks` (not retried) never undoes one; the invalidate still runs for rows a write changes without returning (a parent's lock, plan rows, the day's sweep). The backlog derives from that list. On the BFF, every read whose copy is written back is strongly consistent — tasks (`mustTask` and kin), plan rows, the day row, categories, settings, stories, habits and their checks, log entries, series, rolls, ideas, attachments, the calendar sync cursor — so two quick RPCs on one row never lose the first; display reads (`listTasks`, `listPlans`, `getSettings` on load) stay eventual; sessions read consistently too (`mustSession`: heartbeat, resume and stop write back what they read).
- **UI/session → React Context.** Current home mode, running timer, capture-bar state.
- **Auth → Cognito session** in a context provider. Frontend lib: **`react-oidc-context` + Cognito Hosted UI** (PKCE auth-code grant, no client secret).

**Session persistence.** Tokens live in **`localStorage`**, not oidc-client-ts's `sessionStorage` default — `sessionStorage` dies with the browsing context, and the OS reclaims a standalone PWA's process routinely, which discarded a still-valid refresh token and forced a Hosted-UI sign-in roughly daily. The refresh token is what carries the session across relaunches: with one present, `signinSilent` renews against the token endpoint and never touches an iframe or the Hosted UI (whose own session cookie is fixed at 1 hour and isn't renewed by a token refresh). `refreshTokenValidity` is **30 days** on the app client (Cognito's default, max 3650). It was **7 days** until 2026-11, because the token sits in `localStorage`, so a leaked one should have a short life. That still holds, and the trade is now explicit: a refresh token stolen from the browser stays usable for up to 30 days instead of 7, in exchange for a sign-in about monthly on the phone PWA and the dev Simulator instead of weekly. The recovery for a leak is `aws cognito-idp admin-user-global-sign-out`: the refresh token gets no new tokens from then on, but the access token already issued still passes the BFF's local JWT check (signature, issuer, expiry) until its hour is up. Token revocation is pinned on in the template rather than left to Cognito's default. Inferred, not verified (the token is opaque): a token keeps the validity it was issued with, so sessions from before a change run out on the old clock. Rotation (each refresh reissues the refresh token) isn't on: it never extends a session's window, needs the Essentials/Plus feature plan, and a response lost after a rotation would sign the user out. Access/ID tokens stay at the 1-hour default.

We build the `UserManager` ourselves (`app/src/auth/userManager.ts`) instead of letting `react-oidc-context` construct one from props, because the context wraps every navigator method to swallow rejections into `null` — which hides whether a failed renew was the network or the authority rejecting the grant.

**How renewal decides.** One rule shapes the rest: **wakeups retry a renewal the session already owes; they never start one.** A renew is owed only when the library says the token expired, when a silent renew errored, or when the BFF returns 401 — so `online` and `visibilitychange` are pure retries, and coming back to the app on a fresh token costs zero token requests. `userLoaded` and `userUnloaded` are the only points that reset the state, because the library raises them whoever did the work (us, `SilentRenewService`, or the redirect callback); resetting inside our own success path instead left the UI one expiry away from dropping the whole tree. Renewal clears the session **only** on `invalid_grant` — a network failure never discards the refresh token, it backs off (~30s over five attempts) and stays owed. After that the sign-in button appears: a render-only escape so an offline relaunch can't hang on the loading screen, with the stored token left intact. Retrying continues quietly behind that button every 60s — the `online`/`visibilitychange` listeners only catch failures the browser announces, and a Cognito 5xx, a captive portal or a DNS failure never flips `navigator.onLine`. A session that ends this way is expected rather than broken, so the underlying `invalid_grant` isn't surfaced as an error; asking for a sign-in clears that suppression, since from then on the user is acting and deserves to see what happens. On relaunch the renew is also asked for up front rather than waiting on the expiry timer — but never during the OAuth redirect callback, where it would race the code exchange on the old stored user. A 401 from the BFF routes into the same path via `tokenStore` and invalidates queries on success so panels that failed mid-401 recover; it is capped at **two renewals**, charged only when one actually starts, so a burst of concurrent 401s can't spend the budget without doing work. Uncapped, a 401 that _isn't_ about the token (audience or issuer mismatch, clock skew) loops against the BFF and Cognito at network speed.

This machine is unit-tested against an injected fake `UserManager` in `app/src/auth/renewal.test.tsx`. `OidcBridge` takes the manager as a prop precisely so http-mode auth is reachable under vitest, where `API_MODE` is `stub` and `AuthProvider` would otherwise always take the bypass path — that blind spot is where every regression in this logic landed.

---

## 4. Folder structure & tooling

pnpm workspaces monorepo.

```
aperture/
  app/                 # React PWA (Vite)
    src/
      pages/           # Home, Log, Tasks, Recruiting, Habits, Rolls, Finances, Flux, Inbox, Settings (a dir each)
      modules/         # calendar, calibration, capture, finances, flux, habits, home, log, pomodoro, push,
                       #   reflection, rolls, tasks
      components/      # primitives: Card, Text, … (anti-generic token layer)
      data/            # React Query hooks + the api clients (stubClient, httpClient) + seed
      lib/             # cx, format, useDisclosure, useRowAction (ulid/dates live in packages/shared)
      auth/            # Cognito/OIDC glue (userManager, OidcBridge, AuthProvider)
      styles/          # tokens.css (the CSS-var theme) + theme.ts
      shared/ · test/  # env.ts (the one Vite env reader) · the jsdom setup + test utils
  lambdas/src/         # BFF — index.ts, handler.ts, backend.ts, sessions.ts (pomodoro sessions); auth/ (verify),
                       #   rpc/ (argSpecs, shape, failure), ddb/ (keys, repo, writes, mapping, DocClient),
                       #   anthropic/ (the gated Claude gateway + prompts), coach/ (the AI pick's worker core),
                       #   google/, plaid/, s3/, mcp/,
                       #   push/ (service.ts: reminder devices + Send test; the poller's sender) + pushDispatch.ts,
                       #   finance/ + financeSync.ts (the sync Lambda), coachWorker.ts (the coach's AI pick), kill/ (the dev account's kill switch),
                       #   local/ (the devcheck:local server, LOCAL-CHECK), util/
  cdk/src/             # CDK app — bin/aperture.ts, lib/ (data, app, cicd, billing, org, dev-guard stacks;
                       #   monitoring, finance-sync, push-dispatch, coach-worker constructs), config/
  extension/           # MV3 web extension (Safari) — LeetCode sittings. No runtime deps,
                       #   bundler or build step; a workspace member for its tests only (vitest, jsdom)
  packages/shared/     # shared TS types + contract across app + lambda (also ulid, dates, machines, contractTests)
  scripts/             # dev + CI utilities
  tools/               # user-side clients run on the Mac (raycast/ quick-add, mailroom/ runner) and the COI
                       #   container's tmux setup (coi/) — not a pnpm workspace member
  docs/  ·  localNotes/
```

**Tooling:** pnpm (workspaces) · Vitest · Vite · TS project refs · ESLint + Prettier · esbuild-via-CDK for Lambda bundling · GitHub Actions CI. The rules (pnpm-only, one runner with Node parity, packages resolve from source + the `dist/`/TS6310 note, command shape, dependency discipline) are in **[CONVENTIONS.md](../product/CONVENTIONS.md)**; the toolchain pins as built and the version-pin gotchas are in **[V1_PLAN.md](../V1_PLAN.md) → Phase 0 (as built)**.

---

## 5. The AI seam (gated, server-side)

AI period reflection (week / month / year) isn't built — just a clean boundary so it's additive later. Three model calls are built, all Claude Haiku through the one gateway: quick add's parse ([tasks/quick-add](../areas/tasks/quick-add.md), 2026-10-12), which set the pattern; Flux's weekly note ([flux](../areas/flux/index.md) D62); and the sitting review draft ([recruiting](../areas/recruiting/index.md) → _Review and the Claude draft_). The task editor's category suggestion is not a model call — local naive Bayes over the user's own tasks (`packages/shared/src/categorySuggest.ts`).

- **Server-side only:** the Lambda calls the model; never from the browser. This is why sending journal text out is a Lambda concern. The call is a **gated gateway** (`lambdas/src/anthropic/`): noop under testMode/smoke, a fake in tests, live fetch + the SSM key (INFRA §10) only in the Lambda entrypoints.
- **The 2026-10-09 carve-out is closed (2026-10-12):** the Raycast quick-add (`tools/raycast/`) used to call Haiku from the Mac with the user's own key in Keychain; a second client (the app's capture bar) wanted parsing, so the parse moved behind `parseTask` / the `parse_task` MCP tool and the Mac holds no model key ([areas/mcp → Raycast](../areas/mcp/index.md)).
- **Substrate already exists:** reflection reads `logEntries` / `tasks` / `pomodoroSessions` over a date range — existing access patterns. **No schema change** needed for basic reflection.
- **Reserved entity** (not built): `reflections` — `id · periodType(week|month|year) · periodKey · generatedAt · promptVersion · content`.
- **Model:** Claude (Anthropic API), latest at build time, per repo norms — pinned per prompt module (its `*_MODEL` constant).

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

### Hard-deletes — RESOLVED 2026-11-05 (`day-guards`)

Kept as a record. **Fix:** `uncheckHabit` writes a tombstone at the same key (`putCheck` with `deletedAt`) and `repo.deleteCheck` is gone; a re-check writes a fresh row (new id) over it, as the stub does. The proof lives in `lambdas/` as the record below said it must: `backend.test.ts` "uncheck keeps the row as a tombstone…" reads the raw item after the uncheck. `listChecks` also became one date-bounded range read. The text below is as written when the violation was live.

**The rule: nothing is ever hard-deleted** (prod; dev's disposable table expires its tombstones, §2.3 rule 4). Every entity carries `deletedAt`, deleting sets it, reads
filter tombstones. This isn't fastidiousness. `updatedAt` is **last-write-wins across devices**, so a row
that simply vanishes is indistinguishable from a row that never synced — the tombstone is the only way
one device can tell another that something was deliberately removed rather than lost. Destroy the row and
a stale device silently resurrects it on next write.

**Live violation (then): `uncheckHabit`.** `BackendClient.uncheckHabit` called `repo.deleteCheck`, a real
DynamoDB `DeleteItem` — the row is gone. The stub soft-deletes the same row. Every other delete in the
app follows the rule (`deleteCategory` and `removePlan` both write `deletedAt`), so this is the lone
outlier, and two things make it worse than an ordinary bug:

_(Grepping `writes.delete` finds two other hits — a plan's old SK when it moves day or order (put first, then delete; a plan read keeps one row per id within what it reads, the newest, so no read misses it and a failed write never loses it), and the running-copy
of a session on stop. Those are **key migrations**: the entity still exists under a different sort key.
`deleteCheck` was the only one that destroyed a row. The reminder dispatcher's bookkeeping rows (test, sent and count), a dead device's push subscription, and the poller's per-user registry row once a user has no device left are deleted for real too, on purpose ([tasks/reminders](../areas/tasks/reminders.md)). The attachment delete's S3 `DeleteObject` (2026-11-01) isn't an entity delete: the metadata row is the tombstone, and the versioned bucket keeps the bytes 30 days. The place token's lookup rows (`placetoken#<hash>`, 2026-11-04) are deleted for real on rotate and revoke, on purpose: a credential that must stop working, not synced data — a tombstoned lookup row would still be a row a bug could read as valid. The token's pointer is never deleted; revoke writes it inactive ([tasks/places](../areas/tasks/places.md#4-the-shortcut-route)). A scoped token's two rows (`stoken#<hash>` and `u#…/stoken#<id>`, 2026-11-16) are deleted for real on revoke for the same reason ([tasks/capture](../areas/tasks/capture.md#3-token)).)_

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
