// Where the dev check may point and who it signs in as. Both are constants on purpose: the harness writes
// data, so it must be impossible to aim it at prod or at the user's own account by config. The dev account has two
// slots (INFRA §2) — `dev` and `devb` — and which one a run targets comes only from the dev lock its branch holds
// (slot.ts → useSlot), never a flag.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DevcheckError } from './errors';

export const DEV_ORIGIN = 'https://dev.aperture.rahuldatta.dev';
export const DEVB_ORIGIN = 'https://devb.aperture.rahuldatta.dev';

// Each slot's three addresses: its origin, its Files bucket (the CDK name of stack ApertureData-<slot>, construct
// Files — never another bucket, prod's included) and its pool's Hosted UI (the CDK prefix carries the account id).
export type Slot = 'dev' | 'devb';
export const SLOTS: readonly Slot[] = ['dev', 'devb']; // = @aperture/shared DEV_SLOTS (config.test pins it)
interface SlotTarget {
  origin: string;
  filesHost: RegExp;
  cognitoHost: RegExp;
}
export const SLOT_TARGETS: Record<Slot, SlotTarget> = {
  dev: {
    origin: DEV_ORIGIN,
    filesHost: /^aperturedata-dev-files[a-z0-9-]+\.s3\.us-west-1\.amazonaws\.com$/,
    cognitoHost: /^aperture-dev-[0-9]{12}\.auth\.us-west-1\.amazoncognito\.com$/,
  },
  devb: {
    origin: DEVB_ORIGIN,
    filesHost: /^aperturedata-devb-files[a-z0-9-]+\.s3\.us-west-1\.amazonaws\.com$/,
    cognitoHost: /^aperture-devb-[0-9]{12}\.auth\.us-west-1\.amazoncognito\.com$/,
  },
};

// The slot this run targets: slot A until useSlot (run.ts, from the branch's lock) says otherwise.
let slot: Slot = 'dev';
export const currentSlot = (): Slot => slot;
export const slotOrigin = (): string => SLOT_TARGETS[slot].origin;

export const TEST_USER_EMAIL = 'rahul3datta+devcheck@gmail.com';
// packages/shared/src/rpc.ts AUTH_HEADER — the BFF reads the JWT here (CloudFront owns Authorization).
export const AUTH_HEADER = 'x-aperture-authorization';

// The origin this run talks to: the slot's, unless the local check (local/run-local.ts) bound its own loopback
// server and switched to it. Only a dev slot or a loopback http origin is accepted, so no config can aim a run at prod.
let target = DEV_ORIGIN;
export const targetOrigin = (): string => target;
export function useSlot(s: Slot): void {
  if (!SLOTS.includes(s)) throw new Error(`refusing slot ${String(s)} — only ${SLOTS.join(', ')}`);
  slot = s;
  target = SLOT_TARGETS[s].origin;
}
export function useLocalOrigin(origin: string): void {
  const u = new URL(origin);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.origin !== origin)
    throw new Error(`refusing ${origin} — the local check only talks to its own 127.0.0.1 server`);
  target = origin;
}

export function assertDevOrigin(url: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error(`refusing a non-URL target: ${url}`);
  }
  if (origin !== target)
    throw new Error(`refusing ${origin} — the dev check only talks to ${target}`);
}

// The one other origin the harness may touch: a presigned URL the dev BFF minted for the test user's own
// attachment (the attachment-delete scenario's PUT and probes). The host is the slot's Files bucket
// (SLOT_TARGETS), the key sits under the per-user u/ prefix, and the URL carries a SigV4 signature.

export function assertPresignedDevUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('refusing a non-URL presigned target');
  }
  if (u.protocol !== 'https:' || u.port || !SLOT_TARGETS[slot].filesHost.test(u.hostname))
    throw new Error(`refusing ${u.origin} — not the ${slot} Files bucket`);
  if (!u.pathname.startsWith('/u/')) throw new Error(`refusing ${u.pathname} — not under u/`);
  if (!u.searchParams.get('X-Amz-Signature')) throw new Error('refusing an unsigned URL');
}

// MCP as the test user: the harness signs in as the claude client (authorization code + PKCE, a public client)
// and catches the redirect to claude.ai's callback in the browser. CLAUDE_CALLBACK must equal a registered
// callback (cdk/src/config/claudeConnector.ts) or Cognito answers redirect_mismatch — it is only ever a
// parameter value: no request to a claude host ever leaves the harness (isClaudeHost, blockClaude).
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
// The resource server's identifier is the slot's own `<origin>/mcp` (app-stack.ts; lambdas/src/mcp/wellKnown.ts).
export const mcpScopes = (): string[] => ['openid', 'email', `${slotOrigin()}/mcp/access`];
export const isClaudeHost = (hostname: string): boolean =>
  /(^|\.)claude\.(ai|com)$/.test(hostname.toLowerCase());

// The slot pool's Hosted UI (SLOT_TARGETS), and only the env's host on it.

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
  if (
    u.protocol !== 'https:' ||
    u.port ||
    u.hostname !== host ||
    !SLOT_TARGETS[slot].cognitoHost.test(host)
  )
    throw new Error(`refusing ${u.origin} — not the ${slot} pool's Hosted UI`);
  if (u.pathname !== path) throw new Error(`refusing ${u.pathname} — expected ${path}`);
}

export const ENV_KEYS = [
  'DEVCHECK_EMAIL',
  'DEVCHECK_PASSWORD',
  'DEVCHECK_SUB',
  'DEVCHECK_COGNITO_HOST',
  'DEVCHECK_CLIENT_ID',
  'DEVCHECK_POOL_ID',
  'DEVCHECK_CLAUDE_CLIENT_ID', // aperture-claude-<slot> — the only client the slot's /mcp accepts (D14)
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
// Per slot: the test user's env file (written by the user's one-time setup line), the signed-in browser state and the
// cross-run ledger. The one-run-at-a-time lock stays shared until the dev account's Lambda quota is past both slots'
// reservations: at quota 10 two runs (~10 calls in flight each) throttle each other (CI-BOT.md → Compute). Flip
// PER_SLOT_RUNS once `get-account-settings` reads ≥ 160 and caps' reservations are in.
export const PER_SLOT_RUNS = false;
export const envPath = (main: string, s: Slot = slot): string =>
  join(secretsDir(main), `devcheck.${s}.env`);
export const statePath = (main: string, s: Slot = slot): string =>
  join(secretsDir(main), `devcheck.${s}.state.json`);
export const ledgerFile = (s: Slot = slot): string => `ledger.${s}.jsonl`;
export const runLockFile = (s: Slot = slot): string =>
  s === 'dev' || !PER_SLOT_RUNS ? 'run.lock' : `run.${s}.lock`;
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
