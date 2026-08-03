# Aperture

A personal life-OS PWA — one place for everything digital about me. Web-first, installable, multi-device.

Aperture exists to make me **calmer and more honest with myself**, not just to log more output. Its #1 job is a morning + night ritual (glance, plan, reflect), with the signature move being **calibration** — surfacing the gap between what I *thought* a task would take and what it *actually* took, so I stop under-scoping my own life.

Not a mood tracker, not a habit-shaming app, not a productivity cult. Balance is invited, never policed.

---

## Status

**Pre-build.** Product + technical + infra specs are complete; implementation hasn't started. The blueprint lives in [`docs/`](docs/) — start at [`docs/index.md`](docs/index.md).

Build begins at **Phase 0** of [`docs/V1_PLAN.md`](docs/V1_PLAN.md) (pnpm workspace scaffolding). Build order is **page-first, backend-second**: the app runs against a stubbed API and the whole UX gets validated in-hand before any Lambda or DynamoDB is wired.

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
