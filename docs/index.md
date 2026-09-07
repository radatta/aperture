# Aperture — docs index

Personal life-OS PWA. Web-first, installable. AWS-native serverless.

**Build status (2026-08-11):** V1_PLAN phases **0–14 built**, all six packages green (236 tests). Open items are the two things that aren't code: the **9.2 stub-validation gate** (dogfood a real morning + night) and confirming **prod / the custom domain is actually live**. See V1_PLAN's build-status block.

- **[PRODUCT.md](PRODUCT.md)** — what Aperture is and how it feels. Identity, capture mechanic, glanceable home, modules, aesthetic, v1 non-goals. Product is the source of truth.
- **[TECH.md](TECH.md)** — how it's built. Stack/architecture (AWS serverless BFF), data model (logical + single-table DDB), routing/state, folder structure, AI seam.
- **[CONVENTIONS.md](CONVENTIONS.md)** — cross-cutting rules: **pnpm only**, first-principles/dependency discipline, page-first build order, and the UI contracts (colour tiers vs WCAG, the single bottom dock, focus-return on dismiss, empty states).
- **[V1_PLAN.md](V1_PLAN.md)** — the sequenced v1 work breakdown: 15 phases (workspace → stub-validated UX → real backend → auth → infra → domain last), order-sensitive decisions, dependency ledger, and the v1 definition of done. **Phases 0–14 built (2026-08-11)** — see the build-status block at the top for what's still open, and each phase's "as built" note for toolchain pins + gotchas.
- **[INFRA.md](INFRA.md)** — the AWS blueprint: dev+prod, CDK stack split, Lambda Function URL + CloudFront OAC, Cognito, DynamoDB, GitHub OIDC CI, and the deferred Porkbun/ACM custom-domain step.
- **[CICD_HARDENING.md](CICD_HARDENING.md)** — planned CI/CD + ops additions (all $0): deploy notifications (ntfy), cdk-nag, gitleaks, Dependabot, CloudWatch alarms, post-deploy synthetic check, AWS budget/anomaly. Grounded per-item plan with a manual-prereq checklist. Read before implementing any of the seven.
- **[COI-SANDBOX.md](COI-SANDBOX.md)** — the **runtime playbook** for running Claude Code on this repo inside an Incus container (day + night profiles): the Lima→Incus stack, one-time setup, the four config files, how to start and — importantly — how to *end* a session, the **port convention** (5173+ you, 6173+ container), plus a one-line index of every known failure signature.
- **[COI-INCIDENTS.md](COI-INCIDENTS.md)** — post-mortems for the sandbox failures that cost hours, kept out of the playbook so it stays short. `SIGABRT (134)` from pids-cgroup exhaustion; a 13-hour unattended run killed by `'Clamshell Sleep'` (and why `caffeinate` doesn't prevent it); the mount change that restarts the whole VM; the shared-`node_modules` hazard. Includes the full log map, the ruled-out hypotheses, and the broken commands not to repeat.
