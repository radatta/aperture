// MCP as the test user: dev's /mcp accepts only tokens minted for the claude client (D14), so the harness
// signs the test user in as that client — authorization code + PKCE, no secret (a public client) — the way
// claude.ai's connector does. The redirect to claude.ai's callback never leaves the browser: Chromium resolves
// claude hosts nowhere (browser.ts), the sign-in page's route aborts any direct request, and the sign-in proves
// the callback failed; the code is read from the request's URL and swapped at the dev pool's token endpoint. Nothing here is written to disk but the browser's
// own session file (mode 600); the tokens live in memory for the run. docs/ops/DEV-CHECK.md → MCP.
import { createHash, randomBytes } from 'node:crypto';
import type { FetchLike } from './api';
import {
  CLAUDE_CALLBACK,
  MCP_SCOPES,
  assertDevCognitoUrl,
  isClaudeHost,
  type DevcheckEnv,
} from './config';
import { DevcheckError } from './errors';
import { saveState, submitHostedUiForm } from './login';
import type { PwContext, PwPage, PwRequest } from './pw-types';
import { assertTestUser, decodeJwtPayload, nearExpiry, tokenGrant, type Session } from './token';

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

// Exchange the code at the dev pool's token endpoint (token.ts tokenGrant).
export const swapCode = (
  fetch: FetchLike,
  env: DevcheckEnv,
  code: string,
  verifier: string,
  now: () => number,
): Promise<McpSession> =>
  tokenGrant(
    fetch,
    env.DEVCHECK_COGNITO_HOST,
    {
      grant_type: 'authorization_code',
      client_id: env.DEVCHECK_CLAUDE_CLIENT_ID,
      code,
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: verifier,
    },
    now,
    fail,
  );

// The same identity guard as the app's session (WRONG_USER), plus: an access token minted for the claude
// client, the only one /mcp accepts.
export function assertMcpTestUser(s: McpSession, env: DevcheckEnv): void {
  assertTestUser(s, env.DEVCHECK_SUB);
  const access = decodeJwtPayload(s.accessToken);
  if (s.clientId !== env.DEVCHECK_CLAUDE_CLIENT_ID || access.token_use !== 'access')
    throw fail('the token was not minted as the claude client’s access token');
}

// Read per call; a token within the shared margin (token.ts) fails the step rather than a request mid-flight:
// the MCP session keeps no refresh token to renew with.
export function mcpToken(s: McpSession, now: () => number): string {
  if (nearExpiry(s, now())) throw fail('the MCP token has expired — rerun');
  return s.accessToken;
}

// The sign-in page's own guard: any direct request to a claude host is aborted. Playwright routes only the
// first URL of a redirect chain, so the 302 to the callback isn't routed — the resolver rule stops it
// (browser.ts), and ensureMcpSignedIn proves it failed rather than trusting either.
async function blockClaude(page: PwPage): Promise<void> {
  await page.route(
    (u) => isClaudeHost(u.hostname),
    (route) => route.abort('blockedbyclient'),
  );
}

const urlOr = (s: string): URL | undefined => {
  try {
    return new URL(s);
  } catch {
    return undefined;
  }
};
const delay = <T>(ms: number, v: T) =>
  new Promise<T>((res) => setTimeout(() => res(v), ms).unref());

export async function ensureMcpSignedIn(
  context: PwContext,
  env: DevcheckEnv,
  deps: {
    fetch: FetchLike;
    shotOf: (page: PwPage) => (name: string) => Promise<void>; // screenshots of the sign-in page itself
    statePath: string;
    log: (msg: string) => void;
    now: () => number;
    callbackWaitMs?: number;
    settleMs?: number;
    responseWaitMs?: number;
  },
): Promise<McpSession> {
  const pkce = makePkce();
  const url = authorizeUrl(env, pkce);
  const page = await context.newPage();
  // Best effort: a shot that throws (a page mid-navigation) must never replace the MCP_AUTH_FAILED it explains.
  const shot = (name: string) =>
    deps
      .shotOf(page)(name)
      .catch(() => undefined);
  await blockClaude(page);
  // Every request the sign-in makes to a claude host — the callback, and nothing else, exactly once.
  const toClaude: PwRequest[] = [];
  let seen: (() => void) | undefined;
  const arrived = new Promise<void>((res) => (seen = res));
  page.on('request', (req) => {
    if (!isClaudeHost(urlOr(req.url())?.hostname ?? '')) return;
    toClaude.push(req);
    seen?.();
  });
  try {
    let form = false;
    // Reaching the callback fails the navigation (no claude host resolves) — expected; any other failure
    // before it is named (the net:: code only: the URL carries the state).
    const navError = await page.goto(url, { waitUntil: 'domcontentloaded' }).then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    if (!toClaude.length) {
      const at = urlOr(page.url());
      if (at?.hostname === env.DEVCHECK_COGNITO_HOST && at.pathname === '/error') {
        await shot('auth-rejected');
        throw fail(
          `Cognito refused the sign-in: ${at.searchParams.get('error') ?? 'an error page'}`,
        );
      }
      if (at?.hostname === env.DEVCHECK_COGNITO_HOST) {
        form = true; // no Hosted UI session cookie for this run: the classic form, as the app's sign-in
        await submitHostedUiForm(page, env, shot);
      } else if (navError)
        throw fail(
          `the authorize page didn't load (${/net::ERR_[A-Z_]+/.exec(navError)?.[0] ?? 'a navigation error'})`,
        );
    }
    if (
      (await Promise.race([
        arrived.then(() => 'ok'),
        delay(deps.callbackWaitMs ?? 20_000, 'timeout'),
      ])) === 'timeout'
    ) {
      await shot('no-callback');
      throw fail(`the sign-in never reached the callback (on ${urlOr(page.url())?.host ?? '?'})`);
    }
    // Proven, not assumed: the callback request failed in the browser — nothing came back from a claude host.
    const answered = await Promise.race([
      toClaude[0]!.response().catch(() => 'threw' as const), // a closed page proves nothing
      delay(deps.responseWaitMs ?? 5_000, 'pending' as const),
    ]);
    if (answered !== null)
      throw fail(
        answered === 'pending'
          ? 'the callback request never failed — a claude host may be reachable'
          : answered === 'threw'
            ? 'the sign-in page closed before the callback was shown to have failed'
            : 'a claude host answered the callback — the browser reached it',
      );
    await delay(deps.settleMs ?? 200, undefined); // a second request would land here
    if (toClaude.length !== 1)
      throw fail(
        `the sign-in sent ${toClaude.length} requests to a claude host, expected the one callback`,
      );
    const code = parseCallback(toClaude[0]!.url(), pkce.state);
    const session = await swapCode(deps.fetch, env, code, pkce.verifier, deps.now);
    assertMcpTestUser(session, env);
    await saveState(context, deps.statePath); // the Hosted UI cookie the sign-in may have refreshed
    deps.log(
      `mcp: signed in as the test user via the claude client (form ${form ? 'shown' : 'skipped'}), the callback failed in the browser ×1`,
    );
    return session;
  } finally {
    await page.close().catch(() => undefined);
  }
}
