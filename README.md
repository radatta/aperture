# Aperture

A personal life-OS PWA — one place for everything digital in one person's life. Web-first, installable, multi-device.

Aperture exists to make its user **calmer and more honest about their time**, not just to log more output. Its #1 job is a morning + night ritual (glance, plan, reflect), with the signature move being **calibration** — surfacing the gap between what a task was _estimated_ to take and what it _actually_ took, so under-scoping gets caught instead of repeated.

Not a mood tracker, not a habit-shaming app, not a productivity cult. Balance is invited, never policed.

---

## Status

Built and in daily use. The current build status — phases, test count, what's still open — is the block at the top of [`docs/index.md`](docs/index.md).

## Develop

Requires **Node 22** (see `.nvmrc`) and **pnpm** (`corepack enable pnpm`).

```bash
pnpm install       # install the workspace
pnpm dev           # run the app (Vite) → localhost:5173 (6173 inside a COI container)
pnpm typecheck     # tsc -b across all packages (project references)
pnpm lint          # eslint (flat config)
pnpm test          # vitest across all packages
pnpm build         # production build
```

Monorepo layout: `app/` (React PWA) · `lambdas/` (BFF) · `cdk/` (infra) · `packages/shared/` (the cross-cutting contract) · `scripts/`.

### Sandboxed dev (COI / Incus)

Claude Code runs against this repo inside an Incus container — see
**[docs/ops/COI-SANDBOX.md](docs/ops/COI-SANDBOX.md)** for the runbook and
**[docs/ops/COI-INCIDENTS.md](docs/ops/COI-INCIDENTS.md)** for the post-mortems. Four rules that will bite
you otherwise, each with its home:

1. **Always exit the TUI cleanly** (`Ctrl+D` / `/exit`) before you walk away, then `coi shutdown` — an
   abrupt kill leaves your local terminal with mouse reporting on. COI-INCIDENTS → _Symptom: your
   prompt fills with `35;97;27M`-style garbage_.
2. **Unattended runs need AC power, and `caffeinate` is not enough** — the lid sleeps the Mac
   regardless, and a flat battery hibernates it. COI-INCIDENTS §B.2 (the lid) + _Third kill mechanism:
   a flat battery_; the lid-open / clamshell / Amphetamine options table is in COI-SANDBOX → _Run_.
3. **`node_modules` is shared with the host** — a native-binding error from `vite` usually means the
   other platform installed last, not a port clash. `CLAUDE.md` → Commands; COI-INCIDENTS → _Related:
   the shared `node_modules` hazard_.
4. **Ports are split by owner:** `5173+` is your Mac, `6173+` is a container. COI-SANDBOX → _Ports_.

## What it does (v1)

- **Glanceable home** — auto morning / day / night by clock, ≤5 things per mode. Home is glance; deep views are work.
- **Global capture bar** — always present, frictionless in.
- **Tasks + calibration** — the signature module. Estimate freezes when work starts; calibration is `actual` vs `frozen estimate`. Multi-day scheduling, recurrence, categories.
- **Pomodoro** — persistent heartbeat-backed timer that follows you across views; pauses excluded; only work sessions accrue.
- **Rolls** — deadline-free ongoing efforts with a forgiving momentum "contact sheet" (fills, never a resetting streak).
- **Log / journal**, **habits**, **inbox** (idea triage), **settings**.

## Stack

React + Vite + TypeScript PWA on an **AWS-native serverless BFF**. The one-paragraph shape is
[`CLAUDE.md`](CLAUDE.md) → Architecture; the blueprint is [`docs/arch/INFRA.md`](docs/arch/INFRA.md)
(§4 for the Function URL + origin-secret edge, §11 for why it costs effectively $0 at single-user
scale). Multi-device sync is **structural** — laptop and phone hit the same table under the same
identity ([`docs/arch/TECH.md`](docs/arch/TECH.md) §1).

## Conventions

**pnpm only**, one test runner (Vitest, Node parity for the Lambda), first-principles dependency
discipline — the full rules are [`docs/product/CONVENTIONS.md`](docs/product/CONVENTIONS.md); the
load-bearing ones are repeated in `CLAUDE.md`.

Docs: [`docs/index.md`](docs/index.md).
