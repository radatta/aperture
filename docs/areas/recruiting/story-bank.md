# Behavioral Story Bank

A deep view in the `/recruiting` hub holding ~8–12 STAR stories tagged by competency, so behavioral prep
has a home. Second tab of recruiting, alongside LeetCode attempt capture ([index.md](index.md)).

**Status: built 2026-09-15** (branch `story-bank`). Validated on dev — create / update / delete verified
against real Cognito → Lambda → DynamoDB, including the deep-linked nested route. Merged as #12.
Gate green: typecheck · lint · tests (app 189 · lambdas 67 · shared 29 · cdk 18 · scripts 6) · headless UI
pass · code-review (0 Sev-1/2).

This doc is both the **design record** (the decisions below, each a deliberate product call with its
reasoning) and the **build record** (the data model, how the layers are wired, and the implementation
plan). Read alongside [../PRODUCT.md](../../product/PRODUCT.md), [../TECH.md](../../arch/TECH.md) §2 (data model),
[../CONVENTIONS.md](../../product/CONVENTIONS.md) (UI contracts), and [index.md](index.md) (the hub it joins).

---

## Data model

```
story#<ulid>   (single-table item, PK u#<userId>)
Story extends BaseEntity {
  title: string
  competencyTags: CompetencyTag[]
  situation: string
  action: string
  result: string
}
```

List is `alive()`-filtered, `updatedAt` desc with an `id` desc tie-break (deterministic under a frozen
clock). N is tiny (~8–12) → no GSI, no pagination.

---

## Decisions

Each of these is a call we made on purpose. Where an alternative was rejected, it's named — so a later
reader re-derives the choice instead of reopening it.

**Placement — a tab of `/recruiting`, not a top-level route.** A story bank is a recruiting-prep artifact,
so recruiting becomes a two-tab hub (attempts + stories) rather than a new nav destination. Keeps the app's
top-level surface small.

**Navigation — routed tabs, not in-page state.** `/recruiting` is a layout route: index = the attempts
list, `/recruiting/stories` = the story bank. It reads as a tab bar (`NavLink`s) but each tab is a real,
linkable route, so back/forward and deep links work. _Rejected:_ a single scrolling page with both
sections (two unrelated things sharing one scroll) and pure in-page tab state (not linkable). This is
recruiting's **first authoring surface** — attempts are read-only capture from the extension — so this tab
is where the write UI lives.

**Structured-at-entry — the one deliberate exception to capture-raw-enrich-later.** Everywhere else,
Aperture captures raw and enriches later, because capture cost must stay below memory cost. A STAR story is
the opposite: not a fleeting capture but a slowly-tightened artifact reused across many questions, so a real
editor (title + tags + Situation/Action/Result) is correct here. The exception is guarded so it doesn't
become a form you dread: **empty S/A/R are allowed** (start ugly, tighten later), and **only the title is
required** — it's the list row.

**Competency tags — a fixed six, shared constant, union type.** `COMPETENCY_TAGS = [leadership, conflict,
ownership, failure, ambiguity, impact] as const`, and the field is the **union type** `CompetencyTag[]`, so
the editor cannot emit an unknown tag (wire-identical to `string[]`, but type-checked). _Rejected:_ freeform
tags (no signal, no consistency) and an editable tag _entity_ (that's `Category`-style CRUD — overkill; the
set changes rarely and a code edit is fine). The set is fixed for **recall consistency**, deliberately
**not** to feed a coverage analytic — there is no "which competencies am I light on?" view. That would be a
score to fail at, against the DON'T-BUILD posture in [../PRODUCT.md](../../product/PRODUCT.md).

**Tags are multi-select.** One story often answers several question types (a leadership story that's also
about conflict), so a story carries a set, not a single primary competency.

**Lifecycle — soft-delete only, with a confirm.** `deleteStory` re-puts the row with `deletedAt` set; it is
never a physical delete, and reads drop tombstones via `alive()` (the app-wide rule; the lone `uncheckHabit`
hard-delete is tracked tech-debt, not a pattern to copy). Delete asks first — an inline `alertdialog`
confirm strip (the `HabitCard` pattern) — because there's no UI undo.

**API — dedicated RPC methods, a whole-object patch.** `listStories`, `createStory(input)`,
`updateStory(id, patch)`, `deleteStory(id)`. Dedicated methods (mirroring `setTaskCategory` et al.), not a
generic entity PATCH. `updateStory` takes a `patch` object (mirroring `updateSettings`) rather than
per-field setters, because the editor saves a whole form at once, not one field at a time.

**Order by `updatedAt` desc, no manual ordering.** Most-recently-touched first is the right default for a
bank you're actively tightening, and at N≈8–12 a manual reorder UI would be noise.

**Build page-first, and accept a red `lambdas` typecheck while doing so.** The UI is validated against the
stub client before the backend is wired behind the same contract. Because adding the four methods to the
`ApiClient` interface makes `BackendClient` stop satisfying it until the backend lands, root `pnpm
typecheck` is red in `lambdas` during that window — expected; work with `pnpm --filter @aperture/app` until
the backend phase.

**Deferred, on purpose:** practice/rehearse tracking (`lastPracticedAt`, "haven't rehearsed this lately"),
linking a story to a calibrated task, and any competency-coverage view — all wait for felt need, not a
guess.

---

## How it's wired

The BFF is RPC, not REST. A story method exists in four durable places, tied together by the type system:

```
FRONTEND · app/  —  StoryBank.tsx + useStories()
   │  React Query → POST /api/{method} + JWT
   ▼
CONTRACT · packages/shared  —  ApiClient · API_METHODS · Story
   │  { method, args } → backend[method]
   ▼
BACKEND · lambdas/  —  BackendClient · 4 story methods
   │  writes.put · delete = re-put +deletedAt
   ▼
STORAGE · DynamoDB  —  PK u#<userId> · SK story#<ulid>
```

- **Export bundle.** `stories` is part of `ExportBundle`, and the stub `Store`, both `exportData()`
  implementations, and the contract-test key list all carry it — a deliberate compile-time double-entry, so
  a new collection cannot silently fall out of the export (omitting `stories` anywhere fails to compile).
- Story methods ride the JWT path — no per-method handling in `index.ts` / `handler.ts`.
- The per-layer file list (shared / stub / hooks / UI / backend): the _Build record_ below.

---

## Build record (implementation plan)

Ordered, page-first. Each phase names the files it touches. Checked once built; `↳` notes record where
the build diverged from the plan above or hit something worth remembering. Built 2026-09-15.

- [x] **Phase 0 — shared contract** (makes both `ApiClient` impls red on purpose)
  - `packages/shared/src/stories.ts` (new) — `COMPETENCY_TAGS` + `CompetencyTag`; re-export from `index.ts`.
    - ↳ _Also added an `isCompetencyTag` guard, then removed it as dead code (code-review). The only producer of story tags is our own typed client — no dumb producer like the LeetCode extension — so runtime tag validation earns nothing here._
  - `packages/shared/src/types.ts` — the `Story` type.
    - ↳ _`types.ts` type-imports `CompetencyTag` from `stories.ts` (type-only → erased, no runtime cycle) rather than redefining the union, so the const and the type can't drift._
  - `packages/shared/src/api.ts` — `CreateStoryInput` / `StoryPatch`, the four `ApiClient` methods, `ExportBundle.stories`.
  - `packages/shared/src/rpc.ts` — the four method names.
  - `packages/shared/src/contractTests.ts` — a `stories:` case + the export-key assertion.

- [x] **Phase 1 — stub** (page-first substrate)
  - `app/src/data/stubClient.ts` — `Store.stories`, the four methods (`writes.insert/patch/softDelete`; `patch` already throws on a tombstone — the backend must match), list sort, `exportData`.
  - `app/src/data/seed.ts` — seeded stories so page-first isn't judged against an empty bank.
    - ↳ _Two, not three: one multi-tag with full S/A/R, one single-tag with an empty result (the "start ugly" state). Two was enough to show the list, the chips, and the ordering._

- [x] **Phase 2 — app data layer**
  - `app/src/data/queryKeys.ts` — `stories` key. `app/src/data/hooks/useStories.ts` (new) — query + three mutations, each `onSettled` → invalidate. Mirror `useSeries.ts`.

- [x] **Phase 3 — routing + UI**
  - `app/src/routes.tsx` — `recruiting` becomes a layout route (index `AttemptsSection`, `stories` `StoryBank`).
  - `app/src/pages/Recruiting/AttemptsSection.tsx` (new) — the current list body moved out of `index.tsx`.
  - `app/src/pages/Recruiting/RecruitingTabs.tsx` (new) — two `NavLink`s styled as a segmented control.
    - ↳ _Used `<nav aria-label="Recruiting sections">`, not `role="tablist"` — these are real navigation links, not ARIA tabs, so the honest role is a nav landmark (`aria-current` comes free from `NavLink`)._
  - `app/src/pages/Recruiting/index.tsx` — the hub: `h1` + tabs + `<Outlet/>`.
  - `app/src/components/Textarea/index.tsx` (new primitive) — label + `<textarea>`, `Field` classes.
  - `app/src/pages/Recruiting/StoryEditor.tsx` (new) — create+edit; title (autofocus), six `aria-pressed` chips in a `role="group"`, three `Textarea`s; Save disabled on blank title; no Enter-to-submit.
  - `app/src/pages/Recruiting/StoryBank.tsx` (new) — `useStories`; collapsed "New story"; `EmptyState`; per-row title + chips + Edit + `Delete…` confirm strip; focus returns to the trigger on dismiss.
    - ↳ _Added `disabled={del.isPending}` to the confirm Delete button (code-review) — matches the editor's own double-submit guard._

- [x] **Phase 4 — headless UI pass**
  - Drove `/recruiting` and `/recruiting/stories` in headless Chromium (`run-app`), light + Night, exercising create → edit → delete.
    - ↳ _No UI issues found — the story bank reuses existing primitives/tokens and rendered cleanly in both themes. Zero console errors across the whole flow._
    - ↳ _Chromium fought the sandbox: the `apt` `chromium` package is a snap wrapper that hangs in the container, so it pivoted to Playwright's own build + `playwright install-deps` (after clearing a hung dpkg lock). Dark had to be checked via the in-app **Night** mode toggle — the browser's `prefers-color-scheme` doesn't drive the theme (the app's `auto` follows home-mode)._

- [x] **Phase 5 — app tests (jsdom)**
  - `app/src/pages/Recruiting/Recruiting.test.tsx`, `app/src/pages/Recruiting/StoryBank.test.tsx` (new) — the cases are listed under _Testing_.
    - ↳ _Initially skipped — the contract suite + visual pass + dev dogfood all passed, which masked that the new UI had no dedicated jsdom tests; caught while auditing this build record and written 2026-09-15. Used plain DOM property assertions (`.disabled`), not `jest-dom` matchers — this repo doesn't wire those up._

- [x] **Phase 6 — real backend (node)**
  - `lambdas/src/ddb/keys.ts` — `sk.story` / `sk.storyPrefix`.
  - `lambdas/src/ddb/repo.ts` — `listStories` / `getStory` / `putStory`.
    - ↳ _`getStory` re-filters tombstones → `null` (mirrors `getTask`, not `getSeries`), so `updateStory` on a deleted row throws — parity with the stub's `patch`, which refuses a tombstoned id._
  - `lambdas/src/backend.ts` — `mustStory` + the four methods (create S/A/R default to `''`; delete re-puts with `deletedAt`, no-op if missing); `exportData` adds `stories`.
  - `lambdas/src/ddb/keys.test.ts` — the story key. `lambdas/src/backend.test.ts` (new) — the tombstone check under _Testing_.

- [x] **Phase 7 — docs + gate**
  - Updated [index.md](index.md), [../TECH.md](../../arch/TECH.md) §2, [../PRODUCT.md](../../product/PRODUCT.md).
    - ↳ _Also reorganized the recruiting docs into `docs/recruiting/` (`RECRUITING.md` → `recruiting/index.md`) and repointed the seven inbound links — done in the design-doc commit, ahead of the code._
  - Gate: `pnpm typecheck` · `pnpm lint` · `pnpm test` all green; `code-reviewer` run (0 Sev-1/2, its two minor findings applied — see Phase 0 and Phase 3 notes). Commits: `96fc34b` (docs) + the implementation commit; one lowercase line each, no trailers.

---

## Testing

- **Contract suite** (`packages/shared/src/contractTests.ts`, run against stub + backend): create/list
  order, update bumps `updatedAt` and reorders, empty S/A/R default to `''`, soft-deleted stories don't
  list, update-on-deleted rejects.
- **Backend** (node env, `lambdas/src/backend.test.ts`) — a tombstone row survives `deleteStory` in the table yet drops from
  `listStories` (the "tell a tombstone from absence" check [../TECH.md](../../arch/TECH.md)'s tech-debt entry wants
  for any new delete path).
- **App** (jsdom) — `Recruiting.test.tsx` kept its four cases and added tab-is-a-link + deep-link;
  `StoryBank.test.tsx`: create / title-required / focus-return / edit / delete-asks-first / loading + error
  states — i.e. the tab deep-links; create/edit/delete round-trips through the list; cancel returns
  focus and drops the draft.
