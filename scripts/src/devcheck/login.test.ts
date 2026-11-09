import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEV_ORIGIN, TEST_USER_EMAIL, type DevcheckEnv } from './config';
import type { FetchLike } from './api';
import { readCheckedSession, refreshSession, validateCachedState } from './login';
import type { PwPage } from './pw-types';
import { cognitoAuthority, userStoreKey } from './token';

const env = {
  DEVCHECK_POOL_ID: 'us-west-1_ABC',
  DEVCHECK_CLIENT_ID: 'c1',
  DEVCHECK_SUB: 's1',
} as DevcheckEnv;
const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.sig`;
const state = (sub: string, email: string) =>
  JSON.stringify({
    cookies: [],
    origins: [
      {
        origin: DEV_ORIGIN,
        localStorage: [
          {
            name: userStoreKey(cognitoAuthority(env.DEVCHECK_POOL_ID), env.DEVCHECK_CLIENT_ID),
            value: JSON.stringify({ access_token: jwt(sub), profile: { sub, email } }),
          },
        ],
      },
    ],
  });

describe('validateCachedState', () => {
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'state-')), 'state.json');
    writeFileSync(path, text);
    return path;
  };
  it("keeps the test user's cached session", () => {
    const path = file(state('s1', TEST_USER_EMAIL));
    validateCachedState(path, env, vi.fn());
    expect(existsSync(path)).toBe(true);
  });
  it('discards a cached session for anyone else, before any page loads', () => {
    const path = file(state('s9', 'someone@example.com'));
    const log = vi.fn();
    validateCachedState(path, env, log);
    expect(existsSync(path)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/WRONG_USER/));
  });
  it('checks every oidc user entry, not only the env client id', () => {
    const other = JSON.parse(state('s1', TEST_USER_EMAIL));
    other.origins[0].localStorage.push({
      name: 'oidc.user:https://elsewhere:old-client',
      value: JSON.stringify({
        access_token: jwt('s9'),
        profile: { sub: 's9', email: 'x@example.com' },
      }),
    });
    const path = file(JSON.stringify(other));
    validateCachedState(path, env, vi.fn());
    expect(existsSync(path)).toBe(false);
  });
  it('discards an unreadable cache, and ignores a missing one', () => {
    const path = file('{not json');
    validateCachedState(path, env, vi.fn());
    expect(existsSync(path)).toBe(false);
    validateCachedState(path, env, vi.fn());
  });
});

describe('readCheckedSession', () => {
  const page = (sub: string, email: string) =>
    ({
      evaluate: async () =>
        Object.fromEntries(
          JSON.parse(state(sub, email)).origins[0].localStorage.map(
            (x: { name: string; value: string }) => [x.name, x.value],
          ),
        ),
    }) as unknown as PwPage;
  it("returns the test user's session", async () => {
    expect((await readCheckedSession(page('s1', TEST_USER_EMAIL), env))?.sub).toBe('s1');
  });
  it('throws WRONG_USER for anyone else', async () => {
    await expect(readCheckedSession(page('s9', 'x@example.com'), env)).rejects.toThrow(
      /WRONG_USER/,
    );
  });
});

describe('refreshSession', () => {
  const HOST = 'aperture-dev-618015769091.auth.us-west-1.amazoncognito.com';
  const renv = {
    ...env,
    DEVCHECK_COGNITO_HOST: HOST,
    DEVCHECK_CLIENT_ID: 'app-client',
  } as DevcheckEnv;
  const key = userStoreKey(cognitoAuthority(renv.DEVCHECK_POOL_ID), renv.DEVCHECK_CLIENT_ID);
  const claims = (p: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify(p)).toString('base64url')}.sig`;
  const page = (user: Record<string, unknown>) =>
    ({ evaluate: async () => ({ [key]: JSON.stringify(user) }) }) as unknown as PwPage;
  const stored = { access_token: jwt('s1'), refresh_token: 'RT-1', profile: { sub: 's1' } };
  const grant = (status: number, sub = 's1', email = TEST_USER_EMAIL, extra = {}) =>
    vi.fn<FetchLike>(async () => ({
      status,
      text: async () =>
        JSON.stringify(
          status === 200
            ? {
                access_token: claims({ sub, exp: 5000 }),
                id_token: claims({ sub, email }),
                expires_in: 3600,
              }
            : { error: 'invalid_grant', ...extra },
        ),
    }));

  it("renews with the page's refresh token at the dev pool's token endpoint", async () => {
    const fetch = grant(200);
    const s = await refreshSession(page(stored), renv, fetch, () => 0);
    expect(s).toMatchObject({ sub: 's1', email: TEST_USER_EMAIL, expiresAt: 5000 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://${HOST}/oauth2/token`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'refresh_token',
      client_id: 'app-client',
      refresh_token: 'RT-1',
    });
  });
  it('is null, with no request, when the page keeps no refresh token', async () => {
    const fetch = grant(200);
    expect(
      await refreshSession(page({ access_token: jwt('s1') }), renv, fetch, () => 0),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('throws WRONG_USER when the renewed identity is not the test user', async () => {
    await expect(
      refreshSession(page(stored), renv, grant(200, 's9', 'x@example.com'), () => 0),
    ).rejects.toThrow(/WRONG_USER/);
  });
  it('an unreadable stored session is AUTH_REJECTED, never quoting the record', async () => {
    const torn = {
      evaluate: async () => ({ [key]: '{"refresh_token":"RT-SECRET"' }),
    } as unknown as PwPage;
    const fetch = grant(200);
    const err = await refreshSession(torn, renv, fetch, () => 0).catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/AUTH_REJECTED.*unreadable/);
    expect(String(err)).not.toMatch(/RT-SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("throws AUTH_REJECTED naming Cognito's error, never the body or the token", async () => {
    const err = await refreshSession(
      page(stored),
      renv,
      grant(400, 's1', TEST_USER_EMAIL, { detail: 'SECRETBODY' }),
      () => 0,
    ).catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/AUTH_REJECTED.*session refresh.*HTTP 400 invalid_grant/);
    expect(String(err)).not.toMatch(/SECRETBODY|RT-1/);
  });
});
