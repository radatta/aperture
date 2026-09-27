// Publish the dashboard to a deployed env: build with that env's CDK outputs baked in, sync to S3,
// invalidate CloudFront. Reads cdk/cdk-outputs.<stage>.json (written by `cdk deploy`). Needs AWS creds
// + the `aws` CLI (only for the sync/invalidate). Creates the invalidation and returns without waiting —
// health-check.mjs polls the edge for the new shell instead.
// Usage: node scripts/aws/publish-frontend.mjs [dev|prod] [--profile <name>]
// If your creds live in a named profile (no default), pass --profile — it's applied ONLY to the aws
// commands (vite has its own --profile CPU-profiling flag, so never let it leak into the build). You can
// equivalently `export AWS_PROFILE=<name>` and drop the flag; the aws CLI honors it natively.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const profileIdx = args.indexOf('--profile');
const profile = profileIdx !== -1 ? args[profileIdx + 1] : undefined;
const stage = args.find((a) => !a.startsWith('--') && a !== profile) ?? 'dev';
const profileFlag = profile ? ` --profile ${profile}` : '';

const root = fileURLToPath(new URL('../..', import.meta.url));
const outputs = JSON.parse(readFileSync(`${root}/cdk/cdk-outputs.${stage}.json`, 'utf8'));

const app = outputs[`ApertureApp-${stage}`];
const data = outputs[`ApertureData-${stage}`];
if (!app || !data) throw new Error(`Missing stacks in cdk-outputs.${stage}.json`);

const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });

console.log(`\n▶ Building dashboard for ${stage} → ${app.AppUrl}`);
run('pnpm --filter @aperture/app build', {
  env: {
    ...process.env,
    VITE_API_MODE: 'http',
    VITE_API_BASE: app.AppUrl,
    VITE_COGNITO_AUTHORITY: data.CognitoAuthority,
    VITE_COGNITO_CLIENT_ID: app.UserPoolClientId,
  },
});

const bucket = app.SiteBucket;
console.log(`\n▶ Syncing to s3://${bucket}`);
// Two-pass sync so the app shell can't go stale. Hashed files in assets/ are immutable → cache forever.
run(
  `aws s3 sync app/dist/assets "s3://${bucket}/assets" --cache-control "public,max-age=31536000,immutable"${profileFlag}`,
);
// Everything else (index.html, icons, …) must revalidate so a client never holds a stale shell.
// --exclude assets/* leaves the immutable pass above untouched and means old hashes are never deleted, so
// in-flight clients can still load old chunks. sw.js and the manifest are excluded here (and so from
// --delete) because the two cp's below upload them with a pinned Content-Type — one PUT each, not two.
run(
  `aws s3 sync app/dist "s3://${bucket}" --delete --exclude "assets/*" --exclude "manifest.webmanifest" --exclude "sw.js" --cache-control "no-cache,no-store,must-revalidate"${profileFlag}`,
);
// Pin Content-Type on the PWA files — s3 sync guesses by extension and can serve .webmanifest as
// octet-stream (Chrome ignores it → no install). Host-independent; no-cache so SW/manifest updates
// always revalidate at the edge.
run(
  `aws s3 cp app/dist/manifest.webmanifest "s3://${bucket}/manifest.webmanifest" --content-type "application/manifest+json" --cache-control "no-cache,no-store,must-revalidate"${profileFlag}`,
);
run(
  `aws s3 cp app/dist/sw.js "s3://${bucket}/sw.js" --content-type "text/javascript" --cache-control "no-cache,no-store,must-revalidate"${profileFlag}`,
);

console.log(`\n▶ Invalidating CloudFront ${app.DistributionId}`);
// Fire and forget. The shell is uploaded no-store, the default behaviour's min TTL is 1s and the SPA
// error-fallback responses have ttl 0, so the edge serves the new build within ~1s regardless. Waiting
// cost a flat 20–22s per stage (the CLI waiter polls every 20s) and proved nothing the health check's
// shell poll doesn't prove directly. The id is logged for `aws cloudfront get-invalidation`.
const invJson = execSync(
  `aws cloudfront create-invalidation --distribution-id ${app.DistributionId} --paths "/*" --output json${profileFlag}`,
  { cwd: root, encoding: 'utf8' },
);
console.log(
  `  invalidation ${JSON.parse(invJson).Invalidation.Id} created — not waiting; health-check polls the edge`,
);

console.log(`\n✓ Published ${stage} → ${app.AppUrl}\n`);
