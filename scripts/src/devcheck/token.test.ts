import { describe, expect, it } from 'vitest';
import { TEST_USER_EMAIL } from './config';
import {
  assertTestUser,
  cognitoAuthority,
  decodeJwtPayload,
  nearExpiry,
  sessionFromStorage,
  TOKEN_MARGIN_MS,
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
