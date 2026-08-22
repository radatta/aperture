# Aperture

A personal life-OS PWA — one place for everything digital about me. Web-first, installable, multi-device.

Aperture exists to make me **calmer and more honest with myself**, not just to log more output. Its #1 job is a morning + night ritual (glance, plan, reflect), with the signature move being **calibration** — surfacing the gap between what I *thought* a task would take and what it *actually* took, so I stop under-scoping my own life.

Not a mood tracker, not a habit-shaming app, not a productivity cult. Balance is invited, never policed.

---

## Status

**Foundation built — Phase 0 (2026-08-03).** The pnpm monorepo installs, typechecks, lints, tests, builds, and serves — green end to end. No product code yet; Phases 1–14 of [`docs/V1_PLAN.md`](docs/V1_PLAN.md) remain. Specs (product, technical, infra) are complete — start at [`docs/index.md`](docs/index.md).

Build order is **page-first, backend-second**: the app runs against a stubbed API and the whole UX gets validated in-hand before any Lambda or DynamoDB is wired. Next up is **Phase 1** — the shared `ApiClient` contract + in-memory stub.

## Develop

Requires **Node 22** (see `.nvmrc`) and **pnpm** (`corepack enable pnpm`).

```bash
pnpm install       # install the workspace
pnpm dev           # run the app (Vite) → localhost:5173
pnpm typecheck     # tsc -b across all packages (project references)
pnpm lint          # eslint (flat config)
pnpm test          # vitest across all packages
pnpm build         # production build
```

Monorepo layout: `app/` (React PWA) · `lambdas/` (BFF) · `cdk/` (infra) · `packages/shared/` (the cross-cutting contract) · `scripts/`.

### Sandboxed dev (COI / Incus)

Claude Code runs against this repo inside an Incus container — see
**[docs/COI-SANDBOX.md](docs/COI-SANDBOX.md)** for the runbook and
**[docs/COI-INCIDENTS.md](docs/COI-INCIDENTS.md)** for the post-mortems. Three rules that will bite you
otherwise:

1. **Always exit the TUI cleanly** (`Ctrl+D` / `/exit`) before you walk away, then `coi shutdown`.
   Killing it abruptly — by closing the laptop lid, dropping the connection, or closing the window —
   leaves your *local terminal* with mouse reporting still on, so your prompt fills with
   `35;97;27M` garbage. Clean exit costs nothing and prevents it entirely.
2. **Unattended runs need AC power, and `caffeinate` is not enough.** `caffeinate` blocks idle sleep
   only; closing the lid sleeps the Mac regardless. Lid open + `caffeinate -s`, or clamshell mode /
   Amphetamine's closed-display option if the lid must shut. A flat battery hibernates the Mac and
   nothing prevents that.
3. **`node_modules` is shared with the host** (`/workspace` is a virtiofs mount and `node_modules`
   isn't separately mounted), so native binaries belong to whichever side installed last. If
   `vite dev` dies with `Cannot find module '../lightningcss.*.node'`, run `pnpm install` on the side
   you're using. Inside the container that needs `CI=true pnpm install`.

## What it does (v1)

- **Glanceable home** — auto morning / day / night by clock, ≤5 things per mode. Home is glance; deep views are work.
- **Global capture bar** — always present, frictionless in.
- **Tasks + calibration** — the signature module. Estimate freezes when work starts; calibration is `actual` vs `frozen estimate`. Multi-day scheduling, recurrence, categories.
- **Pomodoro** — persistent heartbeat-backed timer that follows you across views; pauses excluded; only work sessions accrue.
- **Log / journal**, **habits**, **inbox** (idea triage), **settings**.

## Stack

React + Vite + TypeScript PWA on an **AWS-native serverless BFF**:

```
React PWA (S3 + CloudFront) --Cognito JWT--> Lambda Function URL (OAC) --> DynamoDB
```

Same-origin `/api/*` via CloudFront OAC (no CORS), in-handler Cognito JWT validation, single-table DynamoDB (PITR + RETAIN), CDK IaC, GitHub Actions + OIDC (no static creds), dev + prod. Multi-device sync is **structural** — laptop and phone hit the same table under the same identity.

Cost is effectively $0 at single-user scale.

## Conventions

- **pnpm only** — never npm or yarn.
- **Vitest** — one test runner, Node everywhere for Lambda parity.
- **First-principles dependency discipline** — roll our own by default; a dep needs an explicit (A) substantial-hard-to-own-logic or (B) security-critical/subtle-correctness justification. *Popular is not a reason.*
- Full rules in [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).

## Docs

| Doc | What |
|---|---|
| [`docs/index.md`](docs/index.md) | Doc index — start here |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | What Aperture is and how it feels (source of truth) |
| [`docs/TECH.md`](docs/TECH.md) | Architecture, data model, routing/state, folder structure |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Cross-cutting rules |
| [`docs/INFRA.md`](docs/INFRA.md) | AWS blueprint |
| [`docs/V1_PLAN.md`](docs/V1_PLAN.md) | Sequenced v1 work breakdown |
