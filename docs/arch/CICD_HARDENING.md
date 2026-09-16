# Aperture — CI/CD & Ops Hardening

Seven additions to the pipeline + runtime ops, chosen from a wider research pass as the ones worth doing for a **single-operator, cost-sensitive** personal project. Everything here is **$0 at single-user scale** (see cost table). This doc is the implementation plan — grounded in the current repo — to be executed item by item.

> Scope note: Aperture is a personal project. Nothing here references any other project, and no real email address is committed — every recipient is a `<FILL: personal email>` placeholder to be filled at wiring time.

## Decisions (locked)

- **Alarms (#5) + budget (#7) channel:** email via SNS, to the operator's **GitHub-account email** (`<FILL: personal email>`). Simplest, zero new infra; these fire rarely so inbox delivery is fine.
- **Deploy notifications (#1):** ntfy.sh, on **both `main` and `dev`** pushes. Success = quiet (min priority), failure = prominent (high priority). Subscribed from a **desktop browser** (no phone).
- **Budget (#7):** `$1` actual warn / `$5` forecast hard.

## Status

- **Batch 1 wired (2026-08-10):** #3 gitleaks (`.github/workflows/gitleaks.yml`), #4 Dependabot (`.github/dependabot.yml`), #1 ntfy notify job (`.github/workflows/deploy.yml`). `gitleaks-action` tag confirmed **`v3`** (v3.0.0). The ntfy job **no-ops until `NTFY_TOPIC` is set** — activates once the operator creates the topic + adds the secret (done: secret set, subscribed on desktop).
- **Batch 2 wired (2026-08-10):** #6 health check (`/api/health` route + `FunctionUrl` output + `publish-frontend.mjs` invalidation-wait + `health-check.mjs` + deploy.yml steps), #5 CloudWatch alarms (`monitoring.ts`, prod-only, **Option B** — Lambda alarms only, no CloudFront), #7 billing stack (`billing-stack.ts`, hand-deploy), #2 cdk-nag (`cdk-nag@3.0.2`, AwsSolutions pack, wired in `bin/aperture.ts`; suppressions + two enforce-SSL fixes; see the workaround note in item 2). All synth clean on dev+prod; tests + typecheck + lint green.
- **Still needs the operator (manual):** confirm the **one** SNS **email** subscription — the prod alarm topic (`monitoring.ts`), which fires its confirmation on the first prod deploy — to `rahul3datta@gmail.com`. The budget (`billing-stack.ts`) uses a **direct** `EMAIL` subscriber, **not** SNS, so it needs **no** confirmation and emails on threshold. Flip the AWS **root billing toggle** then `cdk deploy ApertureBilling -c billing=true`.
- **Billing stack fix (2026-08-10):** first hand-deploy hit `AlreadyExists` on the CE anomaly monitor (AWS default SERVICE monitor already exists; one per dimension). Dropped both CE resources — budget is the sole guard. See item 7.

## Cost — all $0

| # | Item | Cost | Why |
|---|------|------|-----|
| 1 | Deploy notifications (ntfy) | $0 | Public ntfy free; `curl` runs in existing CI minutes |
| 2 | cdk-nag | $0 | Build-time only, no AWS calls |
| 3 | gitleaks | $0 | Free for personal repos; CI minutes |
| 4 | Dependabot | $0 | GitHub-native, runs off GitHub infra (not your Actions minutes) |
| 5 | CloudWatch alarms | $0 | ≤10 alarms/month free (we use 3–4); SNS email 1,000/month free |
| 6 | Post-deploy synthetic check | $0 | `curl` in CI; extra Lambda/CloudFront hits are free-tier / fractions of a cent |
| 7 | Budget | $0 | Notification-only budgets free & unlimited (anomaly monitor dropped — see item 7) |

**The only things that would cost money are deliberately out of scope:** auto-remediating "budget actions" ($0.10/day), CloudWatch Synthetics canaries (~$10/mo), and any alarm past the 10-free tier. GitHub Actions free private-repo tier is 2,000 min/month — these add ~a couple minutes per run.

## Repo realities discovered (deviations from the naive plan)

1. **Region split breaks a single shared SNS topic.** Stacks pin `region: 'us-west-1'` (`cdk/src/bin/aperture.ts:29`), so the BFF Lambda's metrics are in us-west-1, but **CloudFront metrics publish only in us-east-1**. An alarm can only evaluate metrics in its own region and only publish to an SNS topic in its own region. → the CloudFront 5xx alarm cannot share the Lambda alarms' topic. See item 5's decision.
2. **No `/health` route exists.** `lambdas/src/index.ts` dispatches only `/api/<method>` via `handleRpc`, gated by the shared allowlist (`packages/shared/src/rpc.ts` `isApiMethod`); a JWT-less non-testMode call 401s at `resolveUserId`. Item 6 adds a short-circuit **after** the origin-secret gate and **before** `resolveUserId`.
3. **The Lambda Function URL is not a `CfnOutput`.** `app-stack.ts` outputs `AppUrl`, `CloudFrontDomain`, `SiteBucket`, `DistributionId`, `UserPoolClientId` — not `fnUrl.url`. Item 6's negative-gate test must hit the Function URL **directly** (through CloudFront the viewer can't set `x-aperture-origin-secret` — the origin policy forwards only the auth + content-type headers and CloudFront injects the secret), so a `FunctionUrl` output must be added.
4. **The invalidation ID isn't surfaced.** `scripts/aws/publish-frontend.mjs` runs `create-invalidation` with `stdio: 'inherit'` — the ID is printed, not captured. `aws cloudfront wait invalidation-completed` needs it. Item 6 modifies the script to emit it.
5. **All seven are greenfield** — no existing monitoring/SNS/budget/nag/gitleaks/Dependabot/ntfy wiring anywhere.
6. **`deploy.yml` triggers on `push` only** (not `pull_request`), so Dependabot's restricted-secret context is a non-issue (#4). Prod is `if: github.ref == 'refs/heads/main'`, so it is **skipped** on dev-branch pushes — item 1's notify job must treat `skipped` as not-a-failure.
7. **Versions:** `cdk-nag` latest is **3.0.2** (confirmed via `npm show`) — the v3 **validation-plugin** API, not the classic `Aspects.of(app).add(...)`; confirm the exact call in the current README before writing. `gitleaks/gitleaks-action` current tag confirmed **`v3`** (v3.0.0, Node 24) via the GitHub releases API — pinned.

## Manual prerequisites (operator, by hand)

- [ ] Create an ntfy topic (a long, unguessable name) and subscribe to it in a desktop browser at `https://ntfy.sh/<topic>`.
- [ ] Add GitHub repo **secret** `NTFY_TOPIC` = the topic name (it's the only access control on the public instance → secret, not a var).
- [ ] Fill `<FILL: personal email>` in the alarm construct(s) and the billing stack, then **confirm the SNS email subscription** (one confirmation email per SNS topic — **two** if the CloudFront alarm uses its own us-east-1 topic; see item 5).
- [ ] Flip the AWS **root**-user "IAM access to Billing and Cost Management" toggle **before** deploying the billing stack (item 7). Independent of IAM policy — the OIDC roles cannot do this.
- [ ] Hand-deploy the billing stack once: `cdk deploy ApertureBilling -c billing=true` (mirrors the one-off `ApertureCicd` deploy; the pipeline never touches it).

**Unrelated to the seven items, but on the same "CI needs this by hand" list** — the LeetCode-capture extension needs GitHub **secrets** `DEVICE_TOKEN_DEV` / `DEVICE_TOKEN_PROD` and **vars** `DEVICE_USER_ID_DEV` / `DEVICE_USER_ID_PROD`. Unset, the token rotates on every deploy and captured rows land under the wrong user — both fail silently. Checklist + why: **[recruiting/](../areas/recruiting/index.md) → Operator setup**.

## Implementation order

1. **#3 gitleaks** — isolated, CI-only, zero infra.
2. **#4 Dependabot** — config-only.
3. **#1 ntfy notify** — workflow-only; needs the ntfy topic + secret.
4. **#6 health check** — adds the Lambda route + `FunctionUrl` output + publish-script change + workflow steps. Do before #5 so the output/route surface is settled.
5. **#5 CloudWatch alarms** — biggest CDK change (new construct + SNS).
6. **#2 cdk-nag** — wire the harness anytime, but run the **definitive suppression pass last**, after #5/#6 constructs exist, so one pass covers the SNS topic, alarms, and health route.
7. **#7 budget** — independent hand-deploy; last.

---

## Item 1 — Deploy notifications via ntfy.sh

**File:** `.github/workflows/deploy.yml` (modify).

- New `notify` job: `needs: [deploy-dev, deploy-prod]`, `if: always()`, default permissions only (ntfy topic ≠ AWS cred → keyless).
- Outcome logic from `needs.deploy-dev.result` / `needs.deploy-prod.result`: **failure** if either is `failure`; `skipped` (prod on a dev push) and `cancelled` are **not** failures.
- Success → `curl -H "Priority: min" -H "Title: Aperture deploy ok" -d "<ref> <sha>" https://ntfy.sh/${{ secrets.NTFY_TOPIC }}`
- Failure → `curl -H "Priority: high" -H "Tags: warning" -H "Title: Aperture deploy FAILED" -d "<ref> <sha> — <run url>" ...`
- Body uses `${{ github.ref_name }}` + `${{ github.sha }}` so one topic serves both branches.

## Item 2 — cdk-nag (AwsSolutions pack only)

**Files:** `cdk/package.json` (add `cdk-nag` devDep — **dependency to justify first**), `cdk/src/bin/aperture.ts` (wire at the `App` created ~line 27), inline `NagSuppressions` in `app-stack.ts` / data stack / the new monitoring construct.

- **API (confirmed, v3.0.2):** `Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }))` (v3 dropped the classic `Aspects.of().add()`), suppress with `Validations.of(construct).acknowledge({ id, reason })`. Base rule ids work for non-granular findings.
- **⚠️ Granular IAM4/IAM5 suppression — upstream bug workaround.** `acknowledge()` splits the id on `::` and rejects granular finding ids that embed an ARN (IAM4 managed-policy ARN, IAM5 resource ARN) — an open cdk-nag v3 bug ([cdklabs/cdk-nag#2359](https://github.com/cdklabs/cdk-nag/issues/2359), [#2351](https://github.com/cdklabs/cdk-nag/issues/2351)). Base rule ids are *accepted but don't suppress* granular findings. Workaround (in `app-stack.ts`): write the acknowledgment metadata cdk-nag reads directly — `fn.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, { '<exact finding id from synth>': reason })`. The IAM5 id embeds the cross-stack table export (`ApertureData-${stage}:ExportsOutput…TableCD117FA1…/index/*`) so it's stage-interpolated and drifts if the table construct id changes (synth re-flags → update). Revisit when #2359 lands a fix. Pinned `cdk-nag` exact (`3.0.2`) so a patch can't silently change the metadata contract.
- **Suppressions (~11) + 2 fixes:** suppressed fine-by-design — COG1/COG2/COG8 (single-user pool), IAM4/IAM5 (above), L1 (Node 22 LTS target), S1/CFR1/CFR2/CFR3 (no access logs/WAF/geo), CFR4 (default cert only in pre-domain synth). **Fixed rather than suppressed:** S10 (`enforceSSL` on the S3 bucket) and SNS3 (`enforceSSL` on the alarm topic) — genuine cheap hardening. OAC + PITR pass already → the regression guards we wanted.
- Runs inside the existing `cdk synth` step in both deploy jobs — no workflow change.
- Expected ~8–12 one-time suppressions, each with a real reason string: no WAF on CloudFront, no Cognito MFA/advanced security, S3 access-logging off, default viewer cert pre-domain, Lambda no-DLQ/basic-exec-role, Function URL `authType: NONE` (origin-secret gate), and the `grantReadWriteData` IAM wildcard on index ARNs (real — suppress with justification or scope down).
- OAC ✓ and PITR ✓ should already pass — those are the regression guards worth having.

## Item 3 — gitleaks

**Files:** new `.github/workflows/gitleaks.yml`; optional `.gitleaksignore` at repo root.

- Dedicated workflow (not folded into PR-only `pr.yml`): triggers `pull_request` + `push`.
- `actions/checkout@v7` with `fetch-depth: 0` (full history), then `gitleaks/gitleaks-action@<verified-tag>`. No license key for a personal repo.
- False positives → `.gitleaksignore` fingerprints. Repo already keeps secrets out of git (`.secrets/`, `cdk-outputs.*.json` gitignored; origin secret injected via env), so findings should be rare.
- **Dependency to justify first** (it's a GitHub Action, not npm, but still a supply-chain surface — pin by tag/SHA).

## Item 4 — Dependabot (scoped)

**File:** new `.github/dependabot.yml`.

- **`github-actions`** ecosystem, `directory: "/"`, weekly, one group matching `"*"` → all action bumps in a single weekly PR (keeps `aws-actions/configure-aws-credentials`, `pnpm/action-setup`, `actions/*` current).
- **`npm`** ecosystem, `directory: "/"`, `open-pull-requests-limit: 0` → suppresses routine version updates so **only security PRs** come through (security updates ignore the limit). Dependabot's npm updater handles the pnpm workspace / `pnpm-lock.yaml`.
- **Merge workflow for a Dependabot PR** (the real friction, from the `required_deployments:[dev]` ruleset): Dependabot can't push to `dev` to record the required dev deployment, so — (a) push the PR's SHA to `dev` first (triggers `deploy-dev`, records the deployment, must pass the dev-up-to-date-with-main check at `deploy.yml:48-54`), then (b) merge to main. No restricted-secret concern (deploy is push-triggered).

## Item 5 — CloudWatch alarms (prod-only)

**Files:** new `cdk/src/lib/monitoring.ts` (a `Construct`); `app-stack.ts` (instantiate prod-only, pass the `fn` ref); `cdk/src/stacks.test.ts` (assert alarms/topic present under prod, absent under dev). CloudFront alarm: see decision below.

- **Lambda alarms (us-west-1)** in a `Monitoring` construct inside `ApertureAppStack`, gated `if (stage === 'prod')`. New us-west-1 SNS `Topic` + `EmailSubscription('<FILL: personal email>')`. Three alarms, all `treatMissingData: NOT_BREACHING` (low traffic → metric gaps):
  - `fn.metricErrors()` ≥ 1
  - `fn.metricThrottles()` ≥ 1
  - `fn.metricDuration({ statistic: 'p99' })` ≥ ~12000ms (80% of the 15s timeout at `app-stack.ts:46`)
  - each `.addAlarmAction(new cw_actions.SnsAction(topic))`
- **Skip DynamoDB throttle alarms** (on-demand + a known CDK math-expression limitation make them not worth it).

### DECISION — CloudFront 5xx alarm: **Option B chosen** (skip it), 2026-08-10.

- **Option A — add it (cross-region).** A dedicated `ApertureCloudFrontMonitoring-prod` stack in `aperture.ts` with `env: { region: 'us-east-1' }`, its **own** SNS topic + email subscription, a raw `Metric` (`AWS/CloudFront`, `5xxErrorRate`, `Region: 'Global'`), and `crossRegionReferences: true` on both stacks to pass `distributionId`. Cost: a **second** SNS topic + **second** email confirmation + cross-region wiring complexity.
- **Option B — skip it (recommended).** Keep only the three Lambda alarms. Rationale: at single-user scale the extra topic/confirmation/complexity outweighs the value, and item 6's **negative-gate check already proves the origin-secret edge is enforced at deploy time** — the main edge-wiring failure this alarm would catch. Revisit if real traffic grows.
- Do **not** put the CloudFront metric on a us-west-1 alarm — it will never fire.

## Item 6 — Post-deploy synthetic health check

**Files:** `lambdas/src/index.ts` (+ `index.test.ts`), `app-stack.ts` (add `FunctionUrl` output), `scripts/aws/publish-frontend.mjs` (emit invalidation ID), `.github/workflows/deploy.yml` (steps in both deploy jobs).

- **`/api/health`:** in `handler`, after the origin-secret gate (~`index.ts:51-54`) and **before** `resolveUserId`, short-circuit `method === 'health'` → `200 {ok:true, stage}`. No JWT, no `doc`, no writes (respects the no-side-effect pattern). Stays behind the origin gate, so a headerless request still 403s (the negative test). Don't route it through `handleRpc`/`isApiMethod`. Add a test mirroring the existing 403 test (header present → 200; absent → 403).
- **`FunctionUrl` output:** in `app-stack.ts` after `fnUrl` (~line 60): `new CfnOutput(this, 'FunctionUrl', { value: fnUrl.url })`.
- **Invalidation ID:** modify `publish-frontend.mjs` to capture `create-invalidation` JSON (`.Invalidation.Id`) and echo it for the workflow to capture into `$GITHUB_OUTPUT` (or run the wait inside the script).
- **Workflow steps** (after "Publish frontend", both jobs, same `if: steps.changes.outputs.deploy == 'true'`; read outputs from `cdk/cdk-outputs.<stage>.json` with `node -e`, no `jq`):
  1. `aws cloudfront wait invalidation-completed --distribution-id <DistributionId> --id <captured>`
  2. `curl --fail --retry 5 --retry-all-errors https://<AppUrl>/` → shell 200
  3. `curl --fail -sI https://<AppUrl>/manifest.webmanifest` → assert `content-type: application/manifest+json`
  4. `curl --fail https://<AppUrl>/<deep/path>` → SPA fallback returns the shell
  5. Positive gate: `curl --fail -H "x-aperture-origin-secret: $ORIGIN_SECRET" https://<FunctionUrl>/api/health` → 200 (origin secret already the per-stage CI secret `ORIGIN_SECRET_DEV/PROD`)
  6. Negative gate: `curl -s -o /dev/null -w '%{http_code}' https://<FunctionUrl>/api/health` (no header) → assert `403`

## Item 7 — AWS Budget + Cost Anomaly Detection (hand-deployed)

**Files:** new `cdk/src/lib/billing-stack.ts`; `aperture.ts` (instantiate only under a `-c billing=true` context flag, mirroring the `ApertureCicd` gate).

- Deploy once by hand: `cdk deploy ApertureBilling -c billing=true`. The per-stage pipeline never touches it.
- `CfnBudget`: monthly `COST`, `$1` actual → warn, `$5` **forecast** → hard warn; EMAIL subscriber `<FILL: personal email>`. Budgets are global — deploy this stack in `us-east-1` by convention (document the choice).
- `CfnAnomalyMonitor` (`DIMENSIONAL`, `SERVICE`) + `CfnAnomalySubscription` (`IMMEDIATE`, EMAIL `<FILL: personal email>`). Free, ML-based.
- **Root-toggle prerequisite** (see checklist): creating a budget needs the root-user billing-access toggle, independent of IAM policy — which is exactly why this is a separate hand-deploy and must not enter the pipeline. Console-setup is a fine fallback if the CDK deploy is a hassle.
- **⚠️ Anomaly monitor dropped (2026-08-10).** The first hand-deploy failed: `AWS::CE::AnomalyMonitor` → `CREATE_FAILED / AlreadyExists`. AWS auto-creates a default account-wide `SERVICE`-dimension anomaly monitor and permits **only one monitor per dimension**, so our `CfnAnomalyMonitor` (also `DIMENSIONAL/SERVICE`) collides. Fix: removed both `CfnAnomalyMonitor` + `CfnAnomalySubscription` from the stack — the `$1/$5` budget is the sole cost guard, which is plenty at single-user scale. If an anomaly email is ever wanted, attach a free alert subscription to the **existing default monitor** in the console (Cost Management → Cost Anomaly Detection → Alert subscriptions); no IaC. The `AlreadyExists` (vs `AccessDenied`) also confirmed the root billing toggle was correctly enabled.

---

## Dependencies to justify before wiring

Per project dependency discipline, surface these before adding:
- **`cdk-nag`** (`3.0.2`, devDep in `cdk/`) — item 2.
- **`gitleaks/gitleaks-action`** (GitHub Action, pin by verified tag/SHA) — item 3.

Everything else uses the existing `aws-cdk-lib` (`aws-cloudwatch`, `aws-cloudwatch-actions`, `aws-sns`, `aws-sns-subscriptions`, `CfnBudget`, `CfnAnomalyMonitor`/`CfnAnomalySubscription`) — no new dependency.

## Open items

- **Operator manual steps** (blocking full activation): confirm the **one** SNS email subscription to `rahul3datta@gmail.com` — the prod alarm topic, which fires its confirmation on the first prod deploy. The budget subscriber is direct `EMAIL` (not SNS) → no confirmation. Flip the AWS root billing-access toggle, then `cdk deploy ApertureBilling -c billing=true`. **(All done as of 2026-08-10 — merged to main, prod deployed, alarm sub confirmed, ntfy verified on dev+prod.)**
- **cdk-nag #2359 watch:** when the upstream granular-acknowledge bug is fixed, replace the `addMetadata` workaround in `app-stack.ts` with the normal `Validations.of(fn).acknowledge(...)`.
- Email address is now filled (`rahul3datta@gmail.com`, personal) in `monitoring.ts` + `billing-stack.ts` — not a work address.

