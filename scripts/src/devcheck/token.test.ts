import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './api';
import { TEST_USER_EMAIL, TEST_USERS } from './config';
import {
  assertTestUser,
  cognitoAuthority,
  decodeJwtPayload,
  grantTokens,
  nearExpiry,
  sessionFromStorage,
  TOKEN_MARGIN_MS,
  tokenGrant,
  userStoreKey,
} from './token';

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

const KEY = userStoreKey(cognitoAuthority('us-west-1_ABC'), 'client1');
const stored = (sub: string, email: string, accessSub = sub) => ({
  [KEY]: JSON.stringify({
    access_token: jwt({ sub: accessSub }),
    expires_at: 123,
    profile: { sub, email },
  }),
});

describe('token', () => {
  it('builds the oidc-client-ts key from the pool', () => {
    expect(KEY).toBe('oidc.user:https://cognito-idp.us-west-1.amazonaws.com/us-west-1_ABC:client1');
  });

  it('decodes a base64url JWT payload', () => {
    expect(decodeJwtPayload(jwt({ sub: 's', n: 'ü' }))).toEqual({ sub: 's', n: 'ü' });
    expect(() => decodeJwtPayload('nope')).toThrow(/not a JWT/);
  });

  it('reads the session, or null when absent', () => {
    expect(sessionFromStorage({}, KEY)).toBeNull();
    expect(sessionFromStorage(stored('s1', TEST_USER_EMAIL), KEY)).toMatchObject({
      sub: 's1',
      email: TEST_USER_EMAIL,
      expiresAt: 123,
    });
  });

  it('passes only the test user, matching sub in both tokens', () => {
    expect(() =>
      assertTestUser(sessionFromStorage(stored('s1', TEST_USER_EMAIL), KEY)!, 's1'),
    ).not.toThrow();
    expect(() =>
      assertTestUser(sessionFromStorage(stored('s1', 'me@example.com'), KEY)!, 's1'),
    ).toThrow(/WRONG_USER/);
    expect(() =>
      assertTestUser(sessionFromStorage(stored('s2', TEST_USER_EMAIL), KEY)!, 's1'),
    ).toThrow(/WRONG_USER/);
    expect(() =>
      assertTestUser(sessionFromStorage(stored('s1', TEST_USER_EMAIL, 'other'), KEY)!, 's1'),
    ).toThrow(/WRONG_USER/);
  });

  it('a lane’s user is the one it expects: the browser user passes as itself, never as the original', () => {
    const web = sessionFromStorage(stored('s1', TEST_USERS.web), KEY)!;
    expect(() => assertTestUser(web, 's1', TEST_USERS.web)).not.toThrow();
    expect(() => assertTestUser(web, 's1')).toThrow(/WRONG_USER/);
    expect(() =>
      assertTestUser(sessionFromStorage(stored('s1', TEST_USER_EMAIL), KEY)!, 's1', TEST_USERS.web),
    ).toThrow(/WRONG_USER/);
  });

  it('an expected email that is no test user is refused before the session is read', () => {
    const me = sessionFromStorage(stored('s1', 'me@example.com'), KEY)!;
    expect(() => assertTestUser(me, 's1', 'me@example.com')).toThrow(/WRONG_USER.*not a test user/);
  });
});

describe('nearExpiry', () => {
  it('is true from the shared margin before expiry on', () => {
    const s = { accessToken: 'a', expiresAt: 1000, email: '', sub: '' };
    expect(TOKEN_MARGIN_MS).toBe(60_000);
    expect(nearExpiry(s, 1000_000 - 60_001)).toBe(false);
    expect(nearExpiry(s, 1000_000 - 59_999)).toBe(true);
    expect(nearExpiry(s, 1000_000 + 1)).toBe(true);
  });
});

describe('grantTokens', () => {
  const HOST = 'aperture-dev-123456789012.auth.us-west-1.amazoncognito.com';
  const reply = (status: number, body: Record<string, unknown>) =>
    vi.fn<FetchLike>(async () => ({ status, text: async () => JSON.stringify(body) }));
  const ok = (extra = {}) =>
    reply(200, {
      access_token: jwt({ sub: 's1', exp: 5000, client_id: 'c1' }),
      id_token: jwt({ sub: 's1', email: 'e@x' }),
      expires_in: 3600,
      ...extra,
    });
  const fail = (m: string, error?: string) => Object.assign(new Error(m), { error });
  const params = { grant_type: 'refresh_token' };

  it('returns the id token, and a rotated refresh token only when one came back', async () => {
    const g = await grantTokens(ok(), HOST, params, () => 0, fail);
    expect(g.session).toMatchObject({ sub: 's1', email: 'e@x', expiresAt: 5000, clientId: 'c1' });
    expect(g.idToken).toBe(jwt({ sub: 's1', email: 'e@x' }));
    expect(g).not.toHaveProperty('refreshToken');
    const r = await grantTokens(ok({ refresh_token: 'RT-2' }), HOST, params, () => 0, fail);
    expect(r.refreshToken).toBe('RT-2');
  });
  it("tokenGrant's session carries neither the id token nor a refresh token", async () => {
    const s = await tokenGrant(ok({ refresh_token: 'RT-2' }), HOST, params, () => 0, fail);
    expect(Object.keys(s).sort()).toEqual(['accessToken', 'clientId', 'email', 'expiresAt', 'sub']);
  });
  it("hands fail Cognito's error field alone", async () => {
    const err = (await grantTokens(
      reply(400, { error: 'invalid_grant', detail: 'SECRETBODY' }),
      HOST,
      params,
      () => 0,
      fail,
    ).catch((e: unknown) => e)) as Error & { error?: string };
    expect(err.error).toBe('invalid_grant');
    expect(err.message).toBe('the token endpoint answered HTTP 400 invalid_grant');
  });
  it('an unreadable token is a fail of its own, never the parser quoting it', async () => {
    const torn = reply(200, { access_token: 'h.e30.sig', id_token: 'h.eyJzdWIiOiJTRUNSRVQ.sig' });
    const err = (await grantTokens(torn, HOST, params, () => 0, fail).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toBe('the token endpoint returned an unreadable token');
  });
  it('passes the abort signal to the request', async () => {
    const fetch = ok();
    const signal = new AbortController().signal;
    await grantTokens(fetch, HOST, params, () => 0, fail, signal);
    expect(fetch.mock.calls[0]![1].signal).toBe(signal);
  });
});

describe('assertTestUser on a torn access token', () => {
  it('is WRONG_USER without quoting the claims', () => {
    const torn = { accessToken: 'h.eyJzdWIiOiJTRUNSRVQ.sig', expiresAt: 0, email: '', sub: 's1' };
    expect(() => assertTestUser(torn, 's1')).toThrow(/WRONG_USER.*unreadable access token/);
    expect(() => assertTestUser(torn, 's1')).not.toThrow(/SECRET/);
  });
});

describe('sessionFromStorage on a torn record', () => {
  it('throws without quoting it', () => {
    expect(() => sessionFromStorage({ [KEY]: '{"access_token":"AT-SECRET"' }, KEY)).toThrow(
      /^unreadable oidc session in storage$/,
    );
  });
});
