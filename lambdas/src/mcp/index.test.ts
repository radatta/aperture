import { afterEach, describe, expect, it, vi } from 'vitest';

// The bearer (claude.ai) path builds a Cognito verifier via createCognitoVerifier — mock it to a fake so
// the edge is testable offline (env-then-call ordering works because the edge builds it lazily). Only
// createCognitoVerifier is replaced; resolveAgentUserId + resolveUserId stay real.
vi.mock('../auth/verify', async (importActual) => {
  const actual = await importActual<typeof import('../auth/verify')>();
  const okVerifier = {
    verify: async (t: string) => {
      if (t === 'good') return { sub: 'cognito-sub-1' };
      throw new Error('bad signature');
    },
  };
  return { ...actual, createCognitoVerifier: () => okVerifier };
});

// The live table is an in-memory one, and the live Plaid gateway + sync invoker are spies: the finance
// tripwire below drives a real tool call through the edge and asserts neither is ever built or used.
const live = vi.hoisted(() => ({ plaid: vi.fn(), invoker: vi.fn() }));
vi.mock('../ddb/LiveDoc', async () => {
  const { InMemoryDoc } = await import('../ddb/DocClient');
  return { createLiveDoc: () => new InMemoryDoc() };
});
vi.mock('../plaid/livePlaid', () => ({ createLivePlaid: live.plaid }));
vi.mock('../finance/liveInvoker', () => ({ liveInvoker: live.invoker }));

import { handler, runtime } from './index';

// Edge behavior that returns before any DynamoDB access (origin gate, method, auth, well-known) — plus
// `initialize`, which touches no table. Tool behavior is in tools.test.ts / financeTools.test.ts; the one
// tool call here (over the mocked in-memory table) is the finance Plaid tripwire at the end.
const OK_ORIGIN = { 'x-aperture-origin-secret': 's3cr3t' };
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

function post(headers: Record<string, string | undefined>, body = init) {
  return handler({ requestContext: { http: { method: 'POST', path: '/mcp' } }, headers, body });
}
function get(path: string, headers: Record<string, string | undefined> = OK_ORIGIN) {
  return handler({ requestContext: { http: { method: 'GET', path } }, headers });
}

describe('mcp edge', () => {
  afterEach(() => {
    for (const k of [
      'ORIGIN_SECRET',
      'AGENT_TOKEN',
      'DEVICE_USER_ID',
      'USER_POOL_ID',
      'MCP_CLIENT_ID',
      'COGNITO_DOMAIN',
      'APP_URL',
    ]) {
      delete process.env[k];
    }
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

  it('405s a non-POST method on /mcp', async () => {
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

  it('401s a bearer token when no claude.ai client is configured on the stage', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.AGENT_TOKEN = 'agent-secret';
    const res = await post({ ...OK_ORIGIN, authorization: 'Bearer good' });
    expect(res.statusCode).toBe(401); // no USER_POOL_ID/MCP_CLIENT_ID → bearer auth not configured
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

  // Phase 2 — the OAuth bearer path + the metadata façade.
  it('200s a valid Cognito bearer token when the claude.ai client is configured', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.USER_POOL_ID = 'us-west-1_ABC';
    process.env.MCP_CLIENT_ID = 'claude-client-id';
    const res = await post({ ...OK_ORIGIN, authorization: 'Bearer good' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.serverInfo.name).toBe('aperture');
  });

  it('401s an invalid bearer token and carries the RFC 9728 discovery pointer', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.USER_POOL_ID = 'us-west-1_ABC';
    process.env.MCP_CLIENT_ID = 'claude-client-id';
    process.env.APP_URL = 'https://dev.aperture.rahuldatta.dev';
    const res = await post({ ...OK_ORIGIN, authorization: 'Bearer forged' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp');
  });

  it('a no-credential 401 carries www-authenticate when the façade is configured', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.AGENT_TOKEN = 'agent-secret';
    process.env.APP_URL = 'https://dev.aperture.rahuldatta.dev';
    const res = await post({ ...OK_ORIGIN });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('serves authorization-server metadata (GET) with the injected PKCE field', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.APP_URL = 'https://dev.aperture.rahuldatta.dev';
    process.env.COGNITO_DOMAIN = 'aperture-dev-1.auth.us-west-1.amazoncognito.com';
    process.env.USER_POOL_ID = 'us-west-1_ABC';
    const res = await get('/.well-known/oauth-authorization-server');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.issuer).toBe('https://dev.aperture.rahuldatta.dev');
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('serves protected-resource metadata (GET), including the path-suffixed RFC 9728 form', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.APP_URL = 'https://dev.aperture.rahuldatta.dev';
    process.env.COGNITO_DOMAIN = 'aperture-dev-1.auth.us-west-1.amazoncognito.com';
    process.env.USER_POOL_ID = 'us-west-1_ABC';
    const res = await get('/.well-known/oauth-protected-resource/mcp');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).resource).toBe('https://dev.aperture.rahuldatta.dev/mcp');
  });

  it('404s well-known metadata on a stage without the façade env (no APP_URL)', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    const res = await get('/.well-known/oauth-authorization-server');
    expect(res.statusCode).toBe(404);
  });

  it('403s a well-known request missing the origin secret (still behind the gate)', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.APP_URL = 'https://dev.aperture.rahuldatta.dev';
    const res = await get('/.well-known/oauth-authorization-server', {});
    expect(res.statusCode).toBe(403);
  });

  it('a finance tool call through the edge never builds a live Plaid gateway or sync invoker', async () => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    process.env.AGENT_TOKEN = 'agent-secret';
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_finance_overview', arguments: { today: '2026-09-26' } },
    });
    const res = await post({ ...OK_ORIGIN, 'x-aperture-agent-token': 'agent-secret' }, body);
    expect(res.statusCode).toBe(200);
    const out = JSON.parse(res.body) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(out.result.isError).toBeFalsy();
    expect(JSON.parse(out.result.content[0]!.text)).toMatchObject({
      today: '2026-09-26',
      banks: [],
    });
    expect(live.plaid).not.toHaveBeenCalled();
    expect(live.invoker).not.toHaveBeenCalled();
  });
});
