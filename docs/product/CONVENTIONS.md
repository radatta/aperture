# Aperture — Conventions & Principles

Cross-cutting rules that override defaults everywhere in this repo.

---

## Package manager: pnpm, always

**pnpm is the only package manager. Never npm or yarn.** `pnpm install`, `pnpm run`, `pnpm -r` (workspaces), `pnpm dlx` (npx replacement).

- Chosen over npm (kills the slow-install pain) and over Bun (Node-runtime **test parity** for the Lambda, first-class CDK `NodejsFunction` support, strict/correct dep resolution, zero ecosystem edges).
- Node is the runtime everywhere — local scripts, tests, and Lambda. pnpm is purely the package manager; Vite bundles the app, esbuild-via-CDK bundles the Lambda.
- **Test runner: Vitest** — one runner across the whole repo: Vite-native for `app/`, and running on **Node** for `lambdas/` so tests match the Lambda's prod runtime exactly.

---

## First-principles: build it ourselves by default

**Default to rolling our own.** Most small utilities are less code than the dependency's own footprint, and third-party libs drag bloat, transitive deps, and maintenance/security surface we don't need.

**Only propose adding a dependency when EITHER:**
- **(A)** it's a substantial amount of code/logic not worth the time/effort to implement and maintain ourselves, **OR**
- **(B)** it's logic we should **not** implement ourselves for a good reason — security-critical, subtle correctness we'd likely get wrong, or hard standards/cross-platform edge cases.

When proposing a dep, **justify against A/B explicitly**, note its footprint + transitive deps, and state the roll-our-own alternative. **"It's popular" is not a reason.**

**Worked calls (applying the rule):**
- **Justified (B):** `react-oidc-context` — OIDC/PKCE + token refresh is subtle and security-critical.
- **Roll our own:** date helpers — day-start offset + ISO-week cadence are small and targeted; hand-roll them. Only reach for a date lib if DST edge cases prove genuinely gnarly.
- **Rolled our own (decided at the point of need):** ULID generation — small, but ID correctness (monotonicity, base32, entropy) is subtle; hand-rolled at `packages/shared/src/ulid.ts` (+ `ulid.test.ts`), reasoning in `V1_PLAN.md` §B.

---

## Build order: page-first, backend-second

Build the `app/` against a **stubbed API first** — validate the home modes, the capture flow, and the calibration UX feel right in-hand — **then** wire the Lambda + DynamoDB behind the same contract.

Rationale: it's far cheaper to discover the product is wrong against a stub than against real infra.

---

## Monorepo: internal packages resolve from source

Workspace packages export **TypeScript source**, not built JS. `@aperture/shared` sets
`"exports": "./src/index.ts"`; `app` and `lambdas` import it directly and their bundler (Vite / esbuild)
transpiles it — **no build step in the dev or test loop**. `shared` still emits a **gitignored `dist/`**
purely to satisfy TS project references, which forbid a *referenced* composite project from disabling
emit (error TS6310). Nothing imports that `dist/` — if you're wondering why it exists, that's why.

**Command shape:** typecheck is one root `tsc -b` over the project-reference graph; lint is one root
`eslint .` (flat config). `test` and `build` fan out per-package (`pnpm -r`). Vitest runs two envs —
**jsdom** for `app`, **node** for everything else (Lambda runtime parity).

**App test files share one jsdom and one module graph per worker** (`isolate: false` — a fresh jsdom
per file was most of CI's runtime when it ran a single worker; CI now runs two via `VITEST_MAX_WORKERS`
in `ci.yml`, so which files share a graph is random per run). So:

- **New module-level state in `app/src`** (a singleton, cache, or `let`) needs a reset in
  `app/src/test/setup.ts`'s `afterEach`, or it leaks into the next file.
- **A test file that uses `vi.resetModules` / `vi.doMock`** belongs in the `isolated` project in
  `app/vitest.config.ts`.
- **File order is shuffled every run.** A failure that comes and goes is order-dependence; the seed is
  printed — reproduce with `--sequence.seed=<n>`.

Lint and typecheck are cached (ESLint `--cache-strategy content`, `tsc -b`'s `.tsbuildinfo`, restored in
CI). The ESLint cache is only safe because no rule is type-aware — enabling `recommendedTypeChecked`
means dropping `--cache`.

## UI: colour tiers, one dock, and the focus-return contract

These are cross-cutting rules for `app/` — they were paid for once and are easy to undo by accident.

**Colour tiers are a contrast contract, not a taste.** `app/src/styles/tokens.css` is solved against
WCAG, not eyeballed:

- `ink`, `ink-muted`, `teal`, `gold`, `danger` **carry content** and clear **4.5:1 on all three
  grounds** (`surface`, `panel`, `panel-2`).
- `ink-subtle` clears **3:1 only**. It is **supplementary**: de-emphasised metadata, column headers,
  separators. **Nothing a reader needs may use it** — not placeholders, not hints, not the sentence
  in an empty state (which is often the only text on screen).
- `line-strong` is opaque and clears 3:1 on `panel`, because it is the *sole* carrier of an unchecked
  habit cell. `line` is a decorative hairline between surfaces that also differ by fill, so it is
  deliberately below 3:1.

Two traps: **don't stack `opacity-*` on `ink-subtle`** (it composites below 3:1 and a
computed-colour audit won't catch it), and **keep the dark `panel` steps small** — a lighter raised
ground crushes contrast for everything sitting on the dock.

**The bottom dock is one element.** `AppShell` renders a single fixed column holding the timer stack
above the capture bar. Never add a second `fixed` bottom-anchored element — that is exactly how the
timers ended up covering the capture bar and the page's last card. The shell measures the dock
(`offsetHeight`, *not* `contentRect`, which excludes `pb-safe`) and reserves that much bottom
padding, because the dock's height varies from ~112px idle to ~400px with several timers and a
wrapped capture. The column is `pointer-events-none`; each **panel** opts back in. With the on-screen
keyboard up **and focus in the dock**, `lib/useKeyboardInset` lifts it by the gap below
`visualViewport`: iOS Safari doesn't resize the page for the keyboard, so a plain `bottom: 0` sits
behind it and anything below the caret — capture's token chips and preview row — was hidden (seen
2026-10-04). Only while the dock has focus (lifting for a page field's keyboard would cover that
field), never when pinch-zoomed, and capped to the visible strip, clipping the dock's top (timers)
in landscape.

**Anything that dismisses something returns focus to what opened it.** `components/Menu` and
`lib/useDisclosure` both hold this: a collapsed form's trigger, and a menu's trigger, are re-focused
on close — except when the action removed that trigger (a destructive row action), where focus is
left alone rather than aimed at a node about to unmount, or handed to the list container
(`useRowAction`, `TaskModalHost`) — never `<body>`. After a mouse/touch close `useDisclosure` returns
focus without the ring (only Tab counts as keyboard navigation). If you add another popover or
collapse-in-place control, use `useDisclosure` rather than a bare `useState`. When the focused
element itself disappears (a banner that clears, a list row that re-renders), a page can install
`lib/useFocusRescue` as the backstop: a frame later, if focus fell to `<body>`, it goes to the page's
chosen fallback. Move focus with `lib/focus` `revealFocus`, which scrolls the target clear of the dock
(the dock publishes its height as `--dock-h`, the root's `scroll-padding-bottom`).

**Page keyboard shortcuts** skip typing targets (`lib/keys` `isTypingTarget`), open dialogs, modified
keys and keys already handled (`defaultPrevented`). `/` belongs to capture (CaptureBar) unless a page
has its own search, which claims it in the capture phase — today only the Finances All tab.

**Empty states go through `components/EmptyState`.** React Query defaults `data` to `[]`, so
branching on `list.length === 0` alone asserts "Backlog is clear" while the query is still in flight.
`EmptyState` takes `pending`/`error` and is the one place that knows the three states.
