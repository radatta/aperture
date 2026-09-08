# Aperture — Technical Spec

Implements `PRODUCT.md`. AWS-native PWA, web-first, online-first. Solo build, single user.
Status: **Specs complete; implementation underway — workspace foundation (V1_PLAN Phase 0) built 2026-08-03.**
Started: 2026-08-02.

> Product is the source of truth. If this doc and `PRODUCT.md` disagree, product wins.

---

## 1. Stack & architecture

**AWS-native serverless BFF.** Multi-device sync is structural, not built: DynamoDB is the shared source of truth, so laptop + phone just hit the same API.

```
React PWA (S3 + CloudFront) --Cognito JWT--> API (API GW HTTP API | Lambda Function URLs) --> Lambda(s) --> DynamoDB (SoR)
```

**Frontend**
- **Framework:** Vite + React + TypeScript.
- **PWA:** `vite-plugin-pwa` — manifest, service worker, installable. App shell caches for offline load; **data is online-first** (see below).
- **Client data:** **React Query** — fetch/cache/mutate against the Lambda API. (Dexie/local-first dropped in the AWS pivot; may return later only as an offline cache.)
- **Routing:** React Router. **UI/session state:** React Context + hooks (home mode, running timer).
- **Styling:** **Tailwind (v4, CSS-first)** with theme colors as **CSS custom properties** (`--surface`, `--fg`, `--accent-gold`, …) → auto light/dark is a one-line flip. Anti-generic: semantic token layer + a few primitive components, not raw utilities everywhere.
- **Testing:** Vitest. **Lint/format:** ESLint + Prettier.
- **Dates:** **roll our own** small helpers (day-start offset + ISO-week cadence are small, targeted) — only reach for a date lib if DST edge cases prove genuinely gnarly. Per [CONVENTIONS.md](CONVENTIONS.md).
- **Charts:** deferred; v1 viz is hand-rolled CSS/SVG.

**Backend / infra (direction set; details deferred to the infra discussion)**
- **Hosting:** S3 (static) + CloudFront (CDN + HTTPS — required for the PWA service worker).
- **Auth:** Cognito (multi-device identity → JWT validated by the API).
- **Compute:** Lambda(s), TS/esbuild.
- **Data:** DynamoDB, on-demand. Logical entities per §2 unchanged; **physical model (keys / access patterns) is an infra-pass task** — DDB is access-pattern-first, not relational.
- **Cost:** effectively free at single-user scale — S3/CloudFront in cents, DDB/Lambda/Cognito within always-free tiers. Lambda Function URLs avoid even API Gateway's post-free-tier cost if desired.

**Deferred to the infra talk:** API Gateway HTTP API vs Lambda Function URLs · Cognito setup · single-table vs multi-table DDB · one multi-route Lambda vs several · IaC (CDK likely) · custom domain.

**Offline stance (v1):** online-first. PWA installs and the shell loads offline, but data reads/writes need connectivity. Offline editing + a sync-on-reconnect write queue is a **later enhancement**, not v1.

**Version discipline:** `npm show <pkg> version` before pinning anything — never guess versions.

---

## 2. Data model

Logical entities below are **storage-agnostic**; the physical DynamoDB shape is §2.4 (single-table, direction set, refined in the infra talk).

### 2.1 Global conventions
- **IDs:** client-generated **ULIDs** (unique across devices, time-sortable).
- **Ownership:** every item scoped to `userId`.
- **Timestamps:** epoch-ms. `day` / `date` strings are computed with the **configurable day-start offset** (`settings.dayStartHour`, default **4am** — so late-night work lands on the right day).
- **Soft-delete everywhere:** every entity has `createdAt`, `updatedAt`, `deletedAt`. **Never hard-delete**; queries filter out tombstones.

### 2.2 Entities

**logEntries** — `id · createdAt · day · text`. Edit allowed; soft-delete allowed.

**tasks** — the signature module.
- `id · title · status · categoryId · seriesId? · createdAt · startedAt? · completedAt? · cancelledAt?`
- `status`: `backlog | planned | in_progress | done | cancelled`.
- **Estimate handling:** `estimateMin` + `bufferMin` are editable while `status ∈ {backlog, planned}`. On the **first transition out of planning** (→ `in_progress` or `done`), `estimateLockedMin` is snapshotted and frozen. **Calibration = `actualAccruedMin` vs `estimateLockedMin`.** Scope changes are handled by **splitting** (finish/cancel + spawn a follow-up), never by editing the locked estimate.
- `actualAccruedMin` — **denormalized**, bumped when a *work* session closes (excludes breaks + paused time). Avoids scanning sessions.
- `cancelled` tasks are excluded from calibration.

**taskPlans** — scheduling (the *when*), separate from the task (the *what*). Enables multi-day + ordering.
- `id · taskId · day · plannedMinutes · order`. A task may have plan rows on several days. Morning "planned hours" for a day = Σ `plannedMinutes` on that day. "Remaining" = `estimateLockedMin − actualAccruedMin`.

**taskSeries** — recurrence template.
- `id · title · categoryId · defaultEstimateMin · rule · active · anchorDate`.
- `rule` (**simple** for v1): `{ kind: daily | weekdays | weekly | everyN, interval?, daysOfWeek?[] }`. Full RRULE (nth-weekday-of-month, exceptions) is deferred.
- Each occurrence is a real **task** instance with `seriesId` → its own estimate/actual → **its own calibration point**. Editing one occurrence doesn't touch siblings; editing the series affects future occurrences. Generation horizon/strategy (client vs scheduled Lambda) is an infra detail.

**ideas** — `id · text · createdAt · status(open | triaged | discarded)`.

**habits** — `id · name · categoryId · cadencePerWeek · active`. (Recurring *behaviors*, binary, no estimate — distinct from recurring tasks.)
**habitChecks** — `id · habitId · date`. Compound uniqueness on `(habitId, date)`.

**pomodoroSessions**
- `id · taskId? · categoryId · wasWork · kind · startedAt · endedAt? · day · activeMinutes · status · lastHeartbeatAt`
- `kind`: `work | break` — **only `work` accrues** to `task.actualAccruedMin` + time-budget.
- `wasWork`: **snapshot** of the category's `isWork` at write time → immutable balance history.
- `categoryId`: **follows the task** when `taskId` is set; manual only for taskless freeform focus.
- **Pauses supported** — `activeMinutes` accumulates only un-paused time; paused time never counts.
- `status`: `running | completed | discarded`. Running sessions are persisted with a **heartbeat** (`lastHeartbeatAt`); on next open, a stale running session prompts **keep (capped at last heartbeat) / discard** — no orphans.

**days** — per-day singleton: `date(pk) · capacityHours · intent · reflectionPrompt · reflectionText`.

**categories** — `id · label · isWork · order · active`.
- Referenced by **id**. **Labels resolve live** (renames propagate to display). **`isWork` is snapshotted** onto sessions (`wasWork`) so history is frozen. Flipping `isWork` prompts an **optional retroactive backfill** ("also reclassify N past records?"). **Deleting** forces reassignment of all referencing items to another category first, then soft-deletes the empty one.

**leetcodeAttempts** — one row per LeetCode submission, accepted **and** wrong. Written by a browser extension, never by the app.
- `id · day · problemSlug · problemTitle · verdict · submittedAt · lang · runtimeMs? · memory? · leetcodeSubmissionId · frontendId? · difficulty? · topicTags?`
- `verdict`: `accepted | wrong_answer | time_limit | runtime_error | compile_error | memory_limit | other`. **Normalized server-side** from LeetCode's raw `status_code`/`status_msg` — the dep-free extension forwards raw signals only.
- `day` is bucketed server-side from `submittedAt` + the client's reported tz offset + `dayStartHour` (the server owns `dayStartHour`, so a foreign client can't compute the day key itself).
- **Idempotent on `leetcodeSubmissionId`** — a re-fire returns the existing row, original verdict intact.
- **Attempt count per problem is DERIVED at read time**, never a stored counter.
- Ingest is the one method authenticated by a static **device token** instead of a Cognito JWT. Full design + operator setup: **[RECRUITING.md](RECRUITING.md)**.

**settings** — singleton: `dayStartHour` (default 4), pomodoro work/break durations, theme override, etc.

### 2.3 Rules distilled (from the poke-holes pass)
1. Estimate freezes on first exit from planning; calibration uses the frozen value; scope change ⇒ split.
2. Categories: id-referenced, live labels, snapshotted `isWork`, reassign-on-delete, opt-in backfill on flip.
3. Sessions: heartbeat-persisted, `work|break`, pauses excluded, category follows task, orphan ⇒ keep/discard.
4. Never hard-delete — `deletedAt` tombstones everywhere.
5. ULIDs, `userId` on everything, `updatedAt` for last-write-wins across devices.
6. Day buckets use the configurable `dayStartHour` (default 4am).

### 2.4 Physical model — DynamoDB single-table (direction set; refined in infra talk)
```
PK = u#<userId>            (one partition per user — fine at single-user volume)
SK (type-prefixed range keys):
  log#<day>#<ulid>              day's log entries          (begins_with log#<day>)
  task#<ulid>                   task by id
  plan#<day>#<order>#<ulid>     day's planned tasks, sorted (begins_with plan#<day>)
  sess#<day>#<ulid>             sessions for a day / week range
  hcheck#<date>#<habitId>       habit checks (also enforces one-per-day)
  day#<date>                    day singleton (direct get)
  habit#<id> · cat#<id> · idea#<ulid> · series#<id> · settings
```
- **One GSI** (calibration — done tasks by completion date): `GSI1PK = u#<userId>#done`, `GSI1SK = <completedAt>`.
- **Denormalized** `task.actualAccruedMin` → no session-scan for "remaining".
- **Balance / time-budget aggregate in the Lambda** over the day/week range (no GSI needed at this volume).
- Access patterns enumerated in the infra discussion; keys above satisfy them with prefix reads + the one GSI.

---

## 3. Routing & state

**Routes (React Router):**
- `/` — the glanceable **home** (auto morning/day/night by clock, manual override). The hub; ≤5 things per mode.
- `/log · /tasks · /habits · /inbox · /settings` — the **deep views** (full backlog, browse past log days, manage habits, triage ideas, edit categories / durations / theme / export). **Home = glance, deep views = work.**
- **Pomodoro is not a route** — a persistent element; the running (heartbeat-backed) timer follows you across views.
- **Capture bar is global** — always present, not a route.

**State — three layers:**
- **Server/data → React Query.** One query per access pattern; **optimistic mutations** for instant feel.
- **UI/session → React Context.** Current home mode, running timer, capture-bar state.
- **Auth → Cognito session** in a context provider. Frontend lib: **`react-oidc-context` + Cognito Hosted UI** penciled in (final call in infra talk).

---

## 4. Folder structure & tooling

pnpm workspaces monorepo.

```
aperture/
  app/                 # React PWA (Vite)
    src/
      pages/           # Home, Log, Tasks, Recruiting, Habits, Inbox, Settings
      modules/         # capture, pomodoro, tasks, habits, log, calibration
      components/      # primitives: Card, Text, … (anti-generic token layer)
      data/            # React Query hooks + api client
      lib/             # ulid, dates, dayBoundary helpers
      auth/            # Cognito/OIDC glue
      styles/          # Tailwind tokens (CSS-var theme)
  lambdas/             # BFF Lambda(s) — index.ts, routes, ddb client, jwt-validate, writes object
  cdk/                 # CDK app (infra)
  extension/           # Firefox MV3 add-on — LeetCode capture. No deps/bundler/build step; NOT a
                       #   pnpm workspace member, and excluded from eslint + prettier
  packages/shared/     # shared TS types across app + lambda
  scripts/             # dev + CI utilities
  docs/  ·  localNotes/
```

**Tooling:** **pnpm** (package manager + workspaces) — **never npm/yarn** · **Vitest** (one test runner, Node everywhere) · Vite (app bundler) · TS project refs · ESLint + Prettier · esbuild-via-CDK for Lambda bundling · GitHub Actions CI. Dependency discipline per **[CONVENTIONS.md](CONVENTIONS.md)** (first-principles: build it ourselves by default).

**As built (Phase 0):** Node 22 · pnpm 11 · TypeScript **6** (pinned below 7 for lint support) · Vite 8 · Vitest 4 · React 19 · ESLint 10. Internal packages resolve **from source** (`@aperture/shared` exports `src/index.ts`; consumers transpile it, no dev/test build step); `shared` emits a gitignored `dist/` only to satisfy project references. Full rationale + the version-pin gotchas in **[V1_PLAN.md](V1_PLAN.md) → Phase 0 (as built)**.

---

## 5. The AI seam (v1.1+, boundary only)

Nothing built in v1 — just a clean boundary so reflection is additive later.
- **Server-side only:** the Lambda calls the model (key in Secrets Manager); never from the browser. This is why sending journal text out is a Lambda concern.
- **Substrate already exists:** reflection reads `logEntries` / `tasks` / `pomodoroSessions` over a date range — existing access patterns. **No schema change** needed for basic reflection.
- **Reserved entity** (not built): `reflections` — `id · periodType(week|month|year) · periodKey · generatedAt · promptVersion · content`.
- **Model:** Claude (Anthropic API), latest at build time, per repo norms.

---

## Status

Specs complete; infra decisions resolved in **[INFRA.md](INFRA.md)** (Function URL + CloudFront OAC, Cognito, dev+prod, CDK split, GitHub OIDC CI, Porkbun/ACM domain as last step).

**Implementation:** the pnpm/TS/Vitest workspace foundation (V1_PLAN Phase 0) is built and green as of 2026-08-03 — pinned toolchain, project references, dual Vitest envs, blank app shell. Next: **Phase 1** (shared contract + in-memory stub).
