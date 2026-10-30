import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appJwt } from './jwt.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(); // GitHub's key format
const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;

describe('appJwt', () => {
  const now = Date.parse('2026-10-13T20:00:00Z');
  const jwt = appJwt('Iv23test', pem, now);
  const [header = '', claims = '', sig = ''] = jwt.split('.');

  it('is an RS256 JWT that verifies against the key', () => {
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(sig, 'base64url'),
      ),
    ).toBe(true);
  });

  it('issues as the Client ID, backdated a minute, inside GitHub’s 10-minute ceiling', () => {
    const c = decode(claims) as { iss: string; iat: number; exp: number };
    expect(c.iss).toBe('Iv23test');
    expect(c.iat).toBe(now / 1000 - 60);
    expect(c.exp - c.iat).toBeLessThanOrEqual(600);
    expect(c.exp).toBe(now / 1000 + 540);
  });
});
