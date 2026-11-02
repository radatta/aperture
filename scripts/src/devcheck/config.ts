// Where the dev check may point and who it signs in as. Both are constants on purpose: the harness writes
// data, so it must be impossible to aim it at prod or at the user's own account by config.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DevcheckError } from './errors';

export const DEV_ORIGIN = 'https://dev.aperture.rahuldatta.dev';
export const TEST_USER_EMAIL = 'rahul3datta+devcheck@gmail.com';
// packages/shared/src/rpc.ts AUTH_HEADER — the BFF reads the JWT here (CloudFront owns Authorization).
export const AUTH_HEADER = 'x-aperture-authorization';

export function assertDevOrigin(url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error(`refusing a non-URL target: ${url}`);
  }
  if (origin !== DEV_ORIGIN)
    throw new Error(`refusing ${origin} — the dev check only talks to ${DEV_ORIGIN}`);
}

// The one other origin the harness may touch: a presigned URL the dev BFF minted for the test user's own
// attachment (the attachment-delete scenario's PUT and probes). The host is the dev Files bucket's CDK name
// (stack ApertureData-dev, construct Files) — never another bucket, prod's included — the key sits under
// the per-user u/ prefix, and the URL carries a SigV4 signature.
const DEV_FILES_HOST = /^aperturedata-dev-files[a-z0-9-]+\.s3\.us-west-1\.amazonaws\.com$/;

export function assertPresignedDevUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('refusing a non-URL presigned target');
  }
  if (u.protocol !== 'https:' || u.port || !DEV_FILES_HOST.test(u.hostname))
    throw new Error(`refusing ${u.origin} — not the dev Files bucket`);
  if (!u.pathname.startsWith('/u/')) throw new Error(`refusing ${u.pathname} — not under u/`);
  if (!u.searchParams.get('X-Amz-Signature')) throw new Error('refusing an unsigned URL');
}

// MCP as the test user: the harness signs in as the claude client (authorization code + PKCE, a public client)
// and catches the redirect to claude.ai's callback in the browser. CLAUDE_CALLBACK must equal a registered
// callback (cdk/src/config/claudeConnector.ts) or Cognito answers redirect_mismatch — it is only ever a
// parameter value: no request to a claude host ever leaves the harness (isClaudeHost, blockClaude).
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const MCP_SCOPES = ['openid', 'email', `${DEV_ORIGIN}/mcp/access`];
export const isClaudeHost = (hostname: string): boolean =>
  /(^|\.)claude\.(ai|com)$/.test(hostname.toLowerCase());

// The dev pool's Hosted UI (the CDK domain prefix carries the dev account id), and only the env's host on it.
const DEV_COGNITO_HOST = /^aperture-dev-[0-9]{12}\.auth\.us-west-1\.amazoncognito\.com$/;

export function assertDevCognitoUrl(
  url: string,
  host: string,
  path: '/oauth2/authorize' | '/oauth2/token',
): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('refusing a non-URL Cognito target');
  }
  if (u.protocol !== 'https:' || u.port || u.hostname !== host || !DEV_COGNITO_HOST.test(host))
    throw new Error(`refusing ${u.origin} — not the dev pool's Hosted UI`);
  if (u.pathname !== path) throw new Error(`refusing ${u.pathname} — expected ${path}`);
}

export const ENV_KEYS = [
  'DEVCHECK_EMAIL',
  'DEVCHECK_PASSWORD',
  'DEVCHECK_SUB',
  'DEVCHECK_COGNITO_HOST',
  'DEVCHECK_CLIENT_ID',
  'DEVCHECK_POOL_ID',
  'DEVCHECK_CLAUDE_CLIENT_ID', // aperture-claude-dev — the only client dev's /mcp accepts (D14)
] as const;
export type DevcheckEnv = Record<(typeof ENV_KEYS)[number], string>;

// KEY=VALUE lines; blank lines and # comments skipped; the value is everything after the first '='.
export function parseEnv(text: string): DevcheckEnv {
  const vars: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) vars[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const missing = ENV_KEYS.filter((k) => !vars[k]);
  if (missing.length) throw new DevcheckError('ENV_MISSING', `missing ${missing.join(', ')}`);
  if (vars.DEVCHECK_EMAIL !== TEST_USER_EMAIL)
    throw new DevcheckError(
      'WRONG_USER',
      `env file names ${vars.DEVCHECK_EMAIL}, not the test user`,
    );
  return Object.fromEntries(ENV_KEYS.map((k) => [k, vars[k]!])) as DevcheckEnv;
}

// The main checkout, from any worktree: the git common dir's parent. Secrets and the shared devcheck home
// live there so every worktree sees one copy and removing a worktree loses neither.
export function mainCheckout(cwd = process.cwd()): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  return dirname(common);
}

export function worktreeRoot(cwd = process.cwd()): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

export const secretsDir = (main: string): string => join(main, '.secrets');
export const envPath = (main: string): string => join(secretsDir(main), 'devcheck.dev.env');
export const statePath = (main: string): string =>
  join(secretsDir(main), 'devcheck.dev.state.json');
// Shared across worktrees (the cross-run ledger lives here); per-run artifacts go to the worktree instead.
export const devcheckHome = (main: string): string => join(main, 'localNotes', 'devcheck');
export const runDir = (worktree: string, runId: string): string =>
  resolve(worktree, 'localNotes', 'devcheck', runId);

export function loadEnv(path: string, warn: (msg: string) => void = console.warn): DevcheckEnv {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new DevcheckError(
      'ENV_MISSING',
      `${path} not found — docs/ops/DEV-CHECK.md → One-time setup, step 1`,
    );
  }
  if ((statSync(path).mode & 0o077) !== 0) warn(`${path} is readable by others — chmod 600 it`);
  return parseEnv(text);
}
