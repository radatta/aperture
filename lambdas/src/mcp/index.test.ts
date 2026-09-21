import { afterEach, describe, expect, it } from 'vitest';
import { handler, runtime } from './index';

// Edge behavior that returns before any DynamoDB access (origin gate, method, auth) — plus `initialize`,
// which touches no table. Tool dispatch (which needs the live table) is covered in tools.test.ts.
const OK_ORIGIN = { 'x-aperture-origin-secret': 's3cr3t' };
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

function post(headers: Record<string, string | undefined>, body = init) {
  return handler({ requestContext: { http: { method: 'POST', path: '/mcp' } }, headers, body });
}

describe('mcp edge', () => {
  afterEach(() => {
    delete process.env.ORIGIN_SECRET;
    delete process.env.AGENT_TOKEN;
    delete process.env.DEVICE_USER_ID;
  });

  it('resolves the shared package', () => {
    expect(runtime).toBe('aperture-mcp');
  });

  it('answers a CORS preflight with 204', async () => {
    const res = await handler({ requestContext: { http: { method: 'OPTIONS', path: '/mcp' } } });
    expect(res.statusCode).toBe(204);
  });

  it('403s an HTTP request missing the origin secret', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    const res = await post({});
    expect(res.statusCode).toBe(403);
  });

  it('405s a non-POST method', async () => {
    const res = await handler({
      requestContext: { http: { method: 'GET', path: '/mcp' } },
      headers: OK_ORIGIN,
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('401s with no credential', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.AGENT_TOKEN = 'agent-secret';
    const res = await post({ ...OK_ORIGIN });
    expect(res.statusCode).toBe(401);
  });

  it('401s a wrong agent token', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.AGENT_TOKEN = 'agent-secret';
    const res = await post({ ...OK_ORIGIN, 'x-aperture-agent-token': 'wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('401s a bearer token (phase 1 accepts only the agent token)', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.AGENT_TOKEN = 'agent-secret';
    const res = await post({ ...OK_ORIGIN, authorization: 'Bearer whatever' });
    expect(res.statusCode).toBe(401);
  });

  it('200s initialize with the right agent token, and the agent header wins over a stray authorization', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.AGENT_TOKEN = 'agent-secret';
    process.env.DEVICE_USER_ID = 'cognito-sub-1';
    const res = await post({
      ...OK_ORIGIN,
      'x-aperture-agent-token': 'agent-secret',
      authorization: 'Bearer garbage',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.serverInfo.name).toBe('aperture');
  });

  it('a notification body returns 202 with no content', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.AGENT_TOKEN = 'agent-secret';
    const res = await post(
      { ...OK_ORIGIN, 'x-aperture-agent-token': 'agent-secret' },
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });
});
