import { describe, expect, it } from 'vitest';
import { resolveAgentUserId, resolveDeviceUserId, resolveUserId } from './verify';
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
    await expect(resolveUserId('Bearer forged', okVerifier)).rejects.toThrow(
      /Unauthorized: invalid token/,
    );
  });
});

describe('resolveDeviceUserId', () => {
  it('falls back to local when no device token is configured (dev)', () => {
    expect(resolveDeviceUserId(undefined, undefined, undefined)).toBe('local');
    expect(resolveDeviceUserId('Bearer whatever', undefined, 'sub-1')).toBe('local');
  });

  it('returns the configured device user when the token matches', () => {
    expect(resolveDeviceUserId('Bearer tok', 'tok', 'sub-1')).toBe('sub-1');
    expect(resolveDeviceUserId('Bearer tok', 'tok', undefined)).toBe('local'); // no owner → local
  });

  it('rejects a missing or wrong device token as Unauthorized', () => {
    expect(() => resolveDeviceUserId(undefined, 'tok', 'sub-1')).toThrow(/Unauthorized/);
    expect(() => resolveDeviceUserId('Bearer nope', 'tok', 'sub-1')).toThrow(/Unauthorized/);
    expect(() => resolveDeviceUserId('Bearer toke', 'tok', 'sub-1')).toThrow(/Unauthorized/); // length differs
  });
});

describe('resolveAgentUserId', () => {
  it('falls back to local when no agent token is configured (dev)', () => {
    expect(resolveAgentUserId(undefined, undefined, undefined)).toBe('local');
    expect(resolveAgentUserId('whatever', undefined, 'sub-1')).toBe('local');
  });

  it('returns the configured agent user when the RAW header token matches (no Bearer prefix)', () => {
    expect(resolveAgentUserId('tok', 'tok', 'sub-1')).toBe('sub-1');
    expect(resolveAgentUserId('  tok  ', 'tok', 'sub-1')).toBe('sub-1'); // trims surrounding whitespace
    expect(resolveAgentUserId('tok', 'tok', undefined)).toBe('local'); // no owner → local
  });

  it('rejects a missing or wrong agent token as Unauthorized', () => {
    expect(() => resolveAgentUserId(undefined, 'tok', 'sub-1')).toThrow(/Unauthorized/);
    expect(() => resolveAgentUserId('nope', 'tok', 'sub-1')).toThrow(/Unauthorized/);
    expect(() => resolveAgentUserId('toke', 'tok', 'sub-1')).toThrow(/Unauthorized/); // length differs
    expect(() => resolveAgentUserId('Bearer tok', 'tok', 'sub-1')).toThrow(/Unauthorized/); // raw token, not Bearer-wrapped
  });
});
