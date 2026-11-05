// Publish the dashboard to a deployed env: build with that env's CDK outputs baked in, sync to S3. Reads
// cdk/cdk-outputs.<stage>.json (written by `cdk deploy`). Needs AWS creds + the `aws` CLI (only for the sync).
// No CloudFront invalidation (below); health-check.mjs polls the edge for the new shell instead.
// Usage: node scripts/aws/publish-frontend.mjs [dev|prod] [--profile <name>]
// If your creds live in a named profile (no default), pass --profile — it's applied ONLY to the aws
// commands (vite has its own --profile CPU-profiling flag, so never let it leak into the build). You can
// equivalently `export AWS_PROFILE=<name>` and drop the flag; the aws CLI honors it natively.
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW_LENGTH_META, brotliWasm } from './flux-wasm.mjs';

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
    // The build marker (app/index.html meta + Settings stamp). APERTURE_BUILD_SHA wins when a workflow deploys
    // a ref other than the one it runs on (a dispatched deploy's GITHUB_SHA is main's); health-check asserts it.
    VITE_BUILD_SHA: process.env.APERTURE_BUILD_SHA || process.env.GITHUB_SHA || 'local',
  },
});

const bucket = app.SiteBucket;
console.log(`\n▶ Syncing to s3://${bucket}`);
// Two-pass sync so the app shell can't go stale. Hashed files in assets/ are immutable → cache forever.
// .wasm is excluded here and uploaded one by one below: brotli-encoded (CloudFront compresses nothing over
// 10 MB; flux-wasm.mjs), with a pinned Content-Type — Safari's streaming compile refuses anything but
// application/wasm, and sync guesses by extension — and the decoded size as metadata for the progress bar.
// The build names it *.br.wasm so the encoded body never lands under a key an edge holds uncompressed
// (docs/areas/flux D63). The compressed copy is written to a temp dir; app/dist stays what the build made.
run(
  `aws s3 sync app/dist/assets "s3://${bucket}/assets" --exclude "*.wasm" --cache-control "public,max-age=31536000,immutable"${profileFlag}`,
);
const brDir = mkdtempSync(join(tmpdir(), 'aperture-wasm-'));
try {
  for (const name of readdirSync(`${root}/app/dist/assets`).filter((f) => f.endsWith('.br.wasm'))) {
    const { body, rawLength } = brotliWasm(readFileSync(`${root}/app/dist/assets/${name}`));
    console.log(
      `  brotli ${name}: ${rawLength.toLocaleString()} → ${body.byteLength.toLocaleString()} B`,
    );
    writeFileSync(join(brDir, name), body);
    run(
      `aws s3 cp "${join(brDir, name)}" "s3://${bucket}/assets/${name}" --content-type "application/wasm" --content-encoding br --metadata ${RAW_LENGTH_META}=${rawLength} --cache-control "public,max-age=31536000,immutable"${profileFlag}`,
    );
  }
} finally {
  rmSync(brDir, { recursive: true, force: true });
}
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

// No CloudFront invalidation. Every file outside assets/ is uploaded no-store, the default behaviour's min TTL is
// 1s and the SPA error-fallback responses have ttl 0, so the edge serves the new build within ~1s; assets/ names
// are content-hashed, so a new build never reuses one. An invalidation proved nothing the health check's shell
// poll doesn't, and paths past the free 1,000 a month bill per path — neither GitHub role may create one (INFRA §9).

console.log(`\n✓ Published ${stage} → ${app.AppUrl}\n`);
