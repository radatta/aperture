# Aperture — v1 Implementation Plan

Sequenced work breakdown to ship v1. Implements `product/PRODUCT.md`, `arch/TECH.md`, `product/CONVENTIONS.md`, `arch/INFRA.md`.
Product is the source of truth; where this plan and product disagree, product wins.

**How to read:** ordered phases → milestones → tasks. Each phase states its goal, tasks,
key files it creates, dependencies, and the spec sections it implements. Build order is
**page-first**: workspace → stub contract → validate home/capture/calibration UX against the
stub → real Lambda + DynamoDB → auth → CI/infra → custom domain LAST. This doc is the plan as
written plus the per-phase as-built record — not the roadmap of what exists (the `areas/` docs are)
and not a second copy of the spec: each milestone keeps its module/file names and citations, and the
rule text lives at the cited section. Key-file paths are plan-time; the tree is authoritative (e.g.
`app/data/` became `app/src/data/`, `cdk/lib/` is `cdk/src/lib/`, there is no `lambdas/src/routes/`).

**Build status:** Phases **0–14 ✅ built** (first verified against the tree 2026-08-11, at 236 tests; the
live count and what's open are in [`index.md`](index.md)). Not from memory — the per-phase evidence is
in the "as built" note under each phase heading where one exists.

**Open, and deliberately not claimed as done** — not code, so not verifiable here:

- **9.2 — the stub-validation gate.** "Dogfood against the stub for a real morning + night" before
  trusting the backend. This is a human gate; only the author knows whether it happened.

Shipped **beyond** this plan (see `arch/CICD_HARDENING.md`): cdk-nag, billing + CloudWatch alarms,
health check, gitleaks, Dependabot, deploy notifications.

---

## A. Order-sensitive decisions — build these in from day one

Cheap to encode at the start and expensive-to-impossible to retrofit. They live in the **shared types +
the API contract** (Phase 1), so the stub and the eventual Lambda both honor them — encoding them once,
in the contract, is what lets the page-first stub be a faithful stand-in. The rule text lives at each
citation; only the retrofit cost is kept here.

1. **ULIDs, client-generated** — never an auto-increment or server id; sort keys depend on ULID lexical
   ordering. (TECH §2.1)
2. **`userId` scoping on every item** — the partition key (`u#<userId>`) and every query filter assume
   it; bake it into the contract so no endpoint is ever written unscoped. (TECH §2.1, §2.4)
3. **Soft-delete everywhere** — add `deletedAt` to the base type now, not per-entity later. (TECH §2.1, §2.3.4)
4. **Configurable day-start offset** — every `day`/`date` bucket goes through one helper (`dayBoundary`),
   never `new Date().toISOString().slice(0,10)`; one choke point = retrofit-proof. (TECH §2.1, §2.3.6)
5. **Estimate freeze at start-of-work** — the state machine must enforce it from the first task written,
   or early data is uncalibratable. (PRODUCT §4a, TECH §2.2, §2.3.1)
6. **Snapshotted `wasWork` on sessions** — retrofitting a snapshot after sessions exist is guesswork.
   (TECH §2.2, §2.3.2–3)
7. **Session heartbeat lifecycle** — the heartbeat field and status machine must exist from the first
   timer. (TECH §2.2, §2.3.3)
8. **`taskPlans` / `taskSeries` split** — collapsing these into `task` blocks multi-day scheduling and
   per-occurrence calibration and is a full remodel to undo. (PRODUCT §4a, TECH §2.2)
9. **Writes-object pattern (Lambda)** — introduce the seam in the stub's mutation layer so the real
   Lambda inherits it. (TECH §4, INFRA §4, §9)
10. **Lazy-on-read recurrence generation** — the generation call site exists in the day-load path from
    the stub onward. (INFRA §4)
11. **`updatedAt` last-write-wins** — every mutation stamps it. (TECH §2.3.5)
12. **Categories: id-referenced, live labels, reassign-on-delete** — items reference `categoryId` from
    the first row. (TECH §2.2, §2.3.2)

---

## B. Dependency ledger — first-principles discipline (CONVENTIONS)

Default is **roll our own**; a dep needs an explicit (A)/(B) case per `product/CONVENTIONS.md`. Every
tempting point is flagged here so it can't sneak in.

| Candidate                                                                                                                                 | Verdict                                            | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react`, `react-dom`, `react-router-dom`, `@tanstack/react-query`, `vite`, `tailwindcss` v4, `typescript`, `vitest`, `eslint`, `prettier` | **Baseline**                                       | Framework/tooling floor, fixed by TECH §1/§4. Not discretionary.                                                                                                                                                                                                                                                                                                                                                              |
| `react-oidc-context` (+ `oidc-client-ts`)                                                                                                 | **Add — (B)**                                      | OIDC/PKCE flow + silent token refresh is security-critical and subtle; do not hand-roll. Penciled in by CONVENTIONS + TECH §3 + INFRA §6. Adds `oidc-client-ts` transitive; acceptable.                                                                                                                                                                                                                                       |
| `vite-plugin-pwa` (Workbox)                                                                                                               | **Add — (A)/(B)**                                  | Service-worker + manifest generation is substantial standards logic (precache, SW lifecycle) we should not own. Config only; app-shell precache, data stays network-first. TECH §1.                                                                                                                                                                                                                                           |
| `aws-jwt-verify` (Lambda)                                                                                                                 | **Add — (B)**                                      | Cognito JWT signature + issuer/expiry verification against JWKS is security-critical; AWS-maintained, zero-dep. Beats hand-rolling JWKS/RS256. INFRA §4.                                                                                                                                                                                                                                                                      |
| `@aws-sdk/client-dynamodb` + `lib-dynamodb` (Lambda)                                                                                      | **Add — necessary**                                | AWS-provided DDB access. Bundled out of the Node 22 Lambda by esbuild if needed.                                                                                                                                                                                                                                                                                                                                              |
| `aws-cdk-lib` + `constructs` (cdk/)                                                                                                       | **Add — necessary**                                | IaC per INFRA.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **ULID generation**                                                                                                                       | **Rolled our own** (`packages/shared/src/ulid.ts`) | ~50 lines: Crockford base32 + monotonic factory (same-ms increment) seeded from `crypto.getRandomValues`. Correctness (monotonicity/entropy) is subtle → **covered with Vitest property tests**. Fall back to the `ulid` npm pkg _only_ if monotonicity proves fiddly. CONVENTIONS worked-call.                                                                                                                               |
| **Date helpers**                                                                                                                          | **Roll our own**                                   | `dayBoundary`, ISO-week, add/format are small and targeted (TECH §1). Reach for a date lib _only_ if DST edges prove genuinely gnarly — flag before adding.                                                                                                                                                                                                                                                                   |
| **Charts / viz**                                                                                                                          | **No dep — roll our own**                          | v1 viz (planned-vs-available bar, estimate-vs-actual, habit calendar) is hand-rolled CSS/SVG. Charts deferred entirely. TECH §1.                                                                                                                                                                                                                                                                                              |
| `@mediapipe/tasks-vision` (app, Flux)                                                                                                     | **Add — (A)+(B)**                                  | A trained 478-point face mesh + facial transformation matrix (not implementable), and the WASM/WebGL delegate lifecycle across browsers. Zero runtime deps; 156 KB bundle in the worker chunk only; 13 MB wasm + 3.76 MB model loaded lazily on first Start. Rejected: TF.js face-landmarks (no matrix, stale), ONNX + 6DRepNet (145 MB), PnP on landmarks (still needs a landmark model). [areas/flux](areas/flux/index.md). |
| State mgmt lib (Redux/Zustand/etc.)                                                                                                       | **No dep**                                         | UI/session state = React Context + hooks; server state = React Query. TECH §3.                                                                                                                                                                                                                                                                                                                                                |
| Component/UI kit (MUI/shadcn/etc.)                                                                                                        | **No dep**                                         | Anti-generic is a v1 requirement (PRODUCT §5). Build the small primitive layer ourselves on Tailwind tokens.                                                                                                                                                                                                                                                                                                                  |

---

## Phase 0 — Workspace & tooling foundation ✅ BUILT (2026-08-03)

**Goal:** a green pnpm monorepo that lints, typechecks, and runs an empty Vitest suite across all
packages. No product code yet.

**Milestones & tasks**

- **0.1 Monorepo skeleton** — `pnpm-workspace.yaml` (`app`, `lambdas`, `cdk`, `packages/*`, `scripts`);
  root `package.json` with `-r` scripts (`build`, `test`, `lint`, `typecheck`); `.nvmrc`/`engines`
  pinning Node 22 to match the Lambda runtime; `.gitignore`.
- **0.2 TS project references** — root `tsconfig.base.json`; per-package `tsconfig.json` referencing
  `packages/shared`. Strict mode on.
- **0.3 Lint/format** — shared ESLint flat config + Prettier; wired into root scripts.
- **0.4 Vitest baseline** — per-package `vitest.config.ts`: **jsdom** env for `app/`, **node** env
  for `lambdas/` + `packages/shared` (Node parity per CONVENTIONS). Convention: co-located
  `*.test.ts`. One trivial passing test per package to prove wiring.
- **0.5 App bootstrap** — `pnpm create vite app --template react-ts` (via `pnpm dlx`), stripped to a
  blank shell; confirm `pnpm --filter app dev` serves.

**Key files:** `pnpm-workspace.yaml`, `tsconfig.base.json`, root `package.json`, `eslint.config.js`,
`app/vite.config.ts`, `packages/shared/package.json`.
**Depends on:** nothing. **Implements:** TECH §4, CONVENTIONS (pnpm, Vitest).
**Trade-off:** invest in project-refs + dual Vitest envs now so `lambdas/` never needs a second
runner later — the whole point of the pnpm/Vitest call.

**As built (2026-08-03):** green end to end — `install · typecheck · lint · test · build · dev` all pass.

- **Pins** (resolved via `npm show`, not guessed): Node **22** (`.nvmrc`, `engines >=22.12`, Lambda
  `nodejs22.x`) · pnpm **11.18** (corepack) · TypeScript **6.0.3** · Vite **8.2** · Vitest **4.1** ·
  React **19.2** · ESLint **10.8** + typescript-eslint **8.65** · Prettier **3.9**.
- **TS pinned to 6, not 7:** `typescript-eslint@8.65` peers `typescript <6.1.0`, so TS 7 (the
  native-compiler rewrite) breaks type-aware lint. Bump when typescript-eslint supports TS 7.
- **Node 22, not 24:** matches the dev environment and the Lambda runtime; keeps dev == deploy target.
- **Internal packages resolve from source:** `@aperture/shared` exports `./src/index.ts`; `app`/`lambdas`
  import it directly and their bundler transpiles it — **no build step in the dev/test loop**. `shared`
  emits a gitignored `dist/` only to satisfy TS project references (a _referenced_ composite project
  can't be `noEmit` — TS6310). Nothing imports that `dist/`. (Rule: `product/CONVENTIONS.md` → _Monorepo_.)
- **Structure:** typecheck = one root `tsc -b` (project references); lint = one root `eslint .` (flat
  config); `test`/`build` fan out per-package (`pnpm -r`). Dual Vitest envs — jsdom (`app`), node (rest).

---

## Phase 1 — Shared contract + stub API (the seam)

**Goal:** the single most important phase for page-first. Define every entity type and the `ApiClient`
interface in `packages/shared`, then implement an **in-process stub** that fully satisfies it — so the
app runs against realistic data with zero backend. The real Lambda later implements the _same_
interface; swapping is one module.

**Milestones & tasks**

- **1.1 Entity types** — in `packages/shared/src/types.ts`: `LogEntry, Task, TaskPlan, TaskSeries,
Idea, Habit, HabitCheck, PomodoroSession, Day, Category, Settings` on a `BaseEntity`
  (`id · createdAt · updatedAt · deletedAt · userId`), encoding the order-sensitive fields from §A
  (`estimateLockedMin`, `wasWork`, `lastHeartbeatAt`, `status` unions, `rule` union, etc.).
- **1.2 State machines & invariants** — pure helpers in shared: `taskTransition()`,
  `sessionTransition()`, category-delete reassignment guard — one source of truth for stub and Lambda.
- **1.3 `ApiClient` contract** — `packages/shared/src/api.ts`: one method per access pattern
  (`listLogEntries(day)`, `createLogEntry`, `listBacklog`, `scopeTask`, `startTask`, `completeTask`,
  `listPlansForDay`, `upsertPlan`, `startSession`/`heartbeat`/`stopSession`, `listHabits`,
  `checkHabit`, `listIdeas`, `triageIdea`, `getDay`/`setCapacity`/`setIntent`/`setReflection`,
  `listCategories`/`upsertCategory`, `getSettings`/`updateSettings`, `getCalibration(range)`).
  Mirrors TECH §2.4 prefix reads + the calibration GSI.
- **1.4 Stub implementation** — `app/data/stubClient.ts`: `ApiClient` over an in-memory store
  persisted to `localStorage`, with the **writes-object** seam (§A.9) and **lazy recurrence** (§A.10)
  in `getDay`. Uses the real `ulid`/`dayBoundary` helpers so bucketing is exercised for real.
- **1.5 Seed dataset** — `app/data/seed.ts`: a few weeks of backdated `logEntries`, done tasks with
  `estimateLockedMin`/`actualAccruedMin` spread, sessions, habit checks. **Critical for validation:**
  calibration/night-review can't be judged against an empty store.
- **1.6 lib helpers + tests** — `app/src/lib/ulid.ts`, `app/src/lib/dates.ts` (`dayBoundary`,
  ISO-week, format), with Vitest property tests (ULID monotonicity/sort; day-offset at 3am/4am/5am,
  DST). Per §B.

**Key files:** `packages/shared/src/{types,api,machines}.ts`, `app/data/stubClient.ts`,
`app/data/seed.ts`, `app/src/lib/{ulid,dates}.ts`.
**Depends on:** Phase 0. **Implements:** TECH §2 (whole), §3 (data layer), §A (all).
**Critical files:** `packages/shared/src/types.ts`, `packages/shared/src/api.ts`, `app/data/stubClient.ts`.
**Trade-off:** effort spent making the stub _faithful_ (real helpers, writes-object, lazy recurrence)
is what makes the page-first validation trustworthy and the backend swap mechanical. A lazy stub
would defer the hard modeling questions to the expensive phase — exactly what CONVENTIONS forbids.

---

## Phase 2 — Design system, theme & primitives

**Goal:** the anti-generic visual foundation. Aesthetic is a v1 _requirement_, not polish-later
(PRODUCT §2.2, §5) — every page is built on these tokens, so they come before pages.

**Milestones & tasks**

- **2.1 Theme tokens** — the PRODUCT §5 palette (from `localNotes/preview.webp`) as CSS custom
  properties (`--surface`, `--fg`, `--accent-gold`, …) in `app/src/styles/`, light + dark sets;
  **auto-theme is a one-line data-attribute flip** driven later by home mode. (TECH §1, PRODUCT §5)
- **2.2 Type + density** — pick + self-host a sans per PRODUCT §5's locked commitments; set the
  airy-overall / crisp-data-blocks density scale.
- **2.3 Primitive components** — `components/`: `Card, Text, Button, Field, ModeToggle, Menu`
  (row overflow), `DeltaBar` (estimate/actual), `MiniBar` (planned-vs-available), `TimerPill`.
  Semantic token layer, not raw utilities scattered. Snapshot/interaction tests where cheap.
- **2.4 Theme context** — `ThemeProvider` reading `settings.theme` override else follows home mode.

**Key files:** `app/src/styles/tokens.css`, `app/src/styles/theme.ts`, `app/src/components/*`,
`app/src/components/ThemeProvider.tsx`.
**Depends on:** Phase 0 (1 for `settings` type). **Implements:** PRODUCT §5, TECH §1 (styling).
**Trade-off:** committing to specific palette/type/density now is the direct fix for the last build's
"bland UI" failure mode — generic-by-default is the risk to design against.

---

## Phase 3 — Capture bar + interstitial log (against stub)

**Goal:** the frictionless default working end-to-end. This is PRODUCT's #1 mechanic — capture cost
below memory cost.

**Milestones & tasks**

- **3.1 Global capture bar** — `modules/capture/CaptureBar.tsx`: the always-present
  `[ Log | Task | Idea ]` bar (global focus hotkey on web, bottom-fixed thumb-reach layout on narrow
  viewports), behaving exactly as PRODUCT §2 specifies — Log default, snap-back after submit, never
  asks for structure.
- **3.2 Routing** — mode dispatch: Log → `createLogEntry`, Task → title-only backlog `createTask`,
  Idea → `createIdea`. Optimistic mutations via React Query.
- **3.3 Interstitial log view** — `modules/log/` + `pages/Log.tsx`: one-day-per-page timeline per
  PRODUCT §4b (append-only, light edit, no backdating); browse past days via `dayBoundary`.
- **3.4 React Query wiring** — hooks in `app/data/hooks/` bound to `stubClient`; query keys per access
  pattern; optimistic + rollback.

**Key files:** `app/src/modules/capture/CaptureBar.tsx`, `app/src/modules/log/*`,
`app/src/pages/Log.tsx`, `app/data/hooks/useLog.ts`.
**Depends on:** Phases 1–2. **Implements:** PRODUCT §2, §4b (log), TECH §3.
**Critical file:** `CaptureBar.tsx` (the mechanic the whole product hinges on).

---

## Phase 4 — Three-mode glanceable home shell

**Goal:** the hub. `/` auto-switches morning/day/night by clock (with manual override), ≤5 elements
per mode, glanceable in ~2s. This is a primary validation target.

**Milestones & tasks**

- **4.1 Home-mode context** — `modules/home/HomeModeProvider.tsx`: derives mode from clock via
  `dayBoundary`-aware windows; manual override; drives ThemeProvider (light morning/day, dark night).
- **4.2 Mode layouts** — `pages/Home.tsx` with the three PRODUCT §3 layouts composed, each ≤5
  elements (☀️ capture · Plan-today (Phase 5) · habits due · intent; ⚙️ capture · today's tasks
  (planned vs elapsed) · pomodoro · time-budget; 🌙 capture · Today-in-review · habits check · reflection prompt).
- **4.3 Deep-view routes** — `/log · /tasks · /habits · /inbox · /settings` route shells; home = glance,
  deep views = work.

Slots that depend on later phases render as honest placeholders now and light up as those phases land.

**Key files:** `app/src/pages/Home.tsx`, `app/src/modules/home/HomeModeProvider.tsx`, `app/src/router.tsx`.
**Depends on:** Phases 2–3. **Implements:** PRODUCT §3, TECH §3.
**Trade-off:** deliberately **do not** put balance/non-work or resurfacing on the daily home — parked
per PRODUCT §3/§6 (balance lives via habits only in v1).

---

## Phase 5 — Tasks + estimation calibration (the signature feature)

**Goal:** the anti-overconfidence engine, validated against the stub's seeded history. Second primary
validation target.

**Milestones & tasks**

- **5.1 Task lifecycle** — `modules/tasks/`: `backlog → planned → in_progress → done` (+ `cancelled`),
  driven by shared `taskTransition()`, with the estimate lock + split-not-edit rule. (PRODUCT §4a, §A.5)
- **5.2 Morning plan pass** — `modules/calibration/PlanToday.tsx`: pull backlog tasks in, set estimate
  - buffer + category, write `taskPlans` rows (multi-day, manual `order`); live **planned hours vs
    hours available** from `day.capacityHours`. (PRODUCT §3 ☀️, §4a)
- **5.3 Buffer nudge** — flat **+25%** suggestion in v1 (personalized-from-bias is parked). (PRODUCT §4a)
- **5.4 Actual-time capture** — on "done," the hybrid prompt (one number, pomodoro-prefilled, editable);
  records `actualAccruedMin`. (PRODUCT §4a, §A.5)
- **5.5 Rollover** — unfinished planned task rolls to backlog, no penalty, visible as an honest signal. (PRODUCT §4a)
- **5.6 Recurring tasks** — `taskSeries` with simple `rule`; occurrences are real tasks with `seriesId`;
  **lazy materialization on day load**; edit-one vs edit-series semantics. (PRODUCT §4a, TECH §2.2, §A.8/§A.10)
- **5.7 Calibration surfaces** — `modules/calibration/`: per-task delta as a hand-rolled bar
  (`DeltaBar`/`MiniBar`) in the night review so the gap is seen rather than subtracted, plus the
  simple aggregate ratio + trend, **honestly sparse early**. No charts dep. (PRODUCT §4a, §6.4)
- **5.8 Backlog deep view** — `pages/Tasks.tsx`: full backlog, filter, split, cancel, series management.

**Key files:** `app/src/modules/tasks/*`, `app/src/modules/calibration/*`, `app/src/pages/Tasks.tsx`,
`packages/shared/src/machines.ts` (task transition).
**Depends on:** Phases 1, 4 (home slots), 8 (categories/capacity — build capacity input early or stub it).
**Implements:** PRODUCT §4a, §3 ☀️/🌙, TECH §2.2, §A.5/§A.8.
**Critical files:** `modules/tasks/taskLifecycle.ts`, `modules/calibration/PlanToday.tsx`.
**Trade-off:** freeze-on-start + split-not-edit feels stricter than editing an estimate, but it's the
whole integrity of the calibration — "so hindsight can't launder the calibration." Non-negotiable.

---

## Phase 6 — Pomodoro (heartbeat lifecycle)

**Goal:** minimal timer that feeds calibration, with a robust orphan story.

**Milestones & tasks**

- **6.1 Timer engine** — `modules/pomodoro/`: configurable work/break (default 25/5), `kind: work|break`
  with the accrual, category-follows-task and `wasWork` rules of TECH §2.2. (PRODUCT §4b, §A.6)
- **6.2 Persistence + heartbeat** — running session persisted with `lastHeartbeatAt`; pauses excluded;
  stale-session **keep / discard** via shared `sessionTransition()`. (§A.7)
- **6.3 Persistent UI** — `TimerPill` follows across views (pomodoro is **not a route**). (TECH §3)
- **6.4 Accrual on close** — work session close bumps denormalized `task.actualAccruedMin` and prefills
  the task's "actual." (TECH §2.2/§2.4)

**Key files:** `app/src/modules/pomodoro/*`, `app/src/components/TimerPill.tsx`,
`packages/shared/src/machines.ts` (session transition).
**Depends on:** Phases 1, 4, 5. **Implements:** PRODUCT §4b, TECH §2.2, §A.6/§A.7.
**Trade-off:** heartbeat + keep/discard is more work than a naive timer, but a life-OS that loses or
double-counts work sessions poisons the one signal v1 exists to produce.

---

## Phase 7 — Habits + quick-capture inbox

**Goal:** the supportive, non-policing modules — the only v1 vehicle for non-work balance.

**Milestones & tasks**

- **7.1 Habits** — `modules/habits/`: weekly-cadence (`cadencePerWeek`), calendar view, night check;
  `habitChecks` unique on `(habitId, date)`; no streaks, may hold non-work items. (PRODUCT §4b, §3 🌙)
- **7.2 Habits deep view** — `pages/Habits.tsx`: create/edit habits, calendar history.
- **7.3 Inbox** — `modules/inbox/` + `pages/Inbox.tsx`: Idea captures land here; triage each into
  task / log / note / discard. (PRODUCT §2, §4b)

**Key files:** `app/src/modules/habits/*`, `app/src/pages/Habits.tsx`, `app/src/modules/inbox/*`,
`app/src/pages/Inbox.tsx`.
**Depends on:** Phases 1, 4. **Implements:** PRODUCT §4b, §3.
**Trade-off:** habits carry the _entire_ non-work presence in v1 by design — the analytical weekly
balance view is parked to v1.1 (PRODUCT §6.1). Do not add a daily non-work checkbox; that's the
guilt-nag the identity forbids.

---

## Phase 8 — Settings, categories, day capacity

**Goal:** the config the above modules read. (Partly built earlier as stubs; this phase completes it.)

**Milestones & tasks**

- **8.1 Categories manager** — `pages/Settings.tsx`: the PRODUCT §4 starting set, editable, `order`,
  `isWork`; the id-referenced / reassign-on-delete / backfill-on-flip rules of §A.12. (TECH §2.2)
- **8.2 Day capacity + intent + reflection** — `days` singleton editors: `capacityHours` (manual —
  v1 "hours available" is a number, not calendar-derived), `intent`, rotating `reflectionPrompt` +
  `reflectionText`. (PRODUCT §3, §6.6)
- **8.3 Settings** — `dayStartHour` (default 4), pomodoro durations, theme override, **data export**. (TECH §2.2)

**Key files:** `app/src/pages/Settings.tsx`, `app/src/modules/settings/*`.
**Depends on:** Phase 1. **Implements:** PRODUCT §4, §3, TECH §2.2, §A.4/§A.12.
**Note:** capacity input is a dependency of Phase 5.2 — land a minimal capacity field during Phase 5
if scheduling sequences it earlier.

---

## Phase 9 — PWA install + stub-validation gate

**Goal:** installable app shell, then a hard **go/no-go on product feel** before any backend spend.

**Milestones & tasks**

- **9.1 PWA** — `vite-plugin-pwa`: manifest (name, icons from the gold/teal identity), service worker
  precaching the **app shell only** (data stays network-first — online-first per TECH §1/offline stance).
  Verify installable on phone + desktop. (TECH §1)
- **9.2 Validation gate (page-first payoff)** — dogfood against the stub for a real morning + night.
  Judge against PRODUCT's own bar: does the home **earn the open**? Is capture below memory cost? Does
  the calibration surface land as _evidence, not judgment_? Fix UX here — cheap against a stub. Only
  pass this gate to proceed to backend. (CONVENTIONS build-order rationale)

**Key files:** `app/vite.config.ts` (PWA), `app/public/manifest` + icons.
**Depends on:** Phases 3–8. **Implements:** TECH §1, CONVENTIONS (page-first).
**Trade-off:** an explicit gate is the entire justification for page-first — "far cheaper to discover
the product is wrong against a stub than against real infra."

---

## Phase 10 — Real backend: DynamoDB single-table + Lambda BFF

**Goal:** implement the **same `ApiClient` contract** behind a real Lambda + DynamoDB. Swap
`stubClient` → `httpClient`; UI unchanged.

**Milestones & tasks**

- **10.1 Single-table mapping** — `lambdas/src/ddb/`: keys per TECH §2.4 (`PK=u#<userId>`, the
  type-prefixed SKs) + **GSI1** (`u#<userId>#done` / `<completedAt>`) for calibration. Denormalized
  `task.actualAccruedMin`.
- **10.2 Route handlers** — `lambdas/src/routes/`: one handler per `ApiClient` method; prefix reads +
  the one GSI; balance/time-budget aggregated **in the Lambda** (no extra GSI). Reuse the **shared**
  `machines.ts` so lifecycle rules are identical to the stub.
- **10.3 Writes-object** — `lambdas/src/writes.ts`: the single audit point. (INFRA §4/§9, §A.9)
- **10.4 Lazy recurrence** — materialize due `taskSeries` occurrences on day-load. (INFRA §4, §A.10)
- **10.5 HTTP client** — `app/data/httpClient.ts` implementing `ApiClient` over `fetch` to `/api/*`;
  feature-flag stub↔http. **Contract tests run both clients against the same suite** (shared in
  `packages/shared`) → the swap is verified, not hoped.
- **10.6 Lambda tests** — Vitest on **Node** (parity), DDB via local mock/`aws-sdk-client-mock`.

**Key files:** `lambdas/src/index.ts`, `lambdas/src/ddb/*`, `lambdas/src/routes/*`,
`lambdas/src/writes.ts`, `app/data/httpClient.ts`, `packages/shared/src/contractTests.ts`.
**Depends on:** Phases 1, 9. **Implements:** TECH §2.4, §3, INFRA §4/§5, §A.9/§A.10.
**Critical files:** `lambdas/src/index.ts`, `lambdas/src/ddb/keys.ts`, `app/data/httpClient.ts`.
**Trade-off:** single-partition-per-user is fine at single-user volume (TECH §2.4) — don't over-shard.

---

## Phase 11 — Auth: Cognito + OIDC

**Goal:** real identity; `userId` = Cognito `sub` scoping every item (previously a single fixed id).

**Milestones & tasks**

- **11.1 App auth** — `app/auth/`: `react-oidc-context` + Cognito Hosted UI (PKCE SPA client, no
  secret); AuthProvider context; attach JWT to `httpClient`; protected routes; silent refresh. (§B, TECH §3, INFRA §6)
- **11.2 In-handler JWT validation** — `aws-jwt-verify` in the Lambda, `sub` → `userId`. (INFRA §4, §B)
- **11.3 Wire scoping** — replace the fixed dev `userId` with `sub` end-to-end; confirm every read/write
  is scoped.

**Key files:** `app/src/auth/AuthProvider.tsx`, `app/data/httpClient.ts` (token attach),
`lambdas/src/auth/verify.ts`.
**Depends on:** Phase 10, and Cognito pool from Phase 12 (sequence 12's Data stack alongside/just
before this). **Implements:** TECH §3, INFRA §4/§6, §A.2.
**Trade-off:** invite-only, self-signup OFF (admin-create your own user) — no public registration to
build (INFRA §6).

---

## Phase 12 — CDK infra + dev environment

**Goal:** `ApertureData-dev` + `ApertureApp-dev` deployed; the app runs on `*.cloudfront.net` with real
data. No custom domain yet.

**Milestones & tasks**

- **12.1 Stack split** — `cdk/`: **`ApertureData-<env>`** = DynamoDB (single table, on-demand, **PITR
  on**, `RETAIN`) + Cognito User Pool (`RETAIN`); **`ApertureApp-<env>`** = Lambda + Function URL
  (`AWS_IAM`) + S3 (private) + CloudFront (OAC; default→S3, `/api/*`→Function URL; **403/404→`/index.html`**
  SPA fallback). Stateful never endangered by app redeploys. (INFRA §3/§4/§5/§7) _(As built: the
  Function URL is auth `NONE` behind a CloudFront-stamped origin-secret header, OAC fronts only S3 —
  INFRA §4.)_
- **12.2 Lambda packaging** — esbuild-via-CDK `NodejsFunction`, Node 22, ~15s / 512MB, no warming;
  env `TABLE_NAME · USER_POOL_ID · USER_POOL_CLIENT_ID · STAGE`. (INFRA §4) _(As built: the env var
  list is in INFRA §4.)_
- **12.3 Config wiring** — app build consumes CDK outputs (pool id, client id, CloudFront/api base).
- **12.4 Region** — everything in `us-east-1` (also where the CloudFront ACM cert must live later). (INFRA intro)
  _(As built: `us-west-1`; only the ACM certs and the billing stack are in `us-east-1` — INFRA intro/§8.)_
- **12.5 Deploy dev + smoke** — `cdk deploy` both dev stacks; invoke Lambda with a `testMode` payload
  (writes-object guarantees no side effects); Vite build → S3 sync → CloudFront invalidate; verify on
  the CloudFront default domain + PWA install with zero DNS. (INFRA §7/§9)

**Key files:** `cdk/bin/aperture.ts`, `cdk/lib/data-stack.ts`, `cdk/lib/app-stack.ts`, `cdk/cdk.json`.
**Depends on:** Phases 10–11. **Implements:** INFRA §1–7, §9 (smoke).
**Critical files:** `cdk/lib/data-stack.ts`, `cdk/lib/app-stack.ts`.
**Trade-off:** Function URL + CloudFront OAC over API Gateway = no per-request cost; the raw URL can't
be called directly. Locked by INFRA §4. _(As built: it is the origin-secret header, not OAC, that makes
the raw URL useless — INFRA §4.)_

---

## Phase 13 — CI/CD: GitHub Actions + OIDC

**Goal:** hands-off, keyless deploys; PRs gated on lint/test.

**Milestones & tasks**

- **13.1 OIDC roles** — GitHub OIDC trust: dev role ← `refs/heads/dev`, prod role ← `main`. **No static
  keys.** (INFRA §9) _(As built: the trust subs are `environment:dev` / `environment:prod`; the cutover
  `refs/heads/*` subs were pruned 2026-08 — INFRA §9.)_
- **13.2 PR workflow** — feature branch → PR runs **lint + typecheck + test only** (pnpm + Vitest);
  squash to `main`. (INFRA §9)
- **13.3 main pipeline** — lint/typecheck/test → `cdk deploy ApertureData-dev` + `ApertureApp-dev` →
  smoke dev → build app (env from CDK outputs) → S3 sync + invalidate → **manual approval** → same for
  prod. `dev` branch → one-off dev deploy. (INFRA §9) _(As built: no approval pause — prod follows dev
  automatically; INFRA §9 caveat.)_

**Key files:** `.github/workflows/pr.yml`, `.github/workflows/deploy.yml`, `scripts/src/smoke.ts`,
`cdk/lib/cicd-stack.ts`.
**Depends on:** Phase 12. **Implements:** INFRA §9, CONVENTIONS (pnpm/Vitest in CI).
**Trade-off:** manual approval before prod is the guardrail on the `RETAIN` data stack — an app bug
can't silently reach real data. _(As built: no manual approval. A `required_deployments:[dev]` merge gate stood in for it until it was
switched off 2026-09-10, so now the PR's required checks are the only gate and dev → prod is automatic. INFRA §9.)_
**Status: LIVE (2026-08).** Roles (assume-bootstrap-roles), workflows, and smoke runner built + green;
dev + prod deployed. Prod trust bound to the `prod` GitHub environment (scopes the prod role to
`environment:prod` jobs). Account/GitHub setup done: `ApertureCicd` deployed, repo vars (role ARNs,
region) + secrets (`ORIGIN_SECRET_DEV/PROD`) set, `prod` environment created.
**⚠️ No approval pause on this repo** — deploy-prod runs automatically after deploy-dev on a `main`
push; use the **`dev` branch** as the practical gate (dev-only deploy → validate → then push `main`; since `dev-cutover`, `pnpm bot deploy-dev`).
The premise first recorded here (that a required reviewer needs a public repo or a paid plan) was wrong —
the account is on Pro; the current state and the untested option are in INFRA §9 "Approval-gate caveat."

---

## Phase 14 — Prod environment + custom domain (LAST)

**Goal:** the real daily driver on its own domain. Explicitly the final step (INFRA §8) — not on the
critical path; wired right before real daily use.

**Milestones & tasks**

- **14.1 Prod stacks** — ✅ done (CI go-live): `ApertureData-prod` + `ApertureApp-prod` via the approval
  gate; prod user admin-created (invite-only).
- **CDK wiring for 14.2–14.4** — ✅ done: `cdk/src/config/domains.ts` (stage→domain, cert ARN from
  `APERTURE_CERT_ARN`), app-stack `domainName`/`certificateArn` props → CloudFront alias + cert, and the
  app client's callbacks include the custom domain **and** the CloudFront default (redirect_uri =
  `location.origin`). `deploy.yml` passes `CERT_ARN_DEV`/`CERT_ARN_PROD` vars. Alias/cert only apply when
  the ARN is set → pre-cert deploys stay on the CloudFront domain.
- **14.2 ACM certs** — ✅ done: two us-east-1 DNS-validated certs (`aperture.rahuldatta.dev` +
  `dev.aperture.rahuldatta.dev`), referenced by ARN via `CERT_ARN_*` GitHub vars (cert us-east-1, stacks us-west-1). (INFRA §8)
- **14.3 DNS (one-time)** — ✅ done: validation + alias CNAMEs added at **Netlify** (rahuldatta.dev's NS
  are delegated to Netlify/NS1, not Porkbun). ACM auto-renews while the CNAMEs stay. **No Route 53.** (INFRA §8/§11)
- **14.4 Cognito callbacks** — ✅ wired in CDK (app client callback/logout URLs); applies on the domain deploy. (INFRA §6)

**Key files:** `cdk/lib/app-stack.ts` (alias + cert ARN ref), `cdk/config/domains.ts`.
**Depends on:** Phases 12–13. **Implements:** INFRA §8/§11.
**Trade-off:** deferring the domain keeps DNS off the critical path — HTTPS + PWA install already work
on `*.cloudfront.net` from Phase 12.

---

## C. Definition of Done for v1

v1 is shipped when all are true (ties back to PRODUCT §1 success criteria — _less stress + honest
scoping_, and **earning the morning + night ritual**):

**Ritual (the #1 job)**

- [ ] Home auto-switches morning/day/night by clock (manual override), ≤5 elements per mode, glanceable
      in ~2s, auto teal→gold theme following the mode.
- [ ] After a week of self-use, the **morning + night** touchpoints happen because the home is worth
      opening — **no streaks, no guilt mechanics** anywhere.

**Capture (below memory cost)**

- [ ] One global capture bar, Log default, `[Log|Task|Idea]` Tab-cycle + Enter, snaps back to Log after
      submit; **never asks for structure**; reachable by hotkey (web) and thumb bar (phone).

**Honest scoping (the signature payoff)**

- [ ] Morning plan pass shows **planned hours vs available** and catches under-scoping before it's stress.
- [ ] Estimate **freezes at start-of-work**; scope change is a **split**, not an edit.
- [ ] "Done" captures actual (pomodoro-prefilled, editable); night review shows **per-task
      estimate-vs-actual** + a simple aggregate ratio (honestly sparse early). `cancelled` excluded.
      _As built (2026-11): nothing calibrated finishes without both numbers; a retro estimate at Done is marked ([integrity](areas/calibration/integrity.md))._

**Modules & data integrity**

- [ ] Interstitial log (append-only, no backdating), pomodoro (heartbeat, pauses excluded, keep/discard
      orphans), habits (weekly-cadence, no streaks, may hold non-work), inbox triage — all working.
- [ ] Multi-day scheduling (`taskPlans`) + recurrence (`taskSeries`, lazy-on-read) each yield their own
      calibration point.
- [ ] Every entity: ULID, `userId`-scoped, soft-delete, `dayStartHour`-bucketed. Nothing hard-deletes.

**Platform**

- [ ] Installable PWA (app shell offline; data online-first).
- [ ] Cognito-authed (invite-only), dev + prod on CDK (split stateful/replaceable, PITR on), keyless
      OIDC CI green, live on the custom domain.
- [ ] Same `ApiClient` contract passes against both stub and real backend (contract tests green).

**Feel (the anti-bland requirement)**

- [ ] Quiet field-notebook aesthetic from `preview.webp` holds up in-hand; calibration reads as
      **evidence, not judgment**; non-work life is invited (via habits), never policed.

---

## D. Explicitly out of v1 — post-v1 backlog (do NOT build now)

The ordered parked-for-later list is PRODUCT §6 (item 6, calendar integration, has since shipped —
`areas/calendar/`). One addition to item 3 there (AI reflection): the seam exists — reads over existing
access patterns + the reserved `reflections` entity (TECH §5), model key → Secrets Manager (INFRA §10) —
and nothing is built.
