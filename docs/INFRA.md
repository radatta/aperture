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
- **Publish discipline** (`scripts/aws/publish-frontend.mjs`, used by CI + local emergency publishes): **two-pass S3 sync** — hashed `assets/*` get `max-age=31536000,immutable`; everything else (`index.html`, `sw.js`, manifest, icons) gets `no-cache,no-store,must-revalidate` so a cached shell can't point at pruned asset hashes. **PWA files get explicit `--content-type`** (`manifest.webmanifest` → `application/manifest+json`, `sw.js` → `text/javascript`) because `s3 sync` guesses by extension and an octet-stream manifest silently blocks install.

## 8. Custom domain — LAST STEP (deferred)

- Prod `aperture.rahuldatta.dev` · dev `dev.aperture.rahuldatta.dev`. DNS at **Porkbun** (external).
- **One-time, $0, no recurring work:** create ACM certs in **`us-east-1`** (DNS validation), add the validation CNAMEs in Porkbun once, add the CloudFront alias CNAMEs once. ACM **auto-renews** DNS-validated certs while the CNAME stays — no per-deploy, no per-renewal work.
- **Reference certs by ARN in CDK** (don't have CDK create them) → deploys never touch DNS/certs. The
  ARN comes from `APERTURE_CERT_ARN` (GitHub **var** `CERT_ARN_DEV`/`CERT_ARN_PROD` per stage), read in
  `cdk/src/config/domains.ts` alongside the committed domain names; the app stack takes `domainName` +
  `certificateArn` props and adds the alias + cert to CloudFront only when both are present (else stays
  on the CloudFront default domain, so pre-domain deploys are unaffected).
- **Region note:** the cert lives in **`us-east-1`** (CloudFront's hard requirement) even though the
  stacks deploy to **`us-west-1`** — referencing by ARN makes the split a non-issue.
- Not on the critical path — wire it right before real daily use.
- **Status (2026-08): LIVE.** Both stages serve on their custom domains — prod `aperture.rahuldatta.dev`,
  dev `dev.aperture.rahuldatta.dev` — on us-east-1 ACM certs (DNS-validated via Netlify/NS1 DNS, not
  Porkbun: rahuldatta.dev is registered at Porkbun but its nameservers are delegated to Netlify), referenced by ARN through the
  `CERT_ARN_*` GitHub vars. Login round-trips on both (Cognito callbacks registered for each origin).

## 9. CI/CD — GitHub Actions, OIDC

No static credentials — OIDC role assumption. GitHub Flow, simplified:
- Feature branch → PR (lint + test only) → squash to `main`.
- `main` pipeline: lint/typecheck/test (pnpm + Vitest) → `cdk deploy ApertureData-dev` + `ApertureApp-dev` → smoke dev → build app (Vite, env from CDK outputs) → S3 sync + CloudFront invalidate → **manual approval (see caveat below)** → same for prod.
- `dev` branch → one-off dev deploy (not a promotion step).
- **`dev` is a scratch deploy target, and force-pushing it is the norm.** It exists to get an arbitrary branch onto real infrastructure quickly — `git push -f origin HEAD:dev` is the intended operation, not an emergency. It is **not** an integration branch: nothing merges *from* it, its history is disposable, and whatever it points at is simply what's deployed to dev right now. So don't merge into it, don't rebase onto it, and don't build a temporary worktree to get a branch onto it — just overwrite it.
  - The one real consequence: **force-pushing `dev` overwrites whoever deployed there last.** Their commits survive on their own branch (a force-push only moves a pointer), and any GitHub deployment already recorded against their SHA still satisfies the `main` merge gate. What they lose is the *deployed dev stack* — so if someone is mid-validation on dev, tell them.
- OIDC trust: dev role ← `environment:dev` only (deploy-dev always runs in the `dev` environment — on both the `dev`- and `main`-branch pushes — so that's the sole trusted sub; the cutover `refs/heads/{dev,main}` subs were pruned 2026-08); prod role ← the **`prod` GitHub environment** subject (`environment:prod`). The environment scoping is real — only a job that declares that `environment:` gets the matching OIDC sub, so only it can assume the role. Roles hold no direct deploy power: `cdk deploy` funnels through the account's CDK bootstrap roles; the roles get only S3-sync / CloudFront-invalidate / Lambda-invoke for their stage.
- **Plan: GitHub Pro** (confirmed 2026-09-07). This is load-bearing and easy to get wrong — private-repo rulesets, protected branches and Environments are all Pro features, so anyone reasoning from "free private repo" reaches wrong conclusions about what this repo can enforce. Two research passes did exactly that. **Verify enforcement empirically, not from the plan docs:** `gh api repos/radatta/aperture/rules/branches/main` returns the rules *actually in effect* for a ref (an unenforced ruleset still renders normally in Settings).
- **⚠️ Approval-gate caveat (current repo):** on a `main` push, **deploy-prod runs automatically right after deploy-dev — no human pause.** Verified 2026-09-07: both the `dev` and `prod` environments carry only a `branch_policy` protection rule, no `required_reviewers`. The practical safety valve is the **`dev` branch** — push there first for a dev-only deploy + validate, then merge to `main`.
  - **Worth revisiting:** this was previously recorded as *impossible* because required reviewers aren't available on a free private repo. That premise was wrong — the account is on **Pro**, where Environments on private repos are available. Adding a required reviewer to the `prod` environment may well give the single-`main`-push flow a real pause. **Untested** — try it in Settings → Environments → prod rather than trusting either this note or the old one.
- **Branch ruleset (`main`)** — governance for the default branch is a GitHub **ruleset** defined in repo **Settings → Rules → Rulesets** (that's the source of truth; a personal JSON export lives at the gitignored `localNotes/main.json`), `enforcement: active`, no bypass actors. Rules: block **deletion** + **force-push** (`non_fast_forward`), **required linear history**, **PR required** (0 approvals, **squash-only** merge), and **`required_deployments: [dev]`** — a merge into `main` is blocked until the merging commit has a successful deployment to the **`dev`** environment. This is the *enforced* version of the "dev is the staging gate" discipline — it substitutes for the prod approval pause that isn't currently configured (see the caveat above — that pause may in fact be available on Pro; untested). Rulesets work here because the account is on **Pro** — not because of a free-plan exception. Confirmed enforced (not merely configured) on 2026-09-07 via `gh api repos/radatta/aperture/rules/branches/main`, which listed all five rules as in effect; `.../rules/branches/dev` returns empty, so **`dev` has no rules at all**.
  - **Wiring (done):** `required_deployments` only clears when a GitHub **deployment** to the `dev` environment exists for the commit. Wired via: (1) a `dev` GitHub environment whose deployment-branch policy allows **`dev` and `main`** (deploy-dev runs from both), (2) `environment: dev` on the `deploy-dev` job so it records the deployment, (3) the dev OIDC role trusting `environment:dev` (see trust bullet above). **Apply order matters:** redeploy `ApertureCicd` (trust) FIRST, then land the `deploy.yml` change — otherwise deploy-dev's `environment:dev` sub isn't yet trusted and the AssumeRole fails.
  - **Flow:** push branch → `dev` (deploys + records the dev deployment on that SHA) → PR that same commit → `main` (ruleset sees the dev deployment → merge allowed) → squash-merge → main pipeline redeploys dev + deploys prod.
  - **Docs-only fast-path:** the gate is SHA-specific (the *exact* commit being merged must have a dev deployment — an older one doesn't count), so even a one-line docs fix needs a dev deployment. To avoid a full deploy for that, `deploy-dev`/`deploy-prod` detect when a push touches only `docs/` or a top-level `*.md` and **skip the heavy steps (cdk deploy, smoke, publish) while the job still runs in its environment** — so the deployment is still recorded (gate satisfied) but nothing is actually deployed. Anything outside those paths, or an indeterminate base, → full deploy.
- OIDC provider + both roles live in a one-off, hand-deployed `ApertureCicd` stack (`-c githubRepo=owner/repo`); the pipeline never touches it.
- **Origin secret** reaches CI as a GitHub secret (`ORIGIN_SECRET_DEV/PROD` → `APERTURE_ORIGIN_SECRET`), so it's stable across runs. The **device token** works identically (`DEVICE_TOKEN_DEV/PROD` → `APERTURE_DEVICE_TOKEN`), alongside the repo **var** `DEVICE_USER_ID_DEV/PROD` → `APERTURE_DEVICE_USER_ID`; both pairs must be set or the extension breaks silently ([RECRUITING.md](RECRUITING.md)).
- **Smoke tests** invoke the Lambda by **direct `aws lambda invoke`** with a `testMode` payload (synthetic user, writes-object no-ops) → no side effects, even against prod.
- **Deploy-time safety checks:**
  - **Single synth, shared by diff + deploy** — each stage runs `cdk synth … --no-lookups` once to `cdk.out`, then `cdk diff --app cdk.out` and `cdk deploy --app cdk.out` consume that same assembly. No double esbuild bundle, and the diff you read is byte-identical to what deploys. `--no-lookups` fails loudly if an (unexpected) context lookup is ever introduced.
  - **`cdk diff` before every `cdk deploy`** (informational, both stages, `--method=change-set` so it fails under the real deploy role rather than silently falling back to a template diff) — since no prod approval pause is configured, the diff in the run log is the visible record of what each deploy is about to change to infra — and the only thing standing between a bad CDK edit and a real bill. **Read it on the dev run before merging to `main`.** A clean one looks like the 2026-09-07 device-token deploy: `Number of stacks with differences: 1`, two `[+] Added:` env vars, no resources.
  - **Branch up-to-date with main** — on a `dev`-branch push, `deploy-dev` asserts `origin/main` is an ancestor of HEAD and fails if the branch is behind. This is the enforced form of "the SHA you validate on dev already contains main": a stale branch fails the job → no dev deployment recorded → the `required_deployments:[dev]` merge gate stays closed. No-op on `main` pushes (HEAD already is main). (Alternative not taken: GitHub's native "require branches up to date before merging" ruleset toggle — rejected because it needs a designated required status check + a Settings change, and each auto-update mints a new SHA needing a fresh dev deployment.)
  - **`concurrency` group per ref**, `cancel-in-progress: false` — serializes deploys so two quick pushes can't race a half-applied stack; never cancels a deploy mid-flight.

## 10. Secrets

- v1: none in the app path (Cognito public keys are public; no static creds anywhere).
- **Origin secret** — CloudFront→Lambda origin lockdown. A plain Lambda env var, sourced from `APERTURE_ORIGIN_SECRET` (CI) or a gitignored `cdk/.secrets/` file. Anti-abuse only; the JWT is the real gate.
- **Device token** — auth for the extension's LeetCode ingest endpoint. **Same class and same pattern as the origin secret** (single-user, one write method, tiny blast radius) → a plain env var from `APERTURE_DEVICE_TOKEN` / a gitignored file, deliberately **not** Secrets Manager. Paired with `APERTURE_DEVICE_USER_ID` (not secret, but account-specific → also uncommitted). **If `DEVICE_TOKEN_<STAGE>` isn't set in CI, every deploy rotates the token** and the extension's stored copy stops matching. Details + the operator checklist: **[RECRUITING.md](RECRUITING.md)**.
- v1.1 AI: the model API key goes in **Secrets Manager**, fetched at Lambda cold start. Never in env vars or CDK config.

## 11. Cost

Effectively free at single-user scale: DynamoDB / Lambda / Cognito within always-free tiers; S3 + CloudFront in cents; Function URLs add no per-request cost. **No Route 53** (DNS stays at Porkbun). Only real line item: S3/CloudFront, pennies.

---

## Status
Infra direction fully specced. Remaining before build is execution, not decisions: CDK project init, per-env config wiring, GitHub OIDC role setup, and (last) the Porkbun/ACM domain step.
