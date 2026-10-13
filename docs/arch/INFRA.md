# Aperture — Infrastructure

The AWS blueprint behind `TECH.md`. All IaC via **CDK**. Region: **`us-west-1`** for the data + app stacks. **`us-east-1`** only where AWS requires it: the CloudFront ACM certs (§8) and the billing stack (Cost Explorer / anomaly data lives there).

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
                                            ▲
   Lambda BFF ──async invoke──► finance-sync Lambda ◄── EventBridge Scheduler (3×/day)
        └──HTTPS──► Plaid ◄──HTTPS──┘   (BFF: link token, exchange, remove; sync: accounts, refresh, sync)

   Cognito User Pool (per env, invite-only, PKCE SPA client) ──JWT──► the app
```

---

## 2. Environments — dev + prod

Two isolated copies of everything, so changes can be tested before touching real data.

- Stacks per env: `ApertureData-{dev,prod}` + `ApertureApp-{dev,prod}`.
- Isolated resources per env: DynamoDB table (`aperture-dev` / `aperture-prod`), Cognito User Pool, Lambda, S3 bucket, CloudFront distro.

---

## 3. CDK stacks — split stateful from replaceable

- **`ApertureData-<env>`** — DynamoDB table + Cognito User Pool + the **Files bucket** (task attachments; `RETAIN`, presigned-only, CORS = the stage's app domain — design: `areas/tasks/attachments.md` D5/D9). `removalPolicy: RETAIN`, deployed rarely, protected from teardown. _(Precious: your data + your identity.)_
- **`ApertureApp-<env>`** — Lambda + Function URL + S3 (Site) + CloudFront (+ ACM cert reference, since the domain step, §8). Redeploys freely; nothing precious. The BFF Lambda gets an object-scoped (`u/*`) `s3:PutObject/GetObject` grant on the data stack's Files bucket to sign presigns.

Rationale: never let an app redeploy endanger the stateful resources.

---

## 4. Compute & API

- **One multi-route BFF Lambda** per env (all routes in a single handler). Node 22 runtime, esbuild-bundled via CDK.
- **Lambda Function URL**, auth type **`NONE`**, fronted by CloudFront. Not OAC: CloudFront OAC can't SigV4-sign POST bodies to a Function URL. Instead CloudFront stamps a shared **origin-secret header** (`ORIGIN_SECRET`) on every origin request and the handler 403s anything without it, so the raw URL is useless directly. Defense-in-depth only — the in-handler Cognito JWT check is the real auth gate. The MCP Lambda's URL works the same way. (`cdk/src/lib/app-stack.ts` class comment.)
- **Auth:** validate the Cognito JWT **in-handler** (JWKS signature + issuer/expiry), extract `sub` → `userId` scoping every DynamoDB item.
- Config: ~15s timeout, 512 MB, **no warming** (single user — cold starts are fine). Env vars: `TABLE_NAME`, `FILES_BUCKET`, `USER_POOL_ID`, `MCP_CLIENT_ID`, `STAGE`, `ORIGIN_SECRET`, `DEVICE_TOKEN`, `PLAID_ENV`, `FINANCE_SYNC_FN` (+ optional `DEVICE_USER_ID`). The BFF verifier is deliberately **not** bound to one app client (D14) — `MCP_CLIENT_ID` is the claude.ai MCP client, and the BFF **rejects** tokens minted for it (the MCP Lambda does the opposite: it accepts only that client).
- **Writes-object pattern** enforced (single audit point for all side effects; guarantees no writes during smoke tests).
- **Recurrence generation: lazy on read** — when a day loads, materialize any due `taskSeries` occurrences. No cron for recurrence.
- **Three functions:** the BFF, the MCP server (`aperture-mcp-<stage>`, [mcp/](../areas/mcp/index.md)), and the **finance sync** (`aperture-finance-sync-<stage>`, `cdk/src/lib/finance-sync.ts`): 300 s, 512 MB, no Function URL, invoked only asynchronously — by the BFF after a sync request, connect or reconnect, and by **EventBridge Scheduler** at 5:15a / 3:15p / 8:15p LA (the one scheduled job; created only when `DEVICE_USER_ID` is set). It sits alone in schedule group `aperture-finance-<stage>` because Scheduler checks its role's `aws:SourceArn` against the group ARN, never the schedule's; the one-schedule group keeps the role assumable by that job only. Never retried by Lambda; 30-day log group; no reserved concurrency (a per-item CAS lock is the concurrency control). Its IAM is GetItem/PutItem/Query on the table + Plaid SSM read. `PLAID_ENV` is `production` on prod, else `sandbox`; the BFF may invoke exactly this function. Timing and design: [finances/](../areas/finances/index.md).

## 5. Data — DynamoDB

Single table per env (`aperture-<env>`), **on-demand** billing, **PITR on** (35-day continuous backup — the safety net), `RETAIN`. Keys/GSI per `TECH.md §2.4`. One GSI, two key spaces (calibration's done tasks; finance transactions by date). Reads/aggregation in the Lambda.

## 6. Auth — Cognito

- **One User Pool per env.** Self-signup **OFF** (invite-only; you admin-create your own user). MFA optional.
- **App client:** SPA type, PKCE, no secret. Callback URLs = the env's app URL (CloudFront default first; the custom domain from §8 was added when it went live). **`refreshTokenValidity` is capped at 7 days** (Cognito default 30) — it sets how often a password is actually typed; access/ID tokens stay at the 1-hour default. Why, and the renewal behaviour built on it: `TECH.md` §3.
- **Second app client — `aperture-claude-<env>`** — the claude.ai MCP connector (no secret, authorization-code flow, callback URLs = Anthropic's connector constants, **30-day** refresh — why: `areas/mcp/index.md` D13). Plus an **MCP resource server** (identifier `<app-url>/mcp`, one `access` scope). Both live in the **app** stack (not the precious data stack) — the MCP OAuth façade + the credential-not-method fork are in **[areas/mcp/index.md](../areas/mcp/index.md)**.
- **Hosted UI** on a Cognito domain prefix (e.g. `aperture-dev.auth.us-west-1.amazoncognito.com`) — free, independent of the app's custom domain. Google IdP optional. The MCP function reads this host (`COGNITO_DOMAIN`) to build the façade's `/oauth2` endpoints.
- Frontend: `react-oidc-context` + Hosted UI.

## 7. Hosting & CDN

- **S3** (private) + **CloudFront** per env. Default behavior → S3 (OAC); `/api/*` → Function URL origin (origin-secret header, §4). **SPA fallback:** 403/404 → `/index.html` for client-side routing.
- **`/mcp`** → the second (MCP) Function URL origin, plus three narrowly-scoped `/.well-known/oauth-*` GET behaviors on the same origin (the claude.ai OAuth metadata façade — **never** `/.well-known/*`). `/mcp` uses a **1 s-max-TTL** cache policy (not zero — the mechanism and why are in `areas/mcp/index.md` → _claude.ai — the OAuth façade_ → Decisions) that carries `Authorization` in the cache key, while its origin-request policy forwards the agent-token + MCP headers. Design: **[areas/mcp/index.md](../areas/mcp/index.md)**.
- **Build on the CloudFront default domain first** (`*.cloudfront.net`) — HTTPS + PWA install work immediately, zero DNS. The custom domain was the last step, and is live (§8).
- **Publish discipline** (`scripts/aws/publish-frontend.mjs`, used by CI + local emergency publishes): **two-pass S3 sync** — hashed `assets/*` get `max-age=31536000,immutable`; everything else (`index.html`, `sw.js`, manifest, icons) gets `no-cache,no-store,must-revalidate` so a client never holds a stale shell (old `assets/*` hashes are never deleted — the shell pass excludes them — so in-flight clients keep loading old chunks; the bucket grows ~600 KiB per deploy). **PWA files get explicit `--content-type`** (`manifest.webmanifest` → `application/manifest+json`, `sw.js` → `text/javascript`) because `s3 sync` guesses by extension and an octet-stream manifest silently blocks install.

## 8. Custom domain — LIVE

- **Status (2026-08): LIVE** (re-verified 2026-09-26: `dig NS rahuldatta.dev` → `dns1–4.p03.nsone.net`; `curl -sI aperture.rahuldatta.dev` answers from CloudFront). Planned as the last step, off the critical path, wired right before real daily use. Both stages serve on their custom domains — prod `aperture.rahuldatta.dev`,
  dev `dev.aperture.rahuldatta.dev` — on us-east-1 ACM certs (DNS-validated via Netlify/NS1 DNS, not
  Porkbun: rahuldatta.dev is registered at Porkbun but its nameservers are delegated to Netlify), referenced by ARN through the
  `CERT_ARN_*` GitHub vars. Login round-trips on both (Cognito callbacks registered for each origin).
- **One-time, $0, no recurring work:** create ACM certs in **`us-east-1`** (DNS validation), add the validation CNAMEs at the DNS host (Netlify) once, add the CloudFront alias CNAMEs once. ACM **auto-renews** DNS-validated certs while the CNAME stays — no per-deploy, no per-renewal work.
- **Reference certs by ARN in CDK** (don't have CDK create them) → deploys never touch DNS/certs. The
  ARN comes from `APERTURE_CERT_ARN` (GitHub **var** `CERT_ARN_DEV`/`CERT_ARN_PROD` per stage), read in
  `cdk/src/config/domains.ts` alongside the committed domain names; the app stack takes `domainName` +
  `certificateArn` props and adds the alias + cert to CloudFront only when both are present (else stays
  on the CloudFront default domain, so pre-domain deploys are unaffected).
- **Region note:** the cert lives in **`us-east-1`** (CloudFront's hard requirement) even though the
  stacks deploy to **`us-west-1`** — referencing by ARN makes the split a non-issue.

## 9. CI/CD — GitHub Actions, OIDC

No static credentials — OIDC role assumption. GitHub Flow, simplified:

- Feature branch → PR (three parallel `ci.yml` jobs: `check` = lint + typecheck + non-app tests, `test-app-1`/`test-app-2` = the app suite halved by `vitest --shard`; the same reusable workflow the pipeline runs) → squash to `main`.
- `main` pipeline: lint/typecheck/test (pnpm + Vitest) → `cdk diff --method=template` → `cdk deploy ApertureData-dev` + `ApertureApp-dev` (`--method=direct`) → smoke dev → build app (Vite, env from CDK outputs) → S3 sync → CloudFront invalidation (not awaited) → health check polls the edge for the new shell → same for prod, **automatically — no approval pause** (see the caveat below).
- **The check is tuned for the 2-vCPU private-repo runner.** Three parallel jobs, so the app suite runs beside lint/typecheck/the other tests, itself split in two by `vitest --shard`. Each shard runs on Vitest's one default worker: app tests share one jsdom instead of one per file, and a second worker measured no faster (2026-10-13: app suite 37.8/46.5/43.6s on two vs 35.5/45.9/42.1s on one). Lint + typecheck results are cached across runs (`actions/cache`, keyed per commit). Every job that installs (the three, and `deploy-stage.yml`) uses the local `.github/actions/setup`: the runner image's Node 22 + pnpm via corepack, guarded against drift from `.nvmrc` / `packageManager`, with no pnpm store cache (restoring it cost 4–6s and install took 10–12s either way). The test-side rules live in `product/CONVENTIONS.md` (_Command shape_); why the cache can't false-pass is in the comment above the cache step in `.github/workflows/ci.yml`.
  - **Measured 2026-10-13:** check 105s / 2 billed min (one job, main run 38347127185) → slowest job 57–58s / 3 billed min (dev run 38351332150, attempts 2–3, with the store cache still in; its removal is expected to take ~4–5s more off each job). `check` and `test-app-2` now finish within a few seconds of each other; the shards are uneven (~14s vs ~32s of tests) because the file hash put the heaviest files together.
- `dev` branch → one-off dev deploy (not a promotion step).
  - **Dev fast path:** an app-only push to `dev` (`mode=app`) runs `deploy-dev-fast`, which needs only `changes` and so runs in parallel with `check` — the frontend is live in under a minute. Infra/docs pushes to `dev`, and every `main` push, keep check → deploy-dev → deploy-prod. **No rollback:** if the fast job succeeded and `check` didn't, `notify` posts an **urgent** ntfy ("dev DEPLOYED but CI FAILED"). `main` is unaffected — the fast job is gated on `refs/heads/dev`, and `deploy-prod` never lists it in `needs` (a skipped need would skip prod).
- **`dev` is a scratch deploy target, and force-pushing it is the norm.** It exists to get an arbitrary branch onto real infrastructure quickly — `git push -f origin HEAD:dev` is the intended operation, not an emergency. It is **not** an integration branch: nothing merges _from_ it, its history is disposable, and whatever it points at is simply what's deployed to dev right now. So don't merge into it, don't rebase onto it, and don't build a temporary worktree to get a branch onto it — just overwrite it.
  - The one real consequence: **force-pushing `dev` overwrites whoever deployed there last.** Their commits survive on their own branch (a force-push only moves a pointer). What they lose is the _deployed dev stack_ — so if someone is mid-validation on dev, tell them.
- OIDC trust: dev role ← `environment:dev` only (deploy-dev always runs in the `dev` environment — on both the `dev`- and `main`-branch pushes — so that's the sole trusted sub; the cutover `refs/heads/{dev,main}` subs were pruned 2026-08); prod role ← the **`prod` GitHub environment** subject (`environment:prod`). The environment scoping is real — only a job that declares that `environment:` gets the matching OIDC sub, so only it can assume the role. Roles hold no direct deploy power: `cdk deploy` funnels through the account's CDK bootstrap roles; the roles get only S3-sync / CloudFront-invalidate / Lambda-invoke for their stage.
- **Plan: GitHub Pro** (confirmed 2026-09-07). This is load-bearing and easy to get wrong — private-repo rulesets, protected branches and Environments are all Pro features, so anyone reasoning from "free private repo" reaches wrong conclusions about what this repo can enforce. Two research passes did exactly that. **Verify enforcement empirically, not from the plan docs:** `gh api repos/radatta/aperture/rules/branches/main` returns the rules _actually in effect_ for a ref (an unenforced ruleset still renders normally in Settings).
- **⚠️ Approval-gate caveat (current repo):** on a `main` push, **deploy-prod runs automatically right after deploy-dev — no human pause.** Verified 2026-09-07: both the `dev` and `prod` environments carry only a `branch_policy` protection rule, no `required_reviewers`. The practical safety valve is the **`dev` branch** — push there first for a dev-only deploy + validate, then merge to `main` (recommended, not enforced — ruleset History below).
  - **Worth revisiting:** this was previously recorded as _impossible_ because required reviewers aren't available on a free private repo. That premise was wrong — the account is on **Pro**, where Environments on private repos are available. Adding a required reviewer to the `prod` environment may well give the single-`main`-push flow a real pause. **Untested** — try it in Settings → Environments → prod rather than trusting either this note or the old one.
- **Branch ruleset (`main`)** — governance for the default branch is a GitHub **ruleset** defined in repo **Settings → Rules → Rulesets** (that's the source of truth; a personal JSON export lives at the gitignored `localNotes/main.json`), `enforcement: active`, no bypass actors. Rules in effect (verified 2026-09-26 via `gh api repos/radatta/aperture/rules/branches/main`): block **deletion** + **force-push** (`non_fast_forward`), **required linear history**, **PR required** (0 approvals, **squash-only** merge), and **required status checks** `ci / check`, `gitleaks`, `GitGuardian Security Checks`. **`ci / test-app-1` and `ci / test-app-2` still need adding** (the app shards since 2026-10-13; a check name can only be picked in Settings once a run has produced it) — until then a red app shard doesn't block a merge. **Those PR checks are the only gate before `main`** — there is no merge-time deploy requirement and no prod approval pause (caveat above), so a squash-merge goes dev → prod with no further human step. Rulesets work here because the account is on **Pro** — not because of a free-plan exception. `.../rules/branches/dev` returns empty, so **`dev` has no rules at all**.
  - **History:** the fifth rule used to be **`required_deployments: [dev]`** — merge blocked until the _exact_ merging SHA (an older one didn't count) had a successful deployment to the `dev` environment, so even a one-line docs fix needed one. Confirmed enforced 2026-09-07 (then: deletion, non_fast_forward, linear history, PR, required_deployments). Switched off 2026-09-10 (by 2026-09-26 the fifth rule is required_status_checks); the docs weren't updated until 2026-09-26. It had stood in for the missing prod approval pause; nothing enforced replaces it. Left behind by it: the `none` deploy mode (below) and the `environment: dev` deployment record nothing now consumes.
  - **Environment wiring (done):** `deploy-dev` runs inside the `dev` GitHub environment on both `dev`- and `main`-branch pushes, which needs: (1) a `dev` environment whose deployment-branch policy allows **`dev` and `main`** (a job declaring an environment is refused on a branch the policy excludes), (2) `environment: dev` on the `deploy-dev` job — what mints the `…:environment:dev` OIDC sub (it also records a GitHub deployment, which only the retired gate consumed), (3) the dev OIDC role trusting `environment:dev` (see trust bullet above). **Apply order matters:** redeploy `ApertureCicd` (trust) FIRST, then land the `deploy.yml` change — otherwise deploy-dev's `environment:dev` sub isn't yet trusted and the AssumeRole fails. The **`cloudformation:DescribeStacks`** grant added for the `app` deploy tier follows the same rule: `cdk deploy ApertureCicd` must land before any `app`-tier deploy runs, or `fetch-stack-outputs.mjs` gets AccessDenied (a `full` deploy is unaffected — it never calls DescribeStacks).
  - **Flow:** branch → PR → required checks pass → squash-merge → main pipeline deploys dev, then prod. Recommended (not enforced): `git push -f origin HEAD:dev` first to validate on real infrastructure and read that run's `cdk diff` (safety-checks bullet below) before merging.
  - **Three-way change detection (docs / app / full):** a `changes` job classifies the push once (`scripts/src/classify-changes.ts`, unit-tested — it replaced an inline grep whose `$` anchored the whole alternation, so nothing _under_ `docs/` ever took the fast path) into a `mode` passed to the reusable `deploy-stage.yml`. It runs on the runner image's stock Node 22 (native type stripping) — no pnpm, no install — so it's the one `.ts` in CI executed without tsx:
    - **`none`** (only `docs/` or a top-level `*.md`) → every build/deploy step is skipped — nothing is deployed. The job still runs in its `environment:`, so GitHub records a deployment that deploys nothing: a vestige of the retired `required_deployments` gate (History above), which let a docs-only commit clear it cheaply. Nothing consumes the record now; skipping the job outright is a candidate cleanup, not done here.
    - **`app`** (only `app/**`) → build + S3 sync + CloudFront invalidate + health check, no CDK. On a `dev` push this is the fast path above. Since it skips the `cdk deploy` that writes `cdk-outputs.<stage>.json`, `fetch-stack-outputs.mjs` reads the same values from CloudFormation (needs the `cloudformation:DescribeStacks` grant on the CI role).
    - **`full`** (anything else, `packages/shared`/`scripts`/root config/`.github` included, or an indeterminate base) → synth + diff + deploy + smoke, then publish + health check.
- OIDC provider + both roles live in a one-off, hand-deployed `ApertureCicd` stack; the pipeline never touches it. **Deploy it with BOTH context flags:** `cdk deploy ApertureCicd -c githubRepo=radatta/aperture -c githubSubject=radatta@52138736/aperture@1321047340`. This repo's OIDC `sub` claim uses the **ID-embedded** form (`owner@ownerid/repo@repoid`), so `githubSubject` is **not** optional here — omit it and the trust policy is rebuilt with the plain `radatta/aperture` slug, which no live token matches → every CI AssumeRole (dev + prod) breaks silently. The subject is account-specific, so it's passed at deploy time, never committed. The roles also carry cdk-nag `AwsSolutions-IAM5` acknowledgements for their deliberate wildcards (bootstrap-role assumption, the stage's hashed site bucket, CloudFront invalidation, `DescribeStacks`) — see `cicd-stack.ts`.
- **Origin secret** reaches CI as a GitHub secret (`ORIGIN_SECRET_DEV/PROD` → `APERTURE_ORIGIN_SECRET`), so it's stable across runs. The **device token** works identically (`DEVICE_TOKEN_DEV/PROD` → `APERTURE_DEVICE_TOKEN`), alongside the repo **var** `DEVICE_USER_ID_DEV/PROD` → `APERTURE_DEVICE_USER_ID`; both pairs must be set — the two silent failure modes: [recruiting/ → Operator setup](../areas/recruiting/index.md#operator-setup).
- **Smoke tests** invoke the Lambda by **direct `aws lambda invoke`** with a `testMode` payload (synthetic user, writes-object no-ops) → no side effects, even against prod. The list includes `listFinanceRules`, which proves the finance path and that the Lambda SDK client + Plaid gateway load at cold start (testMode swaps both for no-ops — no SSM read, no Plaid call). The finance sync function is never smoke-invoked, and the CI role wasn't widened for it.
- **Deploy-time safety checks:**
  - **Single synth, shared by diff + deploy** — each stage runs `cdk synth … --no-lookups` once to `cdk.out`, then `cdk diff --app cdk.out` and `cdk deploy --app cdk.out` consume that same assembly. No double esbuild bundle, and the diff you read is byte-identical to what deploys. `--no-lookups` fails loudly if an (unexpected) context lookup is ever introduced.
  - **`cdk diff` before every `cdk deploy`** (informational, both stages, `--method=template`: compares the synthesized template with the deployed one via the lookup role). It was `--method=change-set`, chosen so the diff failed under the real deploy role rather than silently falling back to a template diff — but the deploy then built a second, identical change set (5–19 s per stage), and the deploy itself now exercises the deploy role moments later. Given up: CloudFormation's own change-set analysis; property-level "requires replacement" still comes from CDK's resource spec. If a template diff shows every resource of an existing stack as added, distrust it — it couldn't read the deployed template — rather than the stack. Since no prod approval pause is configured, the diff in the run log is the visible record of what each deploy is about to change to infra — and the only thing standing between a bad CDK edit and a real bill. **Read it on the dev run before merging to `main`.** A clean one looks like the 2026-09-07 device-token deploy: `Number of stacks with differences: 1`, two `[+] Added:` env vars, no resources.
  - **Branch up-to-date with main** — on a non-`main` push (i.e. `dev`), the `changes` job asserts `origin/main` is an ancestor of HEAD and fails if the branch is behind. This is the enforced form of "dev only ever runs code that already contains `main`" — otherwise what you validate on dev isn't what a squash-merge would produce: a stale branch fails `changes` → `deploy-dev` (which `needs: changes`) is skipped. No-op on `main` pushes (HEAD already is main). (GitHub's native "require branches up to date before merging" ruleset toggle is a different control — it acts on the PR at merge time, not on the `dev` push, so it couldn't replace this check. It was originally rejected because it needed a designated required status check, which the ruleset lacked then; it has three now, so enabling it is an open, separate decision — not done.)
  - **`cdk deploy --method=direct`** — UpdateStack without a change set: same CloudFormation rollback-on-failure, less per-resource progress in the log; unchanged stacks still no-op and `--outputs-file` is still written.
  - **`concurrency` group per ref**, `cancel-in-progress: false` — serializes deploys so two quick pushes can't race a half-applied stack; never cancels a deploy mid-flight. **Plus a job-level group per stage** in `deploy-stage.yml` (`deploy-stage-<stage>`, also queue-not-cancel): the per-ref group can't stop a `main` push (which deploys dev first) and a `dev` push from deploying the dev stage at once. Whichever takes the lock last is what dev runs — fine for a scratch stage. The per-ref group caps it at one `main` run and one `dev` run, so at most two jobs contend; GitHub's one-pending-per-group rule (a third contender cancels the older pending job, `cancelled` in `notify`) can't trigger today.
  - **Publish + health check** — `publish-frontend.mjs` creates the `/*` invalidation and **doesn't wait** (the CLI waiter polled every 20 s — a flat 20–22 s per stage). `health-check.mjs` instead reads the `/assets/*` refs from the `app/dist/index.html` it just built and polls `/` (backoff 1 → 8 s, ~60 s budget) until the edge serves all of them — proof the edge serves _this_ build — then runs the endpoint checks. It converges in a second or two because the shell is `no-store` with the default behaviour's 1 s min TTL, and the 403/404 SPA-fallback responses have `ttl: 0`. No cache-buster: the default behaviour ignores query strings. `sw.js` and the manifest are excluded from the shell sync and uploaded once each by their pinned-Content-Type `cp`.

## 10. Secrets

- No static AWS creds anywhere (Cognito public keys are public).
- **Third-party credentials live in SSM Parameter Store** (SecureString, Standard tier, the default `aws/ssm` key — no KMS statement needed): Google under `/aperture/<stage>/google/*` ([calendar/](../areas/calendar/index.md)); Plaid under `/aperture/<stage>/plaid/` — `client_id` + `secret` written once by the operator, `items/<itemId>/access_token` written/deleted by the BFF and read by the sync; the MCP function gets none of Plaid ([finances/ → Operator checklist](../areas/finances/index.md#12-operator-checklist)).
- **Origin secret** — CloudFront→Lambda origin lockdown. A plain Lambda env var, sourced from `APERTURE_ORIGIN_SECRET` (CI) or a gitignored `cdk/.secrets/` file. Anti-abuse only; the JWT is the real gate.
- **Device token** — auth for the extension's LeetCode ingest endpoint. **Same class and same pattern as the origin secret** (single-user, one write method, tiny blast radius) → a plain env var from `APERTURE_DEVICE_TOKEN` / a gitignored file, deliberately **not** Secrets Manager. Paired with `APERTURE_DEVICE_USER_ID` (not secret, but account-specific → also uncommitted). What happens when either is unset in CI, plus the operator checklist: **[recruiting/ → Operator setup](../areas/recruiting/index.md#operator-setup)**.
- v1.1 AI: the model API key goes in **Secrets Manager**, fetched at Lambda cold start. Never in env vars or CDK config.

## 11. Cost

Effectively free at single-user scale: DynamoDB / Lambda / Cognito within always-free tiers; S3 + CloudFront in cents; Function URLs add no per-request cost. **No Route 53** (DNS is at Netlify/NS1; the domain is registered at Porkbun — §8). Only real line item: S3/CloudFront, pennies. The finance sync (3 scheduled runs a day, ~5–20 s each), EventBridge Scheduler and the three extra alarms sit inside the free tiers; Plaid Trial is $0 with a hard cap of 10 linked bank logins.

---

## Status

Built. Current build status lives in [`docs/index.md`](../index.md).
