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
- **Decide when we get there:** ULID generation — small, but ID correctness (monotonicity, base32, entropy) is subtle; evaluate under A/B at the point of need.

---

## Build order: page-first, backend-second

Build the `app/` against a **stubbed API first** — validate the home modes, the capture flow, and the calibration UX feel right in-hand — **then** wire the Lambda + DynamoDB behind the same contract.

Rationale: it's far cheaper to discover the product is wrong against a stub than against real infra.
