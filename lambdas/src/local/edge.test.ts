import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_TOKEN_HEADER, AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';
import { createBffHandler } from '../index';
import { createMcpHandler } from '../mcp/index';
import { localDeps } from './deps';
import {
  API_HEADERS,
  API_QUERY,
  MCP_HEADERS,
  WELL_KNOWN,
  createEdge,
  routeOf,
  toEvent,
} from './edge';
import type { EdgeEvent, EdgeResult } from './edge';

describe('routeOf', () => {
  it('routes only the paths CloudFront sends to a Lambda', () => {
    expect(routeOf('/api/listTasks')).toBe('api');
    expect(routeOf('/mcp')).toBe('mcp');
    expect(routeOf('/.well-known/oauth-protected-resource/mcp')).toBe('well-known');
    expect(routeOf('/.well-known/oauth-authorization-server')).toBe('well-known');
    expect(routeOf('/.well-known/openid-configuration')).toBe('well-known');
    expect(routeOf('/.well-known/openid-configuration/x')).toBeNull();
    expect(routeOf('/.well-known/other')).toBeNull();
    expect(routeOf('/mcp/x')).toBeNull();
    expect(routeOf('/tasks')).toBeNull();
  });
});

describe('toEvent — the origin request policies', () => {
  const url = (p: string) => new URL(p, 'http://local');
  const viewer = {
    [AUTH_HEADER]: 'Bearer a',
    authorization: 'Bearer b',
    [AGENT_TOKEN_HEADER]: 't',
    'content-type': 'application/json',
    accept: 'application/json',
    'mcp-protocol-version': '2025-06-18',
    cookie: 'c=1',
    [ORIGIN_SECRET_HEADER]: 'forged',
  };
  it('/api/* forwards the custom auth header and content-type only, never Authorization', () => {
    const e = toEvent('api', 'POST', url('/api/x'), viewer, '{}', 's');
    expect(e.headers).toEqual({
      [AUTH_HEADER]: 'Bearer a',
      'content-type': 'application/json',
      [ORIGIN_SECRET_HEADER]: 's',
    });
  });
  it('/mcp forwards the agent token, the MCP headers and Authorization', () => {
    const e = toEvent('mcp', 'POST', url('/mcp'), viewer, '{}', 's');
    expect(Object.keys(e.headers).sort()).toEqual(
      [
        AGENT_TOKEN_HEADER,
        'accept',
        'authorization',
        'content-type',
        'mcp-protocol-version',
        ORIGIN_SECRET_HEADER,
      ].sort(),
    );
  });
  it('stamps the secret over a viewer-sent one', () => {
    expect(
      toEvent('well-known', 'GET', url('/.well-known/oauth-authorization-server'), viewer, '', 's')
        .headers,
    ).toEqual({
      [ORIGIN_SECRET_HEADER]: 's',
    });
  });
  it('/api/* forwards only the OAuth callback query keys', () => {
    const e = toEvent('api', 'GET', url('/api/google/callback?code=c&state=s&x=1'), {}, '', 's');
    expect(e.queryStringParameters).toEqual({ code: 'c', state: 's' });
    expect(
      toEvent('mcp', 'POST', url('/mcp?code=c'), {}, '', 's').queryStringParameters,
    ).toBeUndefined();
  });
  it('an empty body is null, as a Function URL sends it', () => {
    expect(toEvent('api', 'GET', url('/api/health'), {}, '', 's').body).toBeNull();
  });
});

// The real edges over localDeps, behind a real listener — what `pnpm devcheck:local` talks to.
describe('the local server', () => {
  const POOL = 'us-west-1_LocalTest';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = {
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }],
  };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = (client: string, sub = 'u-1') => {
    const now = Math.floor(Date.now() / 1000);
    const iss = `https://cognito-idp.us-west-1.amazonaws.com/${POOL}`;
    const data = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64({ sub, iss, token_use: 'access', client_id: client, exp: now + 600, iat: now })}`;
    return `${data}.${sign('sha256', Buffer.from(data), privateKey).toString('base64url')}`;
  };
  const deps = localDeps({ poolId: POOL, claudeClientId: 'claude', jwks: jwks as never });
  const bff = createBffHandler(deps.bff) as (e: EdgeEvent) => Promise<EdgeResult>;
  const mcp = createMcpHandler(deps.mcp) as (e: EdgeEvent) => Promise<EdgeResult>;
  const server = createServer(createEdge({ bff, mcp }, 'secret'));
  let base = '';
  beforeAll(async () => {
    process.env.ORIGIN_SECRET = 'secret';
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    delete process.env.ORIGIN_SECRET;
    await new Promise((r) => server.close(r));
  });
  const rpc = (method: string, tok: string, args: unknown[] = []) =>
    fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${tok}` },
      body: JSON.stringify({ args }),
    });

  it('serves health through the edge, and the handler alone still 403s without the secret', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    const direct = await bff({
      rawPath: '/api/health',
      requestContext: { http: { path: '/api/health', method: 'GET' } },
      headers: {},
      body: null,
      isBase64Encoded: false,
    });
    expect(direct.statusCode).toBe(403);
  });
  it('a write and a read go through the real handler to the run’s table', async () => {
    const created = (await (
      await rpc('createTask', token('app'), [{ title: 'local' }])
    ).json()) as { id: string };
    const listed = (await (await rpc('listTasks', token('app'))).json()) as { id: string }[];
    expect(listed.map((t) => t.id)).toContain(created.id);
  });
  it('keeps ownership: another sub sees its own partition', async () => {
    const other = (await (await rpc('listTasks', token('app', 'u-2'))).json()) as unknown[];
    expect(other).toEqual([]);
  });
  it('D14: a claude-client token is 401 on /api and accepted on /mcp; an app token is 401 on /mcp', async () => {
    expect((await rpc('listTasks', token('claude'))).status).toBe(401);
    const call = (tok: string) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await call(token('claude'))).status).toBe(200);
    expect((await call(token('app'))).status).toBe(401);
  });
  it('a path CloudFront serves from S3 is not the edge’s', async () => {
    expect((await fetch(`${base}/tasks`)).status).toBe(404);
  });
  it('a Lambda 404 comes back as the app shell with a 200, as CloudFront’s errorResponses do', async () => {
    const res = await rpc('noSuchMethod', token('app'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
  });
});

// The stand-in's allowlists are copies of the distribution's; this fails when either side moves.
describe('edge.ts ↔ app-stack.ts', () => {
  const stack = readFileSync(new URL('../../../cdk/src/lib/app-stack.ts', import.meta.url), 'utf8');
  const consts: Record<string, string> = { AUTH_HEADER, AGENT_TOKEN_HEADER };
  const block = (name: string) => {
    const i = stack.indexOf(`'${name}'`);
    expect(i, name).toBeGreaterThan(-1);
    return stack.slice(i, stack.indexOf('});', i));
  };
  const lists = (src: string) =>
    [...src.matchAll(/allowList\(([^)]*)\)/g)].map((m) =>
      m[1]!
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => consts[x] ?? x.replace(/^'|'$/g, '')),
    );
  it('/api/*: the origin request policy’s headers and query keys', () => {
    expect(lists(block('ApiOriginPolicy'))).toEqual([API_HEADERS, API_QUERY]);
  });
  it('/mcp: the origin request policy’s headers plus the cache policy’s', () => {
    const [orp] = lists(block('McpOriginPolicy'));
    const [cache] = lists(block('McpCachePolicy'));
    expect([...orp!, ...cache!].sort()).toEqual([...MCP_HEADERS].sort());
  });
  it('the well-known behaviors', () => {
    const paths = [...stack.matchAll(/'(\/\.well-known\/[^']*)': wellKnownBehavior/g)].map((m) =>
      m[1]!.replace(/\*$/, ''),
    );
    expect(paths).toEqual(WELL_KNOWN);
  });
});
