import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App, Validations } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ApertureDataStack } from '../lib/data-stack';
import { ApertureAppStack } from '../lib/app-stack';
import { ApertureCicdStack } from '../lib/cicd-stack';
import { ApertureBillingStack } from '../lib/billing-stack';
import { domainConfigFor } from '../config/domains';

// CloudFront→Lambda origin-lockdown secret, one per stage. In CI it comes from a GitHub secret via
// APERTURE_ORIGIN_SECRET (stable across runs); locally it's generated once into a gitignored file and
// reused so CloudFront + the Lambda always agree. Never committed. Anti-abuse only.
function originSecretFor(stage: string): string {
  const fromEnv = process.env.APERTURE_ORIGIN_SECRET;
  if (fromEnv) return fromEnv.trim();
  const dir = fileURLToPath(new URL('../../.secrets', import.meta.url)); // cdk/.secrets/
  const file = `${dir}/origin-secret.${stage}`;
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(24).toString('hex');
  writeFileSync(file, `${secret}\n`);
  return secret;
}

// Two stacks per stage. Region pinned to us-west-1; account comes from the deploying credentials
// (CDK_DEFAULT_ACCOUNT), so nothing account-specific is committed. `-c stage=prod` for prod.
const app = new App();
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const env = { region: 'us-west-1' };

const data = new ApertureDataStack(app, `ApertureData-${stage}`, { stage, env });
// Custom domain (Phase 14): undefined until the stage's cert ARN is wired (APERTURE_CERT_ARN) →
// stays on the CloudFront default domain, so this is a no-op before the domain step.
const domain = domainConfigFor(stage);
const appStack = new ApertureAppStack(app, `ApertureApp-${stage}`, {
  stage,
  env,
  table: data.table,
  userPool: data.userPool,
  originSecret: originSecretFor(stage),
  ...(domain ? { domainName: domain.domainName, certificateArn: domain.certificateArn } : {}),
});

// CI/CD roles — a one-off, account-wide stack (not per-stage). Only built when a repo is supplied, so
// normal `cdk deploy ApertureApp-<stage>` runs don't need it: deploy it once with
// `cdk deploy ApertureCicd -c githubRepo=owner/repo`.
const githubRepo = app.node.tryGetContext('githubRepo') as string | undefined;
if (githubRepo) {
  // Override the OIDC subject segment when an org/enterprise enforces an ID-embedded sub claim.
  const githubSubject = app.node.tryGetContext('githubSubject') as string | undefined;
  new ApertureCicdStack(app, 'ApertureCicd', { env, githubRepo, githubSubject });
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
