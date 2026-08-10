import { describe, it, expect, afterEach } from 'vitest';
import { handler, runtime } from './index';

describe('lambdas', () => {
  it('resolves the shared package', () => {
    expect(runtime).toBe('aperture-lambda');
  });
});

// Edge behavior that returns before any DynamoDB access (auth/origin gating).
describe('handler edge', () => {
  afterEach(() => {
    delete process.env.ORIGIN_SECRET;
  });

  it('answers a CORS preflight with 204', async () => {
    const res = await handler({ requestContext: { http: { method: 'OPTIONS', path: '/api/getSettings' } } });
    expect(res.statusCode).toBe(204);
  });

  it('403s an HTTP request missing the origin secret', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    const res = await handler({
      rawPath: '/api/getSettings',
      requestContext: { http: { method: 'POST', path: '/api/getSettings' } },
      headers: {}, // no x-aperture-origin-secret
      body: JSON.stringify({ args: [] }),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
  });

  // /api/health backs the post-deploy synthetic check: no auth, no DynamoDB, but still behind the gate.
  it('serves /api/health with 200 when the origin secret header matches', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    const res = await handler({
      rawPath: '/api/health',
      requestContext: { http: { method: 'GET', path: '/api/health' } },
      headers: { 'x-aperture-origin-secret': 's3cr3t' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });

  it('gates /api/health behind the origin secret too (no header → 403)', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    const res = await handler({
      rawPath: '/api/health',
      requestContext: { http: { method: 'GET', path: '/api/health' } },
      headers: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
