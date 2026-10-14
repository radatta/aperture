import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEV_ORIGIN, TEST_USER_EMAIL, type DevcheckEnv } from './config';
import { validateCachedState } from './login';
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
  it('discards an unreadable cache, and ignores a missing one', () => {
    const path = file('{not json');
    validateCachedState(path, env, vi.fn());
    expect(existsSync(path)).toBe(false);
    validateCachedState(path, env, vi.fn());
  });
});
