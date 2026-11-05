import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ApertureDataStack } from '../lib/data-stack';
import { ApertureAppStack } from '../lib/app-stack';
import { ApertureCicdStack } from '../lib/cicd-stack';
import { ApertureBillingStack } from '../lib/billing-stack';
import { ApertureDevGuardStack } from '../lib/dev-guard-stack';
import { ApertureOrgStack } from '../lib/org-stack';
import { domainConfigFor } from '../config/domains';
import { laneFor, synthesizerFor } from '../config/lane';
import { stageSecret } from '../config/ciSecrets';

// The Cognito `sub` device-token writes are attributed to, so captured attempts show under the
// signed-in user. Not a secret, but account-specific → not committed: APERTURE_DEVICE_USER_ID (CI), else
// a gitignored file, else undefined → the handler falls back to the 'local' dev user.
function deviceUserIdFor(stage: string): string | undefined {
  const fromEnv = process.env.APERTURE_DEVICE_USER_ID;
  if (fromEnv) return fromEnv.trim();
  const dir = fileURLToPath(new URL('../../.secrets', import.meta.url));
  const file = `${dir}/device-user-id.${stage}`;
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  return undefined;
}

// Two stacks per stage. Region pinned to us-west-1; account comes from the deploying credentials
// (CDK_DEFAULT_ACCOUNT; for dev, the dev account), so nothing account-specific is committed. `-c stage=prod` for prod.
const app = new App();
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const env = { region: 'us-west-1' };

// Custom domain (Phase 14): undefined until the stage's cert ARN is wired (APERTURE_CERT_ARN) →
// stays on the CloudFront default domain, so this is a no-op before the domain step. Resolved before the
// data stack because the files-bucket CORS origin is derived from it.
const domain = domainConfigFor(stage);
// Presigned uploads/downloads hit the files bucket directly, so its CORS must allow the app's origin — the
// custom domain when set, else '*' (the CloudFront default domain wouldn't pass CORS, and the presigned URL
// is the real credential anyway).
const allowedOrigins = domain ? [`https://${domain.domainName}`] : ['*'];

// Main's own dev deploy goes through the freeze-exempt `devmain` bootstrap, everything else through the stock one
// (config/lane.ts). The synthesizer is spread in only for that lane, so every other stack's props stay as they were.
const lane = laneFor(stage);
const laneProps = () => {
  const synthesizer = synthesizerFor(lane);
  return synthesizer ? { synthesizer } : {};
};

const data = new ApertureDataStack(app, `ApertureData-${stage}`, { stage, env, allowedOrigins, ...laneProps() });
const appStack = new ApertureAppStack(app, `ApertureApp-${stage}`, {
  stage,
  env,
  ...laneProps(),
  table: data.table,
  userPool: data.userPool,
  filesBucket: data.filesBucket,
  cognitoDomain: data.cognitoDomain,
  // The three env-var credentials (config/ciSecrets.ts): the GitHub secret in CI — empty there fails the synth — else
  // a gitignored file generated once per stage.
  originSecret: stageSecret('ORIGIN_SECRET', stage),
  ...(domain ? { domainName: domain.domainName, certificateArn: domain.certificateArn } : {}),
  deviceToken: stageSecret('DEVICE_TOKEN', stage),
  deviceUserId: deviceUserIdFor(stage),
  agentToken: stageSecret('AGENT_TOKEN', stage),
});

// The dev account's id, for the hand-deployed stacks that live in or point at it (INFRA §2). Context, never
// committed. Pinning a stack to it makes CDK refuse credentials for any other account.
const devAccountId = app.node.tryGetContext('devAccountId') as string | undefined;
const mgmtAccountId = app.node.tryGetContext('mgmtAccountId') as string | undefined;
const need = (value: string | undefined, flag: string, stack: string): string => {
  if (!value) throw new Error(`${stack} needs -c ${flag}=…`);
  return value;
};

// CI/CD roles — one-off, per-account stacks (not per-stage), only built when a repo is supplied, so normal
// `cdk deploy ApertureApp-<stage>` runs don't need them. ApertureCicd is prod's (the management account):
// `cdk deploy ApertureCicd -c githubRepo=owner/repo`; ApertureCicdDev is the dev account's deploy + dev-logs roles,
// pinned to it: `cdk deploy ApertureCicdDev -c githubRepo=owner/repo -c devAccountId=… --profile aperture-dev`.
const githubRepo = app.node.tryGetContext('githubRepo') as string | undefined;
if (githubRepo) {
  // Override the OIDC subject segment when an org/enterprise enforces an ID-embedded sub claim.
  const githubSubject = app.node.tryGetContext('githubSubject') as string | undefined;
  new ApertureCicdStack(app, 'ApertureCicd', { env, githubRepo, githubSubject, roles: 'prod' });
  if (devAccountId)
    new ApertureCicdStack(app, 'ApertureCicdDev', {
      env: { ...env, account: devAccountId },
      githubRepo,
      githubSubject,
      roles: 'dev',
    });
}

// The dev account's guardrails (INFRA §3, docs/ops/CI-BOT.md → Kill switch) — two hand-deploys, one per side:
// ApertureOrg in the management account (the SCPs, the kill Lambda, the dev budget; us-east-1), ApertureDevGuard in
// the dev account (the kill alarms and their forwarding rule).
if (app.node.tryGetContext('org')) {
  const mgmt = need(mgmtAccountId, 'mgmtAccountId', 'ApertureOrg');
  new ApertureOrgStack(app, 'ApertureOrg', {
    env: { region: 'us-east-1', account: mgmt },
    devAccountId: need(devAccountId, 'devAccountId', 'ApertureOrg'),
    devOuId: need(app.node.tryGetContext('devOuId') as string | undefined, 'devOuId', 'ApertureOrg'),
  });
}
if (app.node.tryGetContext('devGuard')) {
  new ApertureDevGuardStack(app, 'ApertureDevGuard', {
    env: { ...env, account: need(devAccountId, 'devAccountId', 'ApertureDevGuard') },
    mgmtAccountId: need(mgmtAccountId, 'mgmtAccountId', 'ApertureDevGuard'),
  });
}

// Cost guardrails — another one-off hand-deploy (needs the account-root billing-access toggle; the
// pipeline never touches it): `cdk deploy ApertureBilling -c billing=true`. Billing is a global service;
// pin us-east-1 by convention (where Cost Explorer / anomaly data lives).
if (app.node.tryGetContext('billing')) {
  new ApertureBillingStack(app, 'ApertureBilling', { env: { region: 'us-east-1' } });
}

// Infra linter (cdk-nag v3, AwsSolutions pack). Runs during `cdk synth` via CDK's policy-validation
// framework — no AWS calls, keyless. Violations fail synth; fine-by-design findings are suppressed with a
// reason at their construct via `Validations.of(construct).acknowledge(...)` (see the stack files). Guards
// the things we built carefully (OAC, PITR) against a future refactor silently dropping them.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

// Fine-by-design suppressions for a single-user personal PWA — each acknowledged rule is a deliberate
// non-goal, not an oversight. The useful checks stay ACTIVE and will fail synth if regressed: OAC on the
// S3 origin, DynamoDB PITR, and S3/SNS TLS enforcement (enforceSSL, fixed rather than suppressed).
const ack = (scope: IConstruct, id: string, reason: string) => Validations.of(scope).acknowledge({ id, reason });
ack(data, 'AwsSolutions-COG1', 'Invite-only single-user pool; the operator sets their own password.');
ack(data, 'AwsSolutions-S1', 'Private files bucket reached only via short-lived presigned URLs; S3 access logs add a bucket + cost for no value on a single-user app.');
ack(data, 'AwsSolutions-COG2', 'No MFA — single-user personal app.');
ack(data, 'AwsSolutions-COG8', 'Cognito Plus tier (advanced security) is unwarranted for one user and costs money.');
ack(appStack, 'AwsSolutions-L1', 'Node 22 is the current LTS target; runtime bumps are deliberate, not gated on every deploy.');
// IAM4/IAM5 are granular rules — acknowledged on the BFF function construct itself (see app-stack.ts),
// since a stack-scope acknowledge doesn't reach their per-finding matches.
ack(appStack, 'AwsSolutions-S1', 'Private OAC bucket of re-syncable built assets; access logs add a bucket + cost for no value.');
ack(appStack, 'AwsSolutions-CFR1', 'No geo restriction — a personal single-user app.');
ack(appStack, 'AwsSolutions-CFR2', 'No WAF — single-user personal app, not worth the cost.');
ack(appStack, 'AwsSolutions-CFR3', 'No CloudFront access logs — single-user; adds a logging bucket + cost for no value.');
ack(appStack, 'AwsSolutions-CFR4', 'Default CloudFront cert (TLSv1 min) only in the pre-domain synth; prod serves on a custom-domain cert.');
