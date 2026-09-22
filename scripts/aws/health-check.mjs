// Post-deploy synthetic health check: hits the REAL public HTTPS endpoints to prove the whole
// CloudFront → Function URL → Lambda path (and the origin-secret gate) works end-to-end — something the
// `aws lambda invoke` smoke test can't see, since it bypasses CloudFront entirely. Reads AppUrl +
// FunctionUrl from cdk-outputs.<stage>.json (written by `cdk deploy`). Exits non-zero on any failed check.
// Uses Node's global fetch (Node 22) — no curl/jq. Assumes the CloudFront invalidation is already
// complete (publish-frontend.mjs waits for it before this runs).
// Usage: node scripts/aws/health-check.mjs [dev|prod]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stage = process.argv[2] ?? 'dev';
const root = fileURLToPath(new URL('../..', import.meta.url));
const outputs = JSON.parse(readFileSync(`${root}/cdk/cdk-outputs.${stage}.json`, 'utf8'));
const app = outputs[`ApertureApp-${stage}`];
if (!app?.AppUrl || !app?.FunctionUrl) throw new Error(`Missing AppUrl/FunctionUrl in cdk-outputs.${stage}.json`);

const appUrl = app.AppUrl.replace(/\/$/, '');
const fnUrl = app.FunctionUrl.replace(/\/$/, '');

let failures = 0;
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
};

console.log(`\n▶ Health check ${stage} → ${appUrl}`);

await check('app shell 200', async () => {
  const r = await fetch(`${appUrl}/`);
  expect(r.status === 200, `expected 200, got ${r.status}`);
});

await check('manifest served as application/manifest+json', async () => {
  const r = await fetch(`${appUrl}/manifest.webmanifest`);
  expect(r.status === 200, `expected 200, got ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';
  expect(ct.includes('application/manifest+json'), `content-type was "${ct}"`);
});

await check('SPA fallback (deep route → app shell 200)', async () => {
  const r = await fetch(`${appUrl}/some/deep/route-${stage}`);
  expect(r.status === 200, `expected 200 (fallback to index.html), got ${r.status}`);
});

await check('edge → Lambda: CloudFront stamps origin secret → /api/health 200', async () => {
  const r = await fetch(`${appUrl}/api/health`);
  expect(r.status === 200, `expected 200 through CloudFront, got ${r.status}`);
  const body = await r.json();
  expect(body?.ok === true, `unexpected body ${JSON.stringify(body)}`);
});

await check('origin-secret gate enforced: direct Function URL, no header → 403', async () => {
  const r = await fetch(`${fnUrl}/api/health`);
  expect(r.status === 403, `expected 403 without the secret header, got ${r.status}`);
});

// MCP edge: proves the /mcp behavior routes to the second Lambda and its auth gate holds — WITHOUT
// putting the agent token in CI logs (a credential-less POST must be refused, a GET method-rejected).
await check('MCP edge: POST /mcp with no agent token → 401', async () => {
  const r = await fetch(`${appUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  expect(r.status === 401, `expected 401 without the agent token, got ${r.status}`);
});

await check('MCP edge: GET /mcp → 405 (POST only)', async () => {
  const r = await fetch(`${appUrl}/mcp`);
  expect(r.status === 405, `expected 405 for GET, got ${r.status}`);
});

// Phase 2 (claude.ai OAuth): the metadata façade must advertise the PKCE field Cognito omits and name OUR
// origin as issuer; the protected-resource doc must serve at the path-suffixed URL claude.ai probes first;
// and a bearer token must reach the Lambda (R7).
await check('MCP façade: /.well-known/oauth-authorization-server advertises S256 + our issuer', async () => {
  const r = await fetch(`${appUrl}/.well-known/oauth-authorization-server`);
  expect(r.status === 200, `expected 200, got ${r.status}`);
  const body = await r.json();
  expect(
    Array.isArray(body?.code_challenge_methods_supported) && body.code_challenge_methods_supported.includes('S256'),
    `code_challenge_methods_supported was ${JSON.stringify(body?.code_challenge_methods_supported)}`,
  );
  expect(body?.issuer === appUrl, `issuer was "${body?.issuer}", expected "${appUrl}"`);
});

await check('MCP façade: /.well-known/oauth-protected-resource/mcp names /mcp as the resource', async () => {
  const r = await fetch(`${appUrl}/.well-known/oauth-protected-resource/mcp`);
  expect(r.status === 200, `expected 200, got ${r.status}`);
  const body = await r.json();
  expect(body?.resource === `${appUrl}/mcp`, `resource was "${body?.resource}"`);
});

// "invalid token" is the proof Authorization arrived: the verifier ran and rejected the fake JWT. If
// CloudFront dropped the header, the body reads "requires a credential" instead. The Lambda also sends
// WWW-Authenticate, but a Function URL renames it on every 401 (AWS security behavior) to
// x-amzn-remapped-www-authenticate — claude.ai then falls back to probing the well-known paths above.
await check('MCP edge: POST /mcp with a bearer token → 401 "invalid token" (proves Authorization arrives)', async () => {
  const r = await fetch(`${appUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-jwt' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  expect(r.status === 401, `expected 401, got ${r.status}`);
  const body = await r.json();
  expect(body?.error === 'Unauthorized: invalid token', `body was ${JSON.stringify(body)}`);
  const pointer = r.headers.get('x-amzn-remapped-www-authenticate') ?? '';
  expect(pointer.includes('resource_metadata'), `x-amzn-remapped-www-authenticate was "${pointer}"`);
});

if (failures) {
  console.error(`\n✗ health check FAILED: ${failures} check(s)\n`);
  process.exit(1);
}
console.log(`\n✓ health check passed (${stage})\n`);
