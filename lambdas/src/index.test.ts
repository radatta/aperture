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
    const res = await handler({
      requestContext: { http: { method: 'OPTIONS', path: '/api/getSettings' } },
    });
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
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, service: 'bff' });
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

// Device-token ingest branch — only the auth-FAILURE paths, which return before any DynamoDB access
// (the write path itself is proven by the shared contract suite via handleRpc). No external calls.
describe('handler device-token ingest branch', () => {
  afterEach(() => {
    delete process.env.DEVICE_TOKEN;
    delete process.env.DEVICE_USER_ID;
  });

  const ingest = (headers: Record<string, string | undefined>) =>
    handler({
      rawPath: '/api/recordLeetcodeAttempt',
      requestContext: { http: { method: 'POST', path: '/api/recordLeetcodeAttempt' } },
      headers,
      body: JSON.stringify({ args: [{}] }),
    });

  it('401s the ingest method when the device token is wrong', async () => {
    process.env.DEVICE_TOKEN = 'right-token';
    const res = await ingest({ 'x-aperture-authorization': 'Bearer wrong-token' });
    expect(res.statusCode).toBe(401);
  });

  it('401s the ingest method when the device token is missing', async () => {
    process.env.DEVICE_TOKEN = 'right-token';
    const res = await ingest({});
    expect(res.statusCode).toBe(401);
  });
});
