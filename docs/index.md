# Aperture — docs index

Personal life-OS PWA. Web-first, installable. AWS-native serverless.

**Build status:** foundation (V1_PLAN Phase 0) built & green — 2026-08-03. Phases 1–14 pending; **Phase 1** (shared contract + stub) next.

- **[PRODUCT.md](PRODUCT.md)** — what Aperture is and how it feels. Identity, capture mechanic, glanceable home, modules, aesthetic, v1 non-goals. Product is the source of truth.
- **[TECH.md](TECH.md)** — how it's built. Stack/architecture (AWS serverless BFF), data model (logical + single-table DDB), routing/state, folder structure, AI seam.
- **[CONVENTIONS.md](CONVENTIONS.md)** — cross-cutting rules: **pnpm only**, first-principles/dependency discipline, page-first build order, and the UI contracts (colour tiers vs WCAG, the single bottom dock, focus-return on dismiss, empty states).
- **[V1_PLAN.md](V1_PLAN.md)** — the sequenced v1 work breakdown: 15 phases (workspace → stub-validated UX → real backend → auth → infra → domain last), order-sensitive decisions, dependency ledger, and the v1 definition of done. **Phase 0 built (2026-08-03)** — see its "as built" block for the toolchain pins + gotchas.
- **[INFRA.md](INFRA.md)** — the AWS blueprint: dev+prod, CDK stack split, Lambda Function URL + CloudFront OAC, Cognito, DynamoDB, GitHub OIDC CI, and the deferred Porkbun/ACM custom-domain step.
- **[CICD_HARDENING.md](CICD_HARDENING.md)** — planned CI/CD + ops additions (all $0): deploy notifications (ntfy), cdk-nag, gitleaks, Dependabot, CloudWatch alarms, post-deploy synthetic check, AWS budget/anomaly. Grounded per-item plan with a manual-prereq checklist. Read before implementing any of the seven.
- **[COI-SANDBOX.md](COI-SANDBOX.md)** — running Claude Code on this repo inside an Incus system container (day + night profiles). Read when setting up the sandbox on a new machine or debugging it: the Lima→Incus stack, one-time setup gotchas, the four config files, and the non-obvious traps (two config formats, `env_commands` auth, nft-monitor auto-pause).
