import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './api';
import { CLAUDE_CALLBACK, TEST_USER_EMAIL, type DevcheckEnv } from './config';
import {
  assertMcpTestUser,
  authorizeUrl,
  ensureMcpSignedIn,
  makePkce,
  mcpToken,
  parseCallback,
  swapCode,
  type McpSession,
} from './mcp-login';
import type { PwContext, PwPage, PwRequest } from './pw-types';

const HOST = 'aperture-dev-618015769091.auth.us-west-1.amazoncognito.com';
const env: DevcheckEnv = {
  DEVCHECK_EMAIL: TEST_USER_EMAIL,
  DEVCHECK_PASSWORD: 'pw',
  DEVCHECK_SUB: 'sub-1',
  DEVCHECK_COGNITO_HOST: HOST,
  DEVCHECK_CLIENT_ID: 'app-client',
  DEVCHECK_POOL_ID: 'us-west-1_X',
  DEVCHECK_CLAUDE_CLIENT_ID: 'claude-client',
};
const NOW = 1_800_000_000_000;
const jwt = (p: Record<string, unknown>) =>
  ['h', Buffer.from(JSON.stringify(p)).toString('base64url'), 's'].join('.');
const tokens = (over: { sub?: string; email?: string; clientId?: string; use?: string } = {}) => ({
  access_token: jwt({
    sub: over.sub ?? 'sub-1',
    client_id: over.clientId ?? 'claude-client',
    token_use: over.use ?? 'access',
    exp: NOW / 1000 + 3600,
  }),
  id_token: jwt({ sub: over.sub ?? 'sub-1', email: over.email ?? TEST_USER_EMAIL }),
  expires_in: 3600,
});
const reply = (status: number, body: unknown) => ({
  status,
  text: async () => JSON.stringify(body),
});
const tokenFetch = (status = 200, body: unknown = tokens()) =>
  vi.fn<FetchLike>(async () => reply(status, body));
const callback = (q: Record<string, string>) => `${CLAUDE_CALLBACK}?${new URLSearchParams(q)}`;

describe('PKCE', () => {
  it('makes a base64url verifier, its S256 challenge (RFC 7636 vector) and a fresh state', () => {
    const octets = [
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
      105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
    ];
    const p = makePkce((n) => (n === 32 ? Buffer.from(octets) : Buffer.alloc(n, 7)));
    expect(p.verifier).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(p.challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(makePkce().state).not.toBe(makePkce().state);
  });

  it('builds the authorize URL on the env Hosted UI with the claude client, the registered callback, S256 and the three scopes', () => {
    const u = new URL(authorizeUrl(env, { verifier: 'v', challenge: 'c', state: 's' }));
    expect(u.origin + u.pathname).toBe(`https://${HOST}/oauth2/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'claude-client',
      redirect_uri: CLAUDE_CALLBACK,
      scope: 'openid email https://dev.aperture.rahuldatta.dev/mcp/access',
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    });
  });

  it('refuses an authorize URL for a host that is not the dev Hosted UI', () => {
    expect(() =>
      authorizeUrl(
        { ...env, DEVCHECK_COGNITO_HOST: 'aperture-prod-1.auth.us-west-1.amazoncognito.com' },
        makePkce(),
      ),
    ).toThrow(/refusing/);
  });
});

describe('parseCallback', () => {
  it('reads the code from the callback when the state matches', () => {
    expect(parseCallback(callback({ code: 'abc', state: 's1' }), 's1')).toBe('abc');
  });

  it('refuses another state, an error, a missing code or another path — naming neither code nor state', () => {
    const cases: [string, RegExp][] = [
      [callback({ code: 'SECRETCODE', state: 'other' }), /state does not match/],
      [callback({ error: 'access_denied', state: 's1' }), /refused the sign-in: access_denied/],
      [callback({ state: 's1' }), /no code/],
      ['https://claude.ai/elsewhere?code=SECRETCODE&state=s1', /not the registered callback/],
    ];
    for (const [url, msg] of cases) {
      let err: Error | undefined;
      try {
        parseCallback(url, 's1');
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(/^MCP_AUTH_FAILED/);
      expect(err?.message).toMatch(msg);
      expect(err?.message).not.toMatch(/SECRETCODE|s1\b/);
    }
  });
});

describe('swapCode', () => {
  it('swaps the code at the dev token endpoint with the verifier and no secret, never following a redirect', async () => {
    const fetch = tokenFetch();
    const s = await swapCode(fetch, env, 'abc', 'ver', () => NOW);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://${HOST}/oauth2/token`);
    expect(init.redirect).toBe('error');
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'claude-client',
      code: 'abc',
      redirect_uri: CLAUDE_CALLBACK,
      code_verifier: 'ver',
    });
    expect(init.headers).not.toHaveProperty('authorization');
    expect(s).toMatchObject({ email: TEST_USER_EMAIL, sub: 'sub-1', clientId: 'claude-client' });
    expect(s.expiresAt).toBe(NOW / 1000 + 3600);
  });

  it('a token request that throws (a refused redirect, the network) is MCP_AUTH_FAILED, not a crash', async () => {
    const fetch = vi.fn<FetchLike>(async () => {
      throw new TypeError('fetch failed: redirect mode is set to error');
    });
    await expect(swapCode(fetch, env, 'abc', 'v', () => NOW)).rejects.toThrow(
      /^MCP_AUTH_FAILED: the token endpoint request failed$/,
    );
  });

  it('a token endpoint error names Cognito’s error code, never the body', async () => {
    const fetch = tokenFetch(400, { error: 'invalid_client', detail: 'SECRETBODY' });
    await expect(swapCode(fetch, env, 'abc', 'v', () => NOW)).rejects.toThrow(
      /^MCP_AUTH_FAILED: the token endpoint answered HTTP 400 invalid_client$/,
    );
  });
});

describe('the MCP session', () => {
  const session = (over = {}): McpSession => {
    const t = tokens(over);
    return {
      accessToken: t.access_token,
      expiresAt: NOW / 1000 + 3600,
      email: TEST_USER_EMAIL,
      sub: 'sub-1',
      clientId: 'claude-client',
      ...over,
    };
  };

  it('is the test user in the id and access tokens, minted as the claude client’s access token', () => {
    expect(() => assertMcpTestUser(session(), env)).not.toThrow();
    expect(() => assertMcpTestUser(session({ email: 'me@example.com' }), env)).toThrow(
      /WRONG_USER/,
    );
    expect(() =>
      assertMcpTestUser(
        { ...session(), ...{ accessToken: tokens({ sub: 'x' }).access_token } },
        env,
      ),
    ).toThrow(/WRONG_USER/);
    expect(() => assertMcpTestUser(session({ clientId: 'app-client' }), env)).toThrow(
      /MCP_AUTH_FAILED/,
    );
    expect(() =>
      assertMcpTestUser({ ...session(), accessToken: tokens({ use: 'id' }).access_token }, env),
    ).toThrow(/MCP_AUTH_FAILED/);
  });

  it('the token getter refuses a token with under 30 s left', () => {
    const s = session();
    expect(mcpToken(s, () => NOW)).toBe(s.accessToken);
    expect(() => mcpToken(s, () => NOW + 3600_000 - 29_000)).toThrow(/MCP_AUTH_FAILED.*expired/);
  });
});

// A fake browser context: the authorize navigation either redirects straight to the callback (a live Hosted
// UI cookie), lands on the form (whose submit then redirects), or on Cognito's error page. The callback
// request fails (response → null), as the resolver rule makes it — unless the mode says a claude host answered.
type Mode =
  | 'cookie'
  | 'form'
  | 'error'
  | 'never'
  | 'twice'
  | 'late'
  | 'answered'
  | 'pending'
  | 'closed'
  | 'nav-error'
  | 'shot-throws';
function browser(mode: Mode) {
  const listeners: ((r: PwRequest) => void)[] = [];
  let state = '';
  let url = 'about:blank';
  const shots: string[] = [];
  const routes: ((u: URL) => boolean)[] = [];
  const request = (cb: string) =>
    ({
      url: () => cb,
      response: () =>
        mode === 'pending'
          ? new Promise(() => undefined)
          : mode === 'closed'
            ? Promise.reject(new Error('Target page, context or browser has been closed'))
            : Promise.resolve(mode === 'answered' ? { status: () => 200 } : null),
    }) as unknown as PwRequest;
  const toCallback = () => {
    const cb = callback({ code: 'abc', state });
    for (const l of listeners) l(request(cb));
    if (mode === 'twice') for (const l of listeners) l(request(cb));
    if (mode === 'late') setTimeout(() => listeners.forEach((l) => l(request(cb))), 5);
  };
  const locator = () => ({
    waitFor: async () => undefined,
    fill: async () => undefined,
    click: async () => toCallback(),
  });
  const page = {
    on: (ev: string, fn: (r: PwRequest) => void) => void (ev === 'request' && listeners.push(fn)),
    route: async (match: (u: URL) => boolean) => void routes.push(match),
    async goto(target: string) {
      state = new URL(target).searchParams.get('state')!;
      if (mode === 'form') url = target;
      else if (mode === 'error' || mode === 'shot-throws')
        url = `https://${HOST}/error?error=redirect_mismatch`;
      else if (mode === 'never') url = 'https://dev.aperture.rahuldatta.dev/';
      else if (mode === 'nav-error')
        throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${target}`);
      else {
        toCallback();
        throw new Error('net::ERR_NAME_NOT_RESOLVED');
      }
    },
    url: () => url,
    locator,
    close: async () => undefined,
  } as unknown as PwPage;
  const context = {
    newPage: async () => page,
    storageState: async () => ({ cookies: [] }),
  } as unknown as PwContext;
  const shotOf = () => async (n: string) => {
    if (mode === 'shot-throws') throw new Error('Execution context was destroyed');
    shots.push(n);
  };
  return { context, shots, routes, shotOf };
}

describe('ensureMcpSignedIn', () => {
  const run = (mode: Mode, fetch = tokenFetch(), statePath?: string) => {
    const b = browser(mode);
    const path = statePath ?? join(mkdtempSync(join(tmpdir(), 'mcp-')), 'state.json');
    const log = vi.fn();
    const p = ensureMcpSignedIn(b.context, env, {
      fetch,
      shotOf: b.shotOf,
      statePath: path,
      log,
      now: () => NOW,
      callbackWaitMs: 20,
      settleMs: 20,
      responseWaitMs: 20,
    });
    return { p, b, statePath: path, log, fetch };
  };

  it('with a live Hosted UI cookie: proves the callback failed, swaps its code, saves the state 600', async () => {
    const { p, b, statePath, log, fetch } = run('cookie');
    const s = await p;
    expect(s.clientId).toBe('claude-client');
    expect(new URLSearchParams(fetch.mock.calls[0]![1].body as string).get('code')).toBe('abc');
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ cookies: [] });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/form skipped\), the callback failed in the browser ×1/),
    );
    expect(b.routes[0]!(new URL('https://claude.ai/x'))).toBe(true); // the page's own guard
    expect(b.routes[0]!(new URL(`https://${HOST}/x`))).toBe(false);
  });

  it('tightens an existing state file to 600', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'state.json');
    writeFileSync(path, '{}', { mode: 0o644 });
    await run('cookie', tokenFetch(), path).p;
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('fills the Hosted UI form through the shared helper when the authorize lands on it', async () => {
    const { p, log } = run('form');
    await p;
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/form shown/));
  });

  it('Cognito’s error page fails with its error code and a shot of that page, before any swap', async () => {
    const { p, b, fetch } = run('error');
    await expect(p).rejects.toThrow(
      /MCP_AUTH_FAILED: Cognito refused the sign-in: redirect_mismatch/,
    );
    expect(b.shots).toEqual(['auth-rejected']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a callback a claude host answered is refused — the browser reached it', async () => {
    const { p, fetch } = run('answered');
    await expect(p).rejects.toThrow(/a claude host answered the callback/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a callback that never fails, or whose page closed first, proves nothing — no swap', async () => {
    const pending = run('pending');
    await expect(pending.p).rejects.toThrow(/the callback request never failed/);
    expect(pending.fetch).not.toHaveBeenCalled();
    const closed = run('closed');
    await expect(closed.p).rejects.toThrow(/closed before the callback was shown to have failed/);
    expect(closed.fetch).not.toHaveBeenCalled();
  });

  it('a screenshot that throws never replaces the MCP_AUTH_FAILED it explains', async () => {
    await expect(run('shot-throws').p).rejects.toThrow(
      /MCP_AUTH_FAILED: Cognito refused the sign-in: redirect_mismatch/,
    );
  });

  it('fails when the callback never comes, comes twice, or a second request lands after it', async () => {
    await expect(run('never').p).rejects.toThrow(/never reached the callback/);
    await expect(run('twice').p).rejects.toThrow(/sent 2 requests to a claude host/);
    const late = run('late');
    await expect(late.p).rejects.toThrow(/sent 2 requests to a claude host/);
    expect(late.fetch).not.toHaveBeenCalled();
  });

  it('a navigation that fails before the callback names its net:: code, not the URL', async () => {
    const err = await run('nav-error').p.catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "MCP_AUTH_FAILED: the authorize page didn't load (net::ERR_CONNECTION_REFUSED)",
    );
  });

  it('a session that is not the test user is WRONG_USER, and nothing is saved', async () => {
    const { p, statePath } = run('cookie', tokenFetch(200, tokens({ email: 'me@example.com' })));
    await expect(p).rejects.toThrow(/WRONG_USER/);
    expect(() => statSync(statePath)).toThrow();
  });
});
