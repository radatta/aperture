import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEV_ORIGIN, TEST_USER_EMAIL, type DevcheckEnv } from './config';
import { readCheckedSession, validateCachedState } from './login';
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
