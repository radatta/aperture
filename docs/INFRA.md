# Aperture — Infrastructure

The AWS blueprint behind `TECH.md`. All IaC via **CDK**. Region: **`us-east-1`** everywhere (also where the CloudFront ACM cert must live — avoids cross-region cert wiring).

---

## 1. Shape

```
GitHub Actions ──(OIDC, no static keys)──► cdk deploy + app build/deploy

        ┌──────── CloudFront (per env, HTTPS) ────────┐
        │   default behavior → S3   (React PWA, OAC)  │
        │   /api/*            → Lambda Function URL    │  (public; secret header)
        └──────────────────────────────────────────────┘
              │                              │
            S3 (static)              Lambda BFF (1, multi-route)
                                            │  validates Cognito JWT in-handler
                                            ▼
                                     DynamoDB (single table, on-demand, PITR)

   Cognito User Pool (per env, invite-only, PKCE SPA client) ──JWT──► the app
```

---

## 2. Environments — dev + prod

Two isolated copies of everything, so changes can be tested before touching real data.

- Stacks per env: `ApertureData-{dev,prod}` + `ApertureApp-{dev,prod}`.
- Isolated resources per env: DynamoDB table (`aperture-dev` / `aperture-prod`), Cognito User Pool, Lambda, S3 bucket, CloudFront distro.

---

## 3. CDK stacks — split stateful from replaceable

- **`ApertureData-<env>`** — DynamoDB table + Cognito User Pool. `removalPolicy: RETAIN`, deployed rarely, protected from teardown. *(Precious: your data + your identity.)*
- **`ApertureApp-<env>`** — Lambda + Function URL + S3 + CloudFront (+ ACM cert reference, added at domain step). Redeploys freely; nothing precious.

Rationale: never let an app redeploy endanger the stateful resources.

---

## 4. Compute & API

- **One multi-route BFF Lambda** per env (all routes in a single handler). Node 22 runtime, esbuild-bundled via CDK.
- **Lambda Function URL**, auth type `AWS_IAM`, fronted by **CloudFront OAC** → the raw URL can't be called directly, only through CloudFront.
- **Auth:** validate the Cognito JWT **in-handler** (JWKS signature + issuer/expiry), extract `sub` → `userId` scoping every DynamoDB item.
- Config: ~15s timeout, 512 MB, **no warming** (single user — cold starts are fine). Env vars: `TABLE_NAME`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `STAGE`.
- **Writes-object pattern** enforced (single audit point for all side effects; guarantees no writes during smoke tests).
- **Recurrence generation: lazy on read** — when a day loads, materialize any due `taskSeries` occurrences. No cron/EventBridge.

## 5. Data — DynamoDB

Single table per env (`aperture-<env>`), **on-demand** billing, **PITR on** (35-day continuous backup — the safety net), `RETAIN`. Keys/GSI per `TECH.md §2.4`. One GSI (calibration). Reads/aggregation in the Lambda.

## 6. Auth — Cognito

- **One User Pool per env.** Self-signup **OFF** (invite-only; you admin-create your own user). MFA optional.
- **App client:** SPA type, PKCE, no secret. Callback URLs = the env's app URL (CloudFront default first, custom domain added later).
- **Hosted UI** on a Cognito domain prefix (e.g. `aperture-dev.auth.us-east-1.amazoncognito.com`) — free, independent of the app's custom domain. Google IdP optional.
- Frontend: `react-oidc-context` + Hosted UI.

## 7. Hosting & CDN

- **S3** (private) + **CloudFront** per env. Default behavior → S3; `/api/*` → Function URL origin (OAC). **SPA fallback:** 403/404 → `/index.html` for client-side routing.
- **Build on the CloudFront default domain first** (`*.cloudfront.net`) — HTTPS + PWA install work immediately, zero DNS. Custom domain is the last step (§8).

## 8. Custom domain — LAST STEP (deferred)

- Prod `aperture.rahuldatta.dev` · dev `dev.aperture.rahuldatta.dev`. DNS at **Porkbun** (external).
- **One-time, $0, no recurring work:** create ACM certs in **`us-east-1`** (DNS validation), add the validation CNAMEs in Porkbun once, add the CloudFront alias CNAMEs once. ACM **auto-renews** DNS-validated certs while the CNAME stays — no per-deploy, no per-renewal work.
- **Reference certs by ARN in CDK** (don't have CDK create them) → deploys never touch DNS/certs.
- Not on the critical path — wire it right before real daily use.

## 9. CI/CD — GitHub Actions, OIDC

No static credentials — OIDC role assumption. GitHub Flow, simplified:
- Feature branch → PR (lint + test only) → squash to `main`.
- `main` pipeline: lint/typecheck/test (pnpm + Vitest) → `cdk deploy ApertureData-dev` + `ApertureApp-dev` → smoke dev → build app (Vite, env from CDK outputs) → S3 sync + CloudFront invalidate → **manual approval** → same for prod.
- `dev` branch → one-off dev deploy (not a promotion step).
- OIDC trust: dev role ← `refs/heads/dev` + `refs/heads/main` (main pipeline deploys dev first); prod role ← the **`prod` GitHub environment** subject (`environment:prod`), so prod credentials are unassumable until the environment's approval gate passes — the gate is enforced at the credential layer, not just the workflow. Roles hold no direct deploy power: `cdk deploy` funnels through the account's CDK bootstrap roles; the roles get only S3-sync / CloudFront-invalidate / Lambda-invoke for their stage.
- OIDC provider + both roles live in a one-off, hand-deployed `ApertureCicd` stack (`-c githubRepo=owner/repo`); the pipeline never touches it.
- **Origin secret** reaches CI as a GitHub secret (`ORIGIN_SECRET_DEV/PROD` → `APERTURE_ORIGIN_SECRET`), so it's stable across runs.
- **Smoke tests** invoke the Lambda by **direct `aws lambda invoke`** with a `testMode` payload (synthetic user, writes-object no-ops) → no side effects, even against prod.

## 10. Secrets

- v1: none in the app path (Cognito public keys are public; no static creds anywhere).
- v1.1 AI: the model API key goes in **Secrets Manager**, fetched at Lambda cold start. Never in env vars or CDK config.

## 11. Cost

Effectively free at single-user scale: DynamoDB / Lambda / Cognito within always-free tiers; S3 + CloudFront in cents; Function URLs add no per-request cost. **No Route 53** (DNS stays at Porkbun). Only real line item: S3/CloudFront, pennies.

---

## Status
Infra direction fully specced. Remaining before build is execution, not decisions: CDK project init, per-env config wiring, GitHub OIDC role setup, and (last) the Porkbun/ACM domain step.
