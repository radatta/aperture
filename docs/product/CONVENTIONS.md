# Aperture — Conventions & Principles

Cross-cutting rules that override defaults everywhere in this repo.

---

## Package manager: pnpm, always

**pnpm is the only package manager. Never npm or yarn.** `pnpm install`, `pnpm run`, `pnpm -r` (workspaces), `pnpm dlx` (npx replacement).

- Chosen over npm (kills the slow-install pain) and over Bun (Node-runtime **test parity** for the Lambda, first-class CDK `NodejsFunction` support, strict/correct dep resolution, zero ecosystem edges).
- Node is the runtime everywhere — local scripts, tests, and Lambda. pnpm is purely the package manager; Vite bundles the app, esbuild-via-CDK bundles the Lambda.
- **Versions:** pnpm's comes only from `packageManager` in the root `package.json`, via corepack — CI resolves it from that field, so never pin it a second time in a machine-global tool manager (the mise trap: [COI-SANDBOX](../ops/COI-SANDBOX.md) → _Start here_ → 1). Node is 22, from `.nvmrc`.
- **Formatting: Prettier.** `main` is Prettier-clean (since PR 135, 2026-11-08): format the files a change touches, and `pnpm format:check` stays at zero findings. It is not a CI gate — CI runs lint, typecheck and tests.
- **Test runner: Vitest** — one runner across the whole repo: Vite-native for `app/`, and running on **Node** for `lambdas/` so tests match the Lambda's prod runtime exactly.

---

## No personal identifiers in tracked text

The repo is public. No code, doc, test, fixture, commit message, PR title or PR body names the maintainer, their personal mailbox, a Mac home path, the Mac projects folder or an AWS account id: prose says **"the maintainer"**, the Mac path is `<mac-repo>`, and `identifiers.json` is the one tracked home for the public values code needs. A test, the commit hook, `pnpm bot push` and `pnpm mailroom open-pr` enforce it. Rules, readers and the one exception: [`docs/ops/IDENTIFIERS.md`](../ops/IDENTIFIERS.md). The judgment half — no life-stage bio, real money, school identifiers, family or verbatim quotes; product voice, never first person — is [`docs/ops/PUBLIC-CONTENT.md`](../ops/PUBLIC-CONTENT.md).

## First-principles: build it ourselves by default

**Default to rolling our own.** Most small utilities are less code than the dependency's own footprint, and third-party libs drag bloat, transitive deps, and maintenance/security surface we don't need.

**Only propose adding a dependency when EITHER:**

- **(A)** it's a substantial amount of code/logic not worth the time/effort to implement and maintain ourselves, **OR**
- **(B)** it's logic we should **not** implement ourselves for a good reason — security-critical, subtle correctness we'd likely get wrong, or hard standards/cross-platform edge cases.

When proposing a dep, **justify against A/B explicitly**, note its footprint + transitive deps, and state the roll-our-own alternative. **"It's popular" is not a reason.**

**Worked calls (applying the rule):**

- **Justified (B):** `react-oidc-context` — OIDC/PKCE + token refresh is subtle and security-critical.
- **Roll our own:** date helpers — day-start offset + ISO-week cadence are small and targeted; hand-roll them. Only reach for a date lib if DST edge cases prove genuinely gnarly. They live in `packages/shared/src/dates.ts`, and every date/time goes through them: never inline `Date` math or raw ISO strings in a component.
- **Rolled our own (decided at the point of need):** ULID generation — small, but ID correctness (monotonicity, base32, entropy) is subtle; hand-rolled at `packages/shared/src/ulid.ts` (+ `ulid.test.ts`), reasoning in `V1_PLAN.md` §B.

The v1 verdicts are the ledger in [`V1_PLAN.md` §B](../V1_PLAN.md#b-dependency-ledger--first-principles-discipline-conventions). It has no row for dependencies added since — the self-hosted font and the later AWS SDK clients (S3, SSM, Lambda) among them.

---

## Build order: page-first, backend-second

Build the `app/` against a **stubbed API first** — validate the home modes, the capture flow, and the calibration UX feel right in-hand — **then** wire the Lambda + DynamoDB behind the same contract.

Rationale: it's far cheaper to discover the product is wrong against a stub than against real infra.

---

## BFF writes: one `writes` object

Every external write (POST / PUT / PATCH / DELETE) a Lambda handler makes is declared in one `writes` object at the top of the handler and nowhere else; helpers call the functions passed in through it, never a write API directly. One audit point, and a guarantee that no write fires during a test or smoke run. This is the rule's home; INFRA §4 points here, and the code-reviewer checks every handler against it.

---

## Monorepo: internal packages resolve from source

Workspace packages export **TypeScript source**, not built JS. `@aperture/shared` sets
`"exports": "./src/index.ts"`; `app` and `lambdas` import it directly and their bundler (Vite / esbuild)
transpiles it — **no build step in the dev or test loop**. `shared` still emits a **gitignored `dist/`**
purely to satisfy TS project references, which forbid a _referenced_ composite project from disabling
emit (error TS6310). Nothing imports that `dist/` — if you're wondering why it exists, that's why.

**Command shape:** typecheck is one root `tsc -b` over the project-reference graph; lint is one root
`eslint .` (flat config). `test` and `build` fan out per-package (`pnpm -r`). Vitest runs two envs —
**jsdom** for `app`, **node** for everything else (Lambda runtime parity). Each suite also pins its
runtime's zone in its `vitest.config.ts`, whatever the shell's or CI's: `lambdas` UTC (the Lambda's),
`app` `America/Los_Angeles` (the user's browser), so a local-time date bug fails in tests and not only
in prod. A `tz.test.ts` in each guards its pin.

**App test files share one jsdom and one module graph per worker** (`isolate: false` — a fresh jsdom
per file was most of CI's runtime on its single worker). CI runs the suite as two `vitest --shard`
halves (`ci.yml`), assigned by a hash of each file's path, so a file's CI shard-mates stay fixed until a
file is added or removed; locally, vitest's several workers mix them differently every run. The cost:
CI no longer runs every file in one graph, so a leak from one file into another in the other shard
can only show up in a local run, and only when vitest's workers happen to pair the two files — and since
`pnpm gate:fast` (2026-11-17) a lane runs only the files its diff reaches, so fewer such pairings
(`docs/ops/GATE.md` → _What is weaker_; `pnpm gate:fast --full` runs them all). So:

- **New module-level state in `app/src`** (a singleton, cache, or `let`) needs a reset in
  `app/src/test/setup.ts`'s `afterEach`, or it leaks into the next file — and its module joins the gate's
  setup-imports rule (`scripts/src/gate/rules.ts`; `rules.test.ts` names it if missed).
- **A test file that uses `vi.resetModules` / `vi.doMock`** belongs in the `isolated` project in
  `app/vitest.config.ts`.
- **File order is shuffled every run.** A failure that comes and goes is order-dependence; the seed is
  printed — reproduce with `--sequence.seed=<n>`.

**The console guard: in `app` and `lambdas`, a test that reaches `console.error` or `console.warn` fails** —
jsdom's own errors ("Not implemented: …") included, which `app/src/test/guard.ts` routes in (the guard:
`packages/shared/src/consoleGuard.ts`). It sees only those two console methods — `process.emitWarning` and a direct `process.stderr.write` still print
unguarded — and a call after a worker's last check is recorded and dropped, never shown. A test that expects the output spies it with `mockImplementation` and
asserts on it; jsdom-only gaps get a per-file stub (`app/src/test/canvas.ts`). `lambdas` prints its handlers'
`console.log` lines only for a failing test (`silent: 'passed-only'`). React's act() checking stays off in `app`
(no vitest globals); a file that drives `act()` itself sets `IS_REACT_ACT_ENVIRONMENT`, and setup resets it after
every test. Locally under Claude Code, vitest picks its `agent` reporter, which hides a passing test's logs: pass
`--reporter=default` to see what CI prints.

**Testing Library queries: `within()` changes what a query asserts.** `getBy…`/`findBy…` assert
"exactly one on the page" and a null `queryBy…` asserts "absent everywhere"; scoped, they only check
that region, so keep them on `screen`. Only `getAllBy…`/`findAllBy…`, which claim no uniqueness, can be
narrowed safely. That is worth doing when a page-wide `findAllByRole` sits inside `waitFor`/`findBy`,
because the full role + accessible-name scan repeats on every poll (70–100ms each on the Finances All
tab; see `findRows` in `app/src/pages/Finances/Finances.test.tsx`).

Lint and typecheck are cached (ESLint `--cache-strategy content`, `tsc -b`'s `.tsbuildinfo`, restored in
CI). The ESLint cache is only safe because no rule is type-aware — enabling `recommendedTypeChecked`
means dropping `--cache`.

## UI: colour tiers, one dock, and the focus-return contract

These are cross-cutting rules for `app/` — they were paid for once and are easy to undo by accident.

**Colour tiers are a contrast contract, not a taste.** `app/src/styles/tokens.css` is solved against
WCAG, not eyeballed:

- Every text token — `ink`, `ink-muted`, `ink-subtle`, `teal`, `gold`, `danger` — clears **4.5:1 on
  all three grounds** (`surface`, `panel`, `panel-2`) in both themes, and under the due-time fills too
  (a filled row draws the accents with their `--*-on-fill` shades, `dueStyle.ts`).
  `app/src/styles/tokens.test.ts` measures it, so a palette change that breaks it fails the gate.
- `ink-subtle` is the **quietest** of three text levels (ink > muted > subtle, also tested): de-emphasised
  metadata, column headers, separators. It was 3:1 "supplementary only" until 2026-11-08. Text a reader
  needs to act on (placeholders, hints, the sentence in an empty state) still takes `ink-muted` or
  stronger: that's hierarchy, not contrast.
- `line-strong` is opaque and clears 3:1 on `panel`, because it is the _sole_ carrier of an unchecked
  habit cell. `line` is a decorative hairline between surfaces that also differ by fill, so it is
  deliberately below 3:1.

Two traps: **don't stack `opacity-*` on a text token** (it composites below 4.5:1, and neither
`tokens.test.ts` nor a computed-colour audit catches it), and **keep the dark `panel` steps small** — a lighter raised
ground crushes contrast for everything sitting on the dock.

**The bottom dock is one element.** `AppShell` renders a single fixed column holding the timer stack
above the capture bar. Never add a second `fixed` bottom-anchored element — that is exactly how the
timers ended up covering the capture bar and the page's last card. The shell measures the dock
(`offsetHeight`, _not_ `contentRect`, which excludes `pb-safe`) and reserves that much bottom
padding, because the dock's height varies from ~112px idle to ~400px with several timers and a
wrapped capture. A route can drop the capture bar (never the timers) with `handle: { hideCapture: true }`
(`lib/routeHandle.ts`) — the Flux exercise stage does; the dock stays one element. The column is
`pointer-events-none`; each **panel** opts back in. With the on-screen
keyboard up **and focus in the dock**, `lib/useKeyboardInset` lifts it by the gap between
`visualViewport`'s bottom and `window.innerHeight`: iOS Safari doesn't resize the page for the
keyboard, so a plain `bottom: 0` sits behind it and anything below the caret — capture's token chips
and preview row — was hidden (seen 2026-10-04). `innerHeight`, not `documentElement.clientHeight`:
in a Safari tab the latter is the static ICB with the toolbars shown, so once they collapsed the gap
read short and the chips sat behind the keyboard (2026-11); the PWA has no toolbars and the two agree
there. A gap a desktop scrollbar could explain (≤ 24px — `innerHeight` counts one, the visual viewport
doesn't) is no lift. Only while the dock has focus (lifting for a page field's keyboard would cover that
field), never when pinch-zoomed, and capped to the visible strip, clipping the dock's top (timers)
in landscape. On the iOS 27 Simulator's standalone app the hook applied no lift in any 2026-11-08 dev run: there
`innerHeight` shrank to `visualViewport.height` with the keyboard up (541 of 894 pt, `offsetTop` 353), so the gap
was negative, and WebKit itself kept the fixed dock above the keyboard. **Still live:** on a long, scrolled
page the dock can sit ~60 pt low, on the accessory bar (PR 118's sim, 2026-11-07; again in 1 of 5 long-page runs on
2026-11-08, main's code). The `ios-standalone` row `capture-long-page` measures the field at focus, after the Task switch and after a
Review, then the preview row; a low reading there is needs-you naming the issue, not a fail, until the closed-loop
lift fix (a follow-up) lands and makes it a fail again. A dock low enough to hide the field entirely (≳ 90 pt) would
still fail as a miss. The top edge has one rule too: the installed PWA draws under the status bar, so a
top-pinned element offsets by `--safe-top` (`index.css`; `top-[var(--safe-top)]`), never a raw
`top-0` — the All tab's armed Sort-into bar sat under the clock that way (2026-11-05). A scroll margin
(`scroll-mt-*`) does **not** add it: `html`'s `scroll-padding-top` already carries the inset, and the
two are additive.

**Text fields are 16px or larger.** iOS Safari zooms the page into any `input`, `textarea` or `select`
under 16px the moment it's focused, and stays zoomed. So no `text-sm`/`text-xs` on a field (`Field`
inherits the 16px base). Headless Chromium never zooms, so only a real iPhone catches this (seen
2026-10-29 on the Finances search box). UI passes run at 440 and 390 (`run-app` skill → _Phone pass_, which
also says what a headless pass can't prove).

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

**Failed reads never fail silently.** A read that fails must never show as an empty list, a default or a
confident zero: not "No habits yet", not "14h longest free stretch" for an unread calendar, not a category
picker offering only "Uncategorized". It says what didn't load, as an alert with a Retry (the query's
`refetch`): `components/LoadError` inline, or `EmptyState`'s `error` + `onRetry` for a list. An error counts
only when there's nothing to show (`isError && data === undefined`); a failed background refetch keeps the data
on screen and says nothing. A field whose value didn't load is disabled, not empty, because typing into it would
save over what you were never shown (Intent, capacity, the category picker). A label resolver that can't say it
per item (CategoryTag) marks the gap (a "—" pill), and the page's own error line, where the page has one, carries the Retry. Retries:
the http client retries a **429** for every call, writes included (`app/src/data/retry.ts`: Lambda refused to
start, so the call never ran; no RPC the app calls gets a 429 from the BFF itself), with the backoff set there; there is no
client-side cap on calls in flight. The query layer
retries a **5xx or a dropped connection on reads only**, because a write that may have landed must show its
error, not run twice. A Pomodoro call that fails says so on its row in the dock, and a failed `stop()` rejects
and keeps the timer. Reads run with `networkMode: 'always'`, so offline they fail and say so instead of pausing
on "Loading…". Writes through `useMutation` keep TanStack's `'online'`: once the browser reports offline, a write is
paused and resumed on reconnect (`resumePausedMutations`); one started before the browser notices, or at an
offline launch, fails and takes its error path. Direct `api.*` writes (Pomodoro) aren't held.
