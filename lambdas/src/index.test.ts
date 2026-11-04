import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { dayKey, PLACE_READ_DAILY_CAP } from '@aperture/shared';
import type { DocClient } from './ddb/DocClient';

// The edge builds its verifier and reads APP_URL at import, so both are set before it loads: a JWT pool
// is "configured" (so a place token on an RPC method meets a real verifier, not the 'local' fallback) and
// the verifier is a fake. The live table is an in-memory one, swapped per test behind a stable proxy.
const h = vi.hoisted(() => {
  process.env.USER_POOL_ID = 'pool-test';
  process.env.APP_URL = 'https://app.test';
  return { doc: null as unknown as DocClient };
});
vi.mock('./auth/verify', async (importActual) => {
  const actual = await importActual<typeof import('./auth/verify')>();
  const verifier = {
    verify: async (t: string) => {
      if (t === 'good-jwt') return { sub: 'u1' };
      throw new Error('bad signature');
    },
  };
  return { ...actual, createCognitoVerifier: () => verifier };
});
vi.mock('./ddb/LiveDoc', () => ({
  createLiveDoc: () =>
    new Proxy({} as DocClient, {
      get: (_t, k) => {
        const v = (h.doc as unknown as Record<PropertyKey, unknown>)[k];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(h.doc) : v;
      },
    }),
}));

import { handler, runtime } from './index';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { PlaceTokenStore } from './ddb/placeTokens';
import { BackendClient } from './backend';
import { hashPlaceToken } from './auth/placeToken';
import { placeTokenPk, PLACE_TOKEN_SK } from './ddb/keys';

afterAll(() => {
  delete process.env.USER_POOL_ID;
  delete process.env.APP_URL;
});

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

// The iPhone Shortcut's read: GET /api/places/<slug>/tasks with a place token (places.md; plan §6).
describe('handler place route', () => {
  const ORIGIN = { 'x-aperture-origin-secret': 's3cr3t' };
  let doc: InMemoryDoc;
  let backend: BackendClient;
  let logs: string[];

  beforeEach(() => {
    process.env.ORIGIN_SECRET = 's3cr3t';
    doc = new InMemoryDoc();
    h.doc = doc;
    backend = userBackend('u1');
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
  });
  afterEach(() => {
    delete process.env.ORIGIN_SECRET;
    vi.restoreAllMocks();
  });

  const userBackend = (userId: string) =>
    new BackendClient(new Repo(doc, liveWrites(doc), userId), {
      userId,
      placeTokens: new PlaceTokenStore(doc, liveWrites(doc)),
    });
  const read = (
    headers: Record<string, string | undefined>,
    opts: { method?: string; path?: string; body?: string } = {},
  ) => {
    const path = opts.path ?? '/api/places/safeway/tasks';
    return handler({
      rawPath: path,
      requestContext: { http: { method: opts.method ?? 'GET', path } },
      headers: { ...ORIGIN, ...headers },
      body: opts.body,
    });
  };
  const bearer = (token: string) => ({ 'x-aperture-authorization': `Bearer ${token}` });
  async function seeded() {
    await backend.upsertPlace({ name: 'Safeway' });
    await backend.createTask({ title: 'shampoo', place: 'safeway', notes: 'the blue one' });
    return (await backend.rotatePlaceToken()).token;
  }

  it('200: the digest and the lens link — titles only, no ids, notes or estimates', async () => {
    const token = await seeded();
    const res = await read(bearer(token));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toEqual({
      place: 'Safeway',
      slug: 'safeway',
      count: 1,
      titles: ['shampoo'],
      text: 'Safeway · 1 — shampoo',
      url: 'https://app.test/tasks?lens=places&place=safeway',
    });
    expect(res.body).not.toContain('the blue one');
    // Both heartbeats landed: the token's count and the place's lastReadAt.
    const row = await new PlaceTokenStore(doc, liveWrites(doc)).get(hashPlaceToken(token));
    expect(row).toMatchObject({ readsCount: 1, userId: 'u1' });
    expect(row!.lastUsedAt).not.toBeNull();
    expect((await backend.listPlaces())[0]!.lastReadAt).toBe(row!.lastUsedAt);
    expect((await backend.getPlaceTokenStatus()).readsToday).toBe(1);
  });

  it('405s any other method — a POST never reaches the RPC dispatch, even with a valid JWT', async () => {
    const token = await seeded();
    const before = doc.snapshot();
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const res = await read(
        { ...bearer('good-jwt') },
        { method, body: JSON.stringify({ args: [] }) },
      );
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('GET');
    }
    expect((await read(bearer(token), { method: 'POST', body: '{not json' })).statusCode).toBe(405);
    expect(doc.snapshot()).toEqual(before);
  });

  it('401s a missing header before any lookup', async () => {
    await seeded();
    const gets = doc.gets.length;
    const res = await read({});
    expect(res.statusCode).toBe(401);
    expect(doc.gets.length).toBe(gets);
  });

  it('401s a JWT or any non-place token without a lookup, and an unknown token after one', async () => {
    await seeded();
    const before = doc.snapshot();
    let gets = doc.gets.length;
    expect((await read(bearer('good-jwt'))).statusCode).toBe(401); // a JWT is no place token
    expect((await read(bearer('apl_short'))).statusCode).toBe(401);
    expect(doc.gets.length).toBe(gets);
    gets = doc.gets.length;
    const unknown = `apl_${'A'.repeat(43)}`;
    const res = await read(bearer(unknown));
    expect(res.statusCode).toBe(401);
    expect(doc.gets.length).toBe(gets + 1); // the one lookup
    expect(doc.snapshot()).toEqual(before); // and no write
  });

  it('403s without the origin secret, even with a valid token', async () => {
    const token = await seeded();
    const res = await handler({
      rawPath: '/api/places/safeway/tasks',
      requestContext: { http: { method: 'GET', path: '/api/places/safeway/tasks' } },
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s an unknown slug only after auth, writing nothing', async () => {
    const token = await seeded();
    const before = doc.snapshot();
    const path = '/api/places/target/tasks';
    expect((await read({}, { path })).statusCode).toBe(401); // no probing without a token
    const res = await read(bearer(token), { path });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: 'No place "target" — add it in Settings › Places',
    });
    // A path the route regex refuses is the route's too — never the RPC dispatch.
    expect((await read(bearer(token), { path: '/api/places/Safeway/tasks' })).statusCode).toBe(404);
    expect((await read({}, { path: '/api/places/x' })).statusCode).toBe(401);
    expect(doc.snapshot()).toEqual(before);
  });

  it('429s at the daily cap with no task read and no write', async () => {
    const token = await seeded();
    const store = new PlaceTokenStore(doc, liveWrites(doc));
    const hash = hashPlaceToken(token);
    const row = (await store.get(hash))!;
    await doc.put({
      PK: placeTokenPk(hash),
      SK: PLACE_TOKEN_SK,
      ...row,
      readsDay: dayKey(Date.now(), 0),
      readsCount: PLACE_READ_DAILY_CAP,
    });
    const before = doc.snapshot();
    const query = vi.spyOn(doc, 'query');
    const res = await read(bearer(token));
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: 'Daily read cap reached' });
    expect(query).not.toHaveBeenCalled();
    expect(doc.snapshot()).toEqual(before);
  });

  it('401s a rotated-out or revoked token', async () => {
    const first = await seeded();
    const second = (await backend.rotatePlaceToken()).token;
    expect((await read(bearer(first))).statusCode).toBe(401);
    expect((await read(bearer(second))).statusCode).toBe(200);
    await backend.revokePlaceToken();
    expect((await read(bearer(second))).statusCode).toBe(401);
  });

  it('a place token opens nothing else: an RPC method 401s it', async () => {
    const token = await seeded();
    for (const method of ['listTasks', 'listPlaceTasks', 'rotatePlaceToken']) {
      const res = await handler({
        rawPath: `/api/${method}`,
        requestContext: { http: { method: 'POST', path: `/api/${method}` } },
        headers: { ...ORIGIN, ...bearer(token) },
        body: JSON.stringify({ args: ['safeway'] }),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('logs one outcome line per read, carrying no token or hash', async () => {
    const token = await seeded();
    await read(bearer(token));
    await read({});
    await read(bearer(`apl_${'B'.repeat(43)}`));
    const lines = logs.filter((l) => l.includes('place_read'));
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: 'place_read', ok: true, reason: 'ok' },
      { event: 'place_read', ok: false, reason: 'missing' },
      { event: 'place_read', ok: false, reason: 'unknown' },
    ]);
    const all = logs.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain(hashPlaceToken(token));
    expect(all).not.toContain('B'.repeat(43));
  });
});
