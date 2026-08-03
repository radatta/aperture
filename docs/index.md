# Aperture — docs index

Personal life-OS PWA. Web-first, installable. AWS-native serverless.

- **[PRODUCT.md](PRODUCT.md)** — what Aperture is and how it feels. Identity, capture mechanic, glanceable home, modules, aesthetic, v1 non-goals. Product is the source of truth.
- **[TECH.md](TECH.md)** — how it's built. Stack/architecture (AWS serverless BFF), data model (logical + single-table DDB), routing/state, folder structure, AI seam.
- **[CONVENTIONS.md](CONVENTIONS.md)** — cross-cutting rules: **pnpm only**, first-principles/dependency discipline, page-first build order.
- **[V1_PLAN.md](V1_PLAN.md)** — the sequenced v1 work breakdown: 15 phases (workspace → stub-validated UX → real backend → auth → infra → domain last), order-sensitive decisions, dependency ledger, and the v1 definition of done.
- **[INFRA.md](INFRA.md)** — the AWS blueprint: dev+prod, CDK stack split, Lambda Function URL + CloudFront OAC, Cognito, DynamoDB, GitHub OIDC CI, and the deferred Porkbun/ACM custom-domain step.
