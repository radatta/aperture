// MCP as the test user: dev's /mcp accepts only tokens minted for the claude client (D14), so the harness
// signs the test user in as that client — authorization code + PKCE, no secret (a public client) — the way
// claude.ai's connector does. The redirect to claude.ai's callback never leaves the browser: Chromium resolves
// claude hosts nowhere (browser.ts) and a context route aborts any that slip past; the code is read from the
// request's URL and swapped at the dev pool's token endpoint. Nothing here is written to disk but the browser's
// own session file (mode 600); the tokens live in memory for the run. docs/ops/DEV-CHECK.md → MCP.
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { FetchLike } from './api';
import {
  CLAUDE_CALLBACK,
  MCP_SCOPES,
  assertDevCognitoUrl,
  isClaudeHost,
  type DevcheckEnv,
} from './config';
import { DevcheckError } from './errors';
import { submitHostedUiForm } from './login';
import type { PwContext } from './pw-types';
import { assertTestUser, decodeJwtPayload, type Session } from './token';

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export interface McpSession extends Session {
  clientId: string;
}

const fail = (msg: string) => new DevcheckError('MCP_AUTH_FAILED', msg);

export function makePkce(random: (n: number) => Buffer = randomBytes): Pkce {
  const verifier = random(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: random(16).toString('base64url'),
  };
}

export function authorizeUrl(env: DevcheckEnv, pkce: Pkce): string {
  const url = `https://${env.DEVCHECK_COGNITO_HOST}/oauth2/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: env.DEVCHECK_CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_CALLBACK,
    scope: MCP_SCOPES.join(' '),
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  })}`;
  assertDevCognitoUrl(url, env.DEVCHECK_COGNITO_HOST, '/oauth2/authorize');
  return url;
}

// The code from the callback the browser was sent to. Messages name what was wrong, never the code or state.
export function parseCallback(url: string, expectedState: string): string {
  const u = new URL(url);
  const callback = new URL(CLAUDE_CALLBACK);
  if (u.origin !== callback.origin || u.pathname !== callback.pathname)
    throw fail(`the sign-in went to ${u.origin}${u.pathname}, not the registered callback`);
  const error = u.searchParams.get('error');
  if (error) throw fail(`Cognito refused the sign-in: ${error}`);
  if (u.searchParams.get('state') !== expectedState)
    throw fail('the callback state does not match');
  const code = u.searchParams.get('code');
  if (!code) throw fail('the callback carries no code');
  return code;
}

// Exchange the code at the dev pool's token endpoint. An error names Cognito's `error` field only — the
// body of a success holds the tokens, and nothing here ever prints a body.
export async function swapCode(
  fetch: FetchLike,
  env: DevcheckEnv,
  code: string,
  verifier: string,
  now: () => number,
): Promise<McpSession> {
  const url = `https://${env.DEVCHECK_COGNITO_HOST}/oauth2/token`;
  assertDevCognitoUrl(url, env.DEVCHECK_COGNITO_HOST, '/oauth2/token');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.DEVCHECK_CLAUDE_CLIENT_ID,
      code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
    }).toString(),
    redirect: 'error',
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON — reported by status alone
  }
  if (res.status !== 200)
    throw fail(
      `the token endpoint answered HTTP ${res.status}${typeof body.error === 'string' ? ` ${body.error}` : ''}`,
    );
  const { access_token, id_token, expires_in } = body;
  if (typeof access_token !== 'string' || typeof id_token !== 'string')
    throw fail('the token endpoint returned no access or id token');
  const id = decodeJwtPayload(id_token);
  const access = decodeJwtPayload(access_token);
  return {
    accessToken: access_token,
    expiresAt:
      typeof access.exp === 'number'
        ? access.exp
        : Math.floor(now() / 1000) + (typeof expires_in === 'number' ? expires_in : 0),
    email: typeof id.email === 'string' ? id.email : '',
    sub: typeof id.sub === 'string' ? id.sub : '',
    clientId: typeof access.client_id === 'string' ? access.client_id : '',
  };
}

// The same identity guard as the app's session (WRONG_USER), plus: an access token minted for the claude
// client, the only one /mcp accepts.
export function assertMcpTestUser(s: McpSession, env: DevcheckEnv): void {
  assertTestUser(s, env.DEVCHECK_SUB);
  const access = decodeJwtPayload(s.accessToken);
  if (s.clientId !== env.DEVCHECK_CLAUDE_CLIENT_ID || access.token_use !== 'access')
    throw fail('the token was not minted as the claude client’s access token');
}

// Read per call; a token with under 30 s left fails the step rather than a request mid-flight.
export function mcpToken(s: McpSession, now: () => number): string {
  if (s.expiresAt * 1000 - now() < 30_000) throw fail('the MCP token has expired — rerun');
  return s.accessToken;
}

// Every claude.ai / claude.com request any page in the context makes is aborted. Playwright routes only the
// first URL of a redirect chain, so the sign-in's 302 to the callback is stopped by the resolver rule
// instead (browser.ts); this is the wall for any direct request.
export async function blockClaude(context: PwContext): Promise<void> {
  await context.route(
    (u) => isClaudeHost(u.hostname),
    (route) => route.abort('blockedbyclient'),
  );
}

export async function ensureMcpSignedIn(
  context: PwContext,
  env: DevcheckEnv,
  deps: {
    fetch: FetchLike;
    shot: (name: string) => Promise<void>;
    statePath: string;
    log: (msg: string) => void;
    now: () => number;
    callbackWaitMs?: number;
  },
): Promise<McpSession> {
  const pkce = makePkce();
  const url = authorizeUrl(env, pkce);
  const page = await context.newPage();
  // Every request the sign-in makes to a claude host — the callback, and nothing else, exactly once.
  const toClaude: string[] = [];
  let seen: (() => void) | undefined;
  const arrived = new Promise<void>((res) => (seen = res));
  page.on('request', (req) => {
    if (!isClaudeHost(new URL(req.url()).hostname)) return;
    toClaude.push(req.url());
    seen?.();
  });
  try {
    let form = false;
    // The callback can't load (no claude host resolves), so the navigation itself fails once it gets there.
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    if (!toClaude.length) {
      const at = new URL(page.url());
      if (at.hostname === env.DEVCHECK_COGNITO_HOST && at.pathname !== '/error') {
        form = true; // no Hosted UI session cookie for this run: the classic form, as the app's sign-in
        await submitHostedUiForm(page, env, deps.shot);
      } else if (at.hostname === env.DEVCHECK_COGNITO_HOST) {
        await deps.shot('mcp-auth-rejected');
        throw fail(
          `Cognito refused the sign-in: ${at.searchParams.get('error') ?? 'an error page'}`,
        );
      }
    }
    const wait = deps.callbackWaitMs ?? 20_000;
    const timeout = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), wait).unref());
    if ((await Promise.race([arrived.then(() => 'ok' as const), timeout])) === 'timeout') {
      await deps.shot('mcp-no-callback');
      throw fail(`the sign-in never reached the callback (on ${new URL(page.url()).host})`);
    }
    if (toClaude.length !== 1)
      throw fail(
        `the sign-in sent ${toClaude.length} requests to a claude host, expected the one callback`,
      );
    const code = parseCallback(toClaude[0]!, pkce.state);
    const session = await swapCode(deps.fetch, env, code, pkce.verifier, deps.now);
    assertMcpTestUser(session, env);
    // The Hosted UI cookie the sign-in may have refreshed — mode 600 from the start, as ensureSignedIn.
    writeFileSync(deps.statePath, JSON.stringify(await context.storageState()), { mode: 0o600 });
    deps.log(
      `mcp: signed in as the test user via the claude client (form ${form ? 'shown' : 'skipped'}), callback aborted ×1`,
    );
    return session;
  } finally {
    await page.close().catch(() => undefined);
  }
}
