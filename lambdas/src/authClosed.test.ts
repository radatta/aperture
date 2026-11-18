import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TOKEN_HEADER, AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';
import { createBffHandler } from './index';
import { createMcpHandler } from './mcp/index';
import { localDeps } from './local/deps';
import { signState } from './google/state';
import { DEV_STATE_SECRET } from './auth/strict';
import { BackendClient } from './backend';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';

// Fail closed on a stage (auth/strict.ts): the real edges, with the Lambda runtime's reserved var set as on a
// deployed function, refuse every credential path whose token or secret is unset — never the 'local' user. These
// are the off-dev rows of the bff-hardening scenario: each needs a deployed env var unset, which dev never is.
type Ev = Parameters<ReturnType<typeof createBffHandler>>[0];
type Res = { statusCode: number; body: string };

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }],
};
const ENV = [
  'STAGE',
  'AWS_LAMBDA_FUNCTION_NAME',
  'ORIGIN_SECRET',
  'AGENT_TOKEN',
  'DEVICE_TOKEN',
  'DEVICE_USER_ID',
];
const ORIGIN = 'origin-s3cret';
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
// A tool call that reads the table, so a request that got past auth would show in the doc's reads.
const backlog = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'list_backlog', arguments: {} },
});

let deps: ReturnType<typeof localDeps>;
const bff = (e: Ev, verifierless = false) =>
  createBffHandler(verifierless ? { ...deps.bff, verifier: null } : deps.bff)(e) as Promise<Res>;
const mcp = (e: Ev) => createMcpHandler(deps.mcp)(e) as Promise<Res>;
const http = (
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Ev => ({
  rawPath: path,
  requestContext: { http: { method, path } },
  headers,
  body: body ?? null,
});
const untouched = () => expect(deps.doc.gets.length + deps.doc.queries.length).toBe(0);

beforeEach(() => {
  deps = localDeps({
    poolId: 'us-west-1_AuthClosed',
    claudeClientId: 'claude',
    jwks: jwks as never,
  });
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'aperture-test';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.restoreAllMocks();
});

describe('fail closed on a stage — BFF', () => {
  it('no origin secret: every HTTP call is 403, health included', async () => {
    expect((await bff(http('GET', '/api/health', {}))).statusCode).toBe(403);
    expect(
      (await bff(http('POST', '/api/listTasks', { [ORIGIN_SECRET_HEADER]: 'x' }))).statusCode,
    ).toBe(403);
  });

  it('no verifier wired: a call is 401, never the local user', async () => {
    process.env.ORIGIN_SECRET = ORIGIN;
    const res = await bff(
      http(
        'POST',
        '/api/listTasks',
        { [ORIGIN_SECRET_HEADER]: ORIGIN, [AUTH_HEADER]: 'Bearer x' },
        '{"args":[]}',
      ),
      true,
    );
    expect(res.statusCode).toBe(401);
    untouched();
  });

  it('the right device token with no user bound: ingest is 401, never local', async () => {
    process.env.ORIGIN_SECRET = ORIGIN;
    process.env.DEVICE_TOKEN = 'device-tok';
    const ingest = () =>
      bff(
        http(
          'POST',
          '/api/lcSittingEvents',
          { [ORIGIN_SECRET_HEADER]: ORIGIN, [AUTH_HEADER]: 'Bearer device-tok' },
          '{"args":[]}',
        ),
      );
    expect((await ingest()).statusCode).toBe(401);
    untouched();
    process.env.DEVICE_USER_ID = 'sub-1'; // control: bound, the token gets past auth
    expect((await ingest()).statusCode).not.toBe(401);
  });

  it('no origin secret: a state signed with the dev key is refused on the Google callback (direct invoke)', async () => {
    const state = signState('someone', DEV_STATE_SECRET);
    const res = await bff({
      rawPath: '/api/google/callback',
      queryStringParameters: { code: 'c', state },
    } as Ev);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid state');
    // control: with the secret set, a state signed with it gets past the check (302 back to the app)
    process.env.ORIGIN_SECRET = ORIGIN;
    const ok = await bff({
      rawPath: '/api/google/callback',
      queryStringParameters: { code: 'c', state: signState('someone', ORIGIN) },
    } as Ev);
    expect(ok.statusCode).toBe(302);
  });

  it('no origin secret: Google connect can’t sign a state on a stage', async () => {
    const userId = 'someone';
    const client = new BackendClient(new Repo(deps.doc, liveWrites(deps.doc), userId), {
      userId,
      google: deps.bff.google,
    });
    await expect(client.googleConnectUrl()).rejects.toThrow(/not configured on this stage/);
  });
});

describe('fail closed on a stage — MCP', () => {
  it('no origin secret: 403', async () => {
    expect((await mcp(http('POST', '/mcp', { [AGENT_TOKEN_HEADER]: 'x' }, init))).statusCode).toBe(
      403,
    );
  });

  it('no agent token configured: the agent header is 401, never local', async () => {
    process.env.ORIGIN_SECRET = ORIGIN;
    process.env.DEVICE_USER_ID = 'sub-1';
    const res = await mcp(
      http('POST', '/mcp', { [ORIGIN_SECRET_HEADER]: ORIGIN, [AGENT_TOKEN_HEADER]: 'x' }, backlog),
    );
    expect(res.statusCode).toBe(401);
    untouched();
  });

  it('the right agent token with no user bound is 401', async () => {
    process.env.ORIGIN_SECRET = ORIGIN;
    process.env.AGENT_TOKEN = 'agent-tok';
    const res = await mcp(
      http(
        'POST',
        '/mcp',
        { [ORIGIN_SECRET_HEADER]: ORIGIN, [AGENT_TOKEN_HEADER]: 'agent-tok' },
        init,
      ),
    );
    expect(res.statusCode).toBe(401);
  });

  it('a wrong agent token is 401; the right one with a bound user is served', async () => {
    process.env.ORIGIN_SECRET = ORIGIN;
    process.env.AGENT_TOKEN = 'agent-tok';
    process.env.DEVICE_USER_ID = 'sub-1';
    const h = (t: string) => ({ [ORIGIN_SECRET_HEADER]: ORIGIN, [AGENT_TOKEN_HEADER]: t });
    expect((await mcp(http('POST', '/mcp', h('agent-tox'), init))).statusCode).toBe(401);
    expect((await mcp(http('POST', '/mcp', h('agent-tok'), init))).statusCode).toBe(200);
  });
});

describe('off a stage (local dev) — unchanged', () => {
  it('no agent token configured: the agent header is served as the local user', async () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    const res = await mcp(http('POST', '/mcp', { [AGENT_TOKEN_HEADER]: 'x' }, init));
    expect(res.statusCode).toBe(200);
  });

  it('no verifier and no origin secret: a BFF call is served as the local user', async () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    const res = await bff(http('POST', '/api/listTasks', {}, '{"args":[]}'), true);
    expect(res.statusCode).toBe(200);
  });
});
