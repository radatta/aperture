import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertClientAllowed,
  createCognitoVerifier,
  resolveAgentUserId,
  resolveDeviceUserId,
  resolveUserId,
} from './verify';
import type { Jwks, Verifier } from './verify';

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

describe('assertClientAllowed (D14 — deny a claude.ai token on the BFF)', () => {
  it('no-ops when no reject list is configured', () => {
    expect(() => assertClientAllowed('any-client', undefined)).not.toThrow();
    expect(() => assertClientAllowed('any-client', [])).not.toThrow();
  });

  it('allows a client that is not on the reject list', () => {
    expect(() => assertClientAllowed('spa-client', ['mcp-client'])).not.toThrow();
  });

  it('denies a client on the reject list as Unauthorized', () => {
    expect(() => assertClientAllowed('mcp-client', ['mcp-client'])).toThrow(/Unauthorized/);
  });

  it('ignores a non-string / absent client_id claim', () => {
    expect(() => assertClientAllowed(undefined, ['mcp-client'])).not.toThrow();
    expect(() => assertClientAllowed(123, ['mcp-client'])).not.toThrow();
  });
});

// The local devcheck server's path (docs/ops/LOCAL-CHECK.md): the real aws-jwt-verify, fed a JWKS up front
// instead of fetching the pool's — so a token signed with that key verifies with no network call at all.
describe('createCognitoVerifier with a jwks option', () => {
  const POOL = 'us-west-1_LocalTest';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = {
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }],
  };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (claims: Record<string, unknown>, key = privateKey) => {
    const data = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
    return `${data}.${cryptoSign('sha256', Buffer.from(data), key).toString('base64url')}`;
  };
  const claims = (over: Record<string, unknown> = {}) => ({
    sub: 'u-1',
    iss: `https://cognito-idp.us-west-1.amazonaws.com/${POOL}`,
    token_use: 'access',
    client_id: 'app',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    ...over,
  });

  it('verifies a token signed with the given key', async () => {
    const v = createCognitoVerifier(POOL, null, { jwks: jwks as Jwks });
    await expect(v.verify(sign(claims()))).resolves.toEqual({ sub: 'u-1' });
  });
  it('rejects a token signed with another key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const v = createCognitoVerifier(POOL, null, { jwks: jwks as Jwks });
    await expect(v.verify(sign(claims(), other))).rejects.toThrow();
  });
  it('keeps D14: a denied client is rejected', async () => {
    const v = createCognitoVerifier(POOL, null, {
      jwks: jwks as Jwks,
      rejectClientIds: ['claude'],
    });
    await expect(v.verify(sign(claims({ client_id: 'claude' })))).rejects.toThrow();
  });
  it('keeps the client binding and token_use', async () => {
    const v = createCognitoVerifier(POOL, 'claude', { jwks: jwks as Jwks });
    await expect(v.verify(sign(claims()))).rejects.toThrow(); // client_id app ≠ claude
    await expect(
      v.verify(sign(claims({ client_id: 'claude', token_use: 'id' }))),
    ).rejects.toThrow();
    await expect(v.verify(sign(claims({ client_id: 'claude' })))).resolves.toEqual({ sub: 'u-1' });
  });
});
