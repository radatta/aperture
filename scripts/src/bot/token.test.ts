import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PERMS, mintToken } from './token.ts';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();

// A fetch double recording each request; answers by path.
function fakeFetch(answers: Record<string, { status: number; body: unknown }>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const path = url.replace('https://api.github.com', '');
    const a = answers[path] ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe('mintToken', () => {
  const config = { appId: '1', clientId: 'Iv23x', privateKey: pem };

  it('finds the installation, then mints a one-repo token with exactly the asked permissions', async () => {
    const { f, seen } = fakeFetch({
      '/app/installations': {
        status: 200,
        body: [
          { id: 7, account: { login: 'someone' } },
          { id: 9, account: { login: 'radatta' } },
        ],
      },
      '/app/installations/9/access_tokens': { status: 201, body: { token: 'ghs_test' } },
    });
    expect(await mintToken(config, PERMS.push, f)).toBe('ghs_test');
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.github.com/app/installations',
      'https://api.github.com/app/installations/9/access_tokens',
    ]);
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({
      repositories: ['aperture'],
      permissions: { contents: 'write' },
    });
  });

  it('sends the JWT as Bearer — gh’s `token` prefix is a 401 for a JWT', async () => {
    const { f, seen } = fakeFetch({
      '/app/installations/5/access_tokens': { status: 201, body: { token: 't' } },
    });
    await mintToken({ ...config, installationId: '5' }, PERMS.logs, f);
    expect((seen[0]?.init.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
    expect(seen).toHaveLength(1); // cached installation id → no lookup
  });

  it('refuses when the App is not installed on the account', async () => {
    const { f } = fakeFetch({ '/app/installations': { status: 200, body: [] } });
    await expect(mintToken(config, PERMS.push, f)).rejects.toThrow(/not installed/);
  });

  it('never asks for workflows or administration', () => {
    for (const perms of Object.values(PERMS))
      expect(Object.keys(perms).sort()).not.toContain('workflows');
    for (const perms of Object.values(PERMS))
      expect(Object.keys(perms)).not.toContain('administration');
  });

  it('surfaces GitHub’s error without the token', async () => {
    const { f } = fakeFetch({
      '/app/installations': {
        status: 401,
        body: { message: 'A JSON web token could not be decoded' },
      },
    });
    const err = await mintToken(config, PERMS.push, f).catch((e: Error) => e);
    expect(String(err)).toMatch(/401 A JSON web token could not be decoded/);
    expect(String(err)).not.toMatch(/ey[A-Za-z0-9_-]{10,}/);
  });
});
