import { describe, expect, it } from 'vitest';
import { resolveUserId } from './verify';
import type { Verifier } from './verify';

const okVerifier: Verifier = {
  verify: async (token) => {
    if (token === 'good') return { sub: 'cognito-sub-123' };
    throw new Error('bad signature');
  },
};

describe('resolveUserId', () => {
  it('falls back to the dev user when no verifier is wired (local)', async () => {
    expect(await resolveUserId(undefined, null)).toBe('local');
    expect(await resolveUserId('Bearer anything', null)).toBe('local');
  });

  it('returns the token sub when a valid bearer token is presented', async () => {
    expect(await resolveUserId('Bearer good', okVerifier)).toBe('cognito-sub-123');
    expect(await resolveUserId('bearer good', okVerifier)).toBe('cognito-sub-123'); // case-insensitive
  });

  it('rejects a missing token when auth is enforced', async () => {
    await expect(resolveUserId(undefined, okVerifier)).rejects.toThrow(/Unauthorized/);
    await expect(resolveUserId('Basic abc', okVerifier)).rejects.toThrow(/Unauthorized/);
  });

  it('rejects an invalid token as Unauthorized (never leaks the underlying error)', async () => {
    await expect(resolveUserId('Bearer forged', okVerifier)).rejects.toThrow(/Unauthorized: invalid token/);
  });
});
