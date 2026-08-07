import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { ApertureDataStack } from '../lib/data-stack';
import { ApertureAppStack } from '../lib/app-stack';
import { ApertureCicdStack } from '../lib/cicd-stack';

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
new ApertureAppStack(app, `ApertureApp-${stage}`, {
  stage,
  env,
  table: data.table,
  userPool: data.userPool,
  originSecret: originSecretFor(stage),
});

// CI/CD roles — a one-off, account-wide stack (not per-stage). Only built when a repo is supplied, so
// normal `cdk deploy ApertureApp-<stage>` runs don't need it: deploy it once with
// `cdk deploy ApertureCicd -c githubRepo=owner/repo`.
const githubRepo = app.node.tryGetContext('githubRepo') as string | undefined;
if (githubRepo) new ApertureCicdStack(app, 'ApertureCicd', { env, githubRepo });
