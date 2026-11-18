import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import {
  API_METHODS,
  CAPTURE_DAILY_CAP,
  CAPTURE_SAY,
  dayKey,
  PLACE_READ_DAILY_CAP,
  PLACE_READ_TEXT,
  placeReadUnknownText,
} from '@aperture/shared';
import type { DocClient } from './ddb/DocClient';

// The edge builds its verifier and reads APP_URL at import, so both are set before it loads: a JWT pool
// is "configured" (so a place token on an RPC method meets a real verifier, not the 'local' fallback) and
// the verifier is a fake. The live table is an in-memory one, swapped per test behind a stable proxy.
const h = vi.hoisted(() => {
  process.env.USER_POOL_ID = 'pool-test';
  process.env.APP_URL = 'https://app.test';
  return { doc: null as unknown as DocClient, liveWritesCalls: 0 };
});
// Counts the edge's liveWrites builds (one per place read — the token store and the Repo share it).
vi.mock('./ddb/writes', async (importActual) => {
  const actual = await importActual<typeof import('./ddb/writes')>();
  return {
    ...actual,
    liveWrites: (d: DocClient) => (h.liveWritesCalls++, actual.liveWrites(d)),
  };
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
import { RPC_BODY_MAX } from './rpc/argSpecs';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { PlaceTokenStore } from './ddb/placeTokens';
import { ScopedTokenStore } from './ddb/scopedTokens';
import { BackendClient } from './backend';
import { hashPlaceToken } from './auth/placeToken';
import { pk, placeTokenPk, PLACE_TOKEN_SK, sk } from './ddb/keys';

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

// Device-token ingest branch: the auth-failure paths here return before any DynamoDB access; the
// sittings block below drives the accepted ones. No external calls.
describe('handler device-token ingest branch', () => {
  afterEach(() => {
    delete process.env.DEVICE_TOKEN;
    delete process.env.DEVICE_USER_ID;
  });

  const ingest = (headers: Record<string, string | undefined>, method = 'lcSittingEvents') =>
    handler({
      rawPath: `/api/${method}`,
      requestContext: { http: { method: 'POST', path: `/api/${method}` } },
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

  // The legacy per-submission write is gone (PR D): a stray v1 build's device token falls to the JWT
  // path and 401s, a JWT reaches handleRpc and 404s, and neither reads or writes a row — twice over.
  it('refuses recordLeetcodeAttempt: 401 with the device token, 404 with a JWT, the table untouched', async () => {
    process.env.DEVICE_TOKEN = 'right-token';
    process.env.DEVICE_USER_ID = 'u-dev';
    const real = new InMemoryDoc();
    const touched: string[] = [];
    h.doc = new Proxy(real, {
      get: (t, k) => {
        const v = Reflect.get(t, k) as unknown;
        if (typeof v !== 'function') return v;
        return (...a: unknown[]) => (
          touched.push(String(k)),
          (v as (...x: unknown[]) => unknown).apply(t, a)
        );
      },
    });
    for (let i = 0; i < 2; i++) {
      const device = await ingest(
        { 'x-aperture-authorization': 'Bearer right-token' },
        'recordLeetcodeAttempt',
      );
      expect(device.statusCode).toBe(401);
      const jwt = await ingest(
        { 'x-aperture-authorization': 'Bearer good-jwt' },
        'recordLeetcodeAttempt',
      );
      expect(jwt.statusCode).toBe(404);
      expect(JSON.parse(jwt.body).error).toBe('Unknown method: recordLeetcodeAttempt');
    }
    expect(touched).toEqual([]);
  });

  // The device token's whole scope, pinned as a set: every other method, today's or a future one, 401s.
  it('the device token opens exactly lcSittingStart and lcSittingEvents', async () => {
    process.env.DEVICE_TOKEN = 'right-token';
    process.env.DEVICE_USER_ID = 'u-dev';
    h.doc = new InMemoryDoc();
    const opened: string[] = [];
    for (const m of API_METHODS)
      if (
        (await ingest({ 'x-aperture-authorization': 'Bearer right-token' }, m)).statusCode !== 401
      )
        opened.push(m);
    expect(opened).toEqual(['lcSittingStart', 'lcSittingEvents']);
  });

  // The sittings' ingest set: the device token or the user's JWT, nothing else; a body over the cap is
  // refused before it's parsed.
  describe('sittings', () => {
    beforeEach(() => {
      h.doc = new InMemoryDoc();
    });
    const rpc = (
      method: string,
      headers: Record<string, string>,
      args: unknown[] = [{}],
      raw?: string,
    ) =>
      handler({
        rawPath: `/api/${method}`,
        requestContext: { http: { method: 'POST', path: `/api/${method}` } },
        headers,
        body: raw ?? JSON.stringify({ args }),
      });
    const start = {
      clientSittingId: '01JC0000000000000000000000',
      problemSlug: 'two-sum',
      problemTitle: 'Two Sum',
      lang: 'python3',
      startedAt: Date.now(),
      tzOffsetMinutes: 480,
    };

    it('the device token starts a sitting as DEVICE_USER_ID', async () => {
      process.env.DEVICE_TOKEN = 'right-token';
      process.env.DEVICE_USER_ID = 'u-dev';
      const b = new BackendClient(new Repo(h.doc, liveWrites(h.doc), 'u-dev'), { userId: 'u-dev' });
      const roll = await b.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
      await b.updateSettings({ leetcodeRollId: roll.id });
      const res = await rpc(
        'lcSittingStart',
        { 'x-aperture-authorization': 'Bearer right-token' },
        [start],
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ resumed: false, sitting: { userId: 'u-dev' } });
    });

    it('a JWT passes the ingest gate as its own user', async () => {
      process.env.DEVICE_TOKEN = 'right-token';
      const res = await rpc('lcSittingStart', { 'x-aperture-authorization': 'Bearer good-jwt' }, [
        start,
      ]);
      expect(res.statusCode).toBe(400); // u1 has no LeetCode roll linked — past auth
      expect(JSON.parse(res.body).error).toMatch(/LeetCode roll/);
    });

    it('401s a token that is neither, and the device token on any read', async () => {
      process.env.DEVICE_TOKEN = 'right-token';
      expect(
        (await rpc('lcSittingEvents', { 'x-aperture-authorization': 'Bearer nope' })).statusCode,
      ).toBe(401);
      for (const m of [
        'listSittings',
        'getSitting',
        'pullLiveSitting',
        'listSittingReplay',
        'setSittingPrepTarget',
        'setSittingReview',
        'draftSittingReview',
        'deleteSitting',
      ])
        expect(
          (await rpc(m, { 'x-aperture-authorization': 'Bearer right-token' }, [])).statusCode,
        ).toBe(401);
    });

    it('says which ingest failures are worth a retry: 409 a lost race, 429 a throttle, 500 a fault', async () => {
      process.env.DEVICE_TOKEN = 'right-token';
      const headers = { 'x-aperture-authorization': 'Bearer right-token' };
      const fail = (e: Error) => {
        h.doc = new InMemoryDoc();
        vi.spyOn(h.doc, 'get').mockRejectedValue(e);
      };
      const conflict = Object.assign(new Error('Conflict — try again'), { name: 'ConflictError' });
      const throttle = Object.assign(new Error('slow down'), {
        name: 'ThrottlingException',
        $metadata: {},
      });
      const fault = Object.assign(new Error('boom'), {
        name: 'InternalServerError',
        $metadata: { httpStatusCode: 500 },
      });
      const limit = Object.assign(new Error('limit'), {
        name: 'RequestLimitExceeded',
        $metadata: {},
      });
      const invalid = Object.assign(new Error('bad item'), {
        name: 'ValidationException',
        $metadata: { httpStatusCode: 400 },
      });
      const events = [
        {
          sittingId: '01JC0000000000000000000000',
          events: [{ id: '01JC0000000000000000000001', type: 'note', at: 1, payload: {} }],
        },
      ];
      for (const [e, code] of [
        [conflict, 409],
        [throttle, 429],
        [limit, 429],
        [fault, 500],
        [invalid, 400],
        [new TypeError('our bug'), 500],
      ] as const) {
        fail(e);
        const res = await rpc('lcSittingEvents', headers, events);
        expect(res.statusCode).toBe(code);
        // A fault's text is internals: the extension retries on the status alone.
        if (code === 500) expect(JSON.parse(res.body ?? '{}')).toEqual({ error: 'Internal error' });
      }
      vi.restoreAllMocks();
      h.doc = new InMemoryDoc();
      expect(
        (await rpc('lcSittingEvents', headers, [{ sittingId: 'bad', events: [] }])).statusCode,
      ).toBe(400);
    });

    it('a wrongly shaped ingest call is a 400 on the device-token path, not a 500', async () => {
      process.env.DEVICE_TOKEN = 'right-token';
      const headers = { 'x-aperture-authorization': 'Bearer right-token' };
      for (const [args, error] of [
        [[null], 'A sitting start is required'],
        [[{}, {}], 'lcSittingStart takes at most 1 argument'],
      ] as const) {
        const res = await rpc('lcSittingStart', headers, [...args]);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body ?? '{}')).toEqual({ error });
      }
      expect((h.doc as InMemoryDoc).size).toBe(0);
    });

    it('events inside the grace answer 200 with the status and the skipped count; past it a 400', async () => {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      try {
        process.env.DEVICE_TOKEN = 'right-token';
        process.env.DEVICE_USER_ID = 'u-dev';
        const headers = { 'x-aperture-authorization': 'Bearer right-token' };
        const b = new BackendClient(new Repo(h.doc, liveWrites(h.doc), 'u-dev'), {
          userId: 'u-dev',
        });
        const roll = await b.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
        await b.updateSettings({ leetcodeRollId: roll.id });
        const { sitting } = await b.lcSittingStart({ ...start, startedAt: t0 });
        vi.setSystemTime(t0 + 5 * 60_000);
        await b.setTaskActual(sitting.repTaskId, 5);
        await b.transitionTask(sitting.repTaskId, 'done');
        vi.setSystemTime(t0 + 7 * 60_000);
        const note = (id: string, at: number) => ({ id, type: 'note', at, payload: {} });
        const events = (...e: unknown[]) => [{ sittingId: sitting.id, events: e }];
        const late = await rpc(
          'lcSittingEvents',
          headers,
          events(
            note('01JC0000000000000000000001', t0 + 60_000),
            note('01JC0000000000000000000002', t0 + 7 * 60_000),
          ),
        );
        expect(late.statusCode).toBe(200);
        expect(JSON.parse(late.body)).toEqual({
          accepted: 1,
          duplicates: 0,
          skipped: 1,
          version: 0,
          status: 'done',
        });
        vi.setSystemTime(t0 + 16 * 60_000);
        const gone = await rpc(
          'lcSittingEvents',
          headers,
          events(note('01JC0000000000000000000003', t0 + 60_000)),
        );
        expect(gone.statusCode).toBe(400);
        expect(JSON.parse(gone.body).error).toMatch(/ended/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('413s an ingest body over the cap before parsing it', async () => {
      process.env.DEVICE_TOKEN = 'right-token';
      const res = await rpc(
        'lcSittingEvents',
        { 'x-aperture-authorization': 'Bearer right-token' },
        [],
        'x'.repeat(301 * 1024),
      );
      expect(res.statusCode).toBe(413);
    });
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
    const path = opts.path ?? '/api/places/grocer/tasks';
    return handler({
      rawPath: path,
      requestContext: { http: { method: opts.method ?? 'GET', path } },
      headers: { ...ORIGIN, ...headers },
      body: opts.body,
    });
  };
  const bearer = (token: string) => ({ 'x-aperture-authorization': `Bearer ${token}` });
  async function seeded() {
    await backend.upsertPlace({ name: 'Grocer' });
    await backend.createTask({ title: 'shampoo', place: 'grocer', notes: 'the blue one' });
    return (await backend.rotatePlaceToken()).token;
  }

  it('200: the digest and the lens link — titles only, no ids, notes or estimates', async () => {
    const token = await seeded();
    const res = await read(bearer(token));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toEqual({
      place: 'Grocer',
      slug: 'grocer',
      count: 1,
      titles: ['shampoo'],
      text: 'Grocer · 1 — shampoo',
      url: 'https://app.test/tasks?lens=places&place=grocer',
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
      expect(JSON.parse(res.body)).toEqual({
        error: 'Method Not Allowed',
        text: PLACE_READ_TEXT.method,
      });
    }
    expect((await read(bearer(token), { method: 'POST', body: '{not json' })).statusCode).toBe(405);
    expect(doc.snapshot()).toEqual(before);
  });

  it('401s a missing header before any lookup', async () => {
    await seeded();
    const gets = doc.gets.length;
    const res = await read({});
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized: missing place token',
      text: PLACE_READ_TEXT.unauthorized,
    });
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
    expect(JSON.parse(res.body).text).toBe(PLACE_READ_TEXT.unauthorized);
    expect(doc.gets.length).toBe(gets + 1); // the one lookup
    expect(doc.snapshot()).toEqual(before); // and no write
  });

  it('403s without the origin secret, even with a valid token', async () => {
    const token = await seeded();
    const res = await handler({
      rawPath: '/api/places/grocer/tasks',
      requestContext: { http: { method: 'GET', path: '/api/places/grocer/tasks' } },
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(403);
  });

  // Never 404: CloudFront serves index.html as a 200 for an origin 403/404 (cdk app-stack errorResponses),
  // which the Shortcut would read as an empty list.
  it('422s an unknown slug only after auth, writing nothing, with text for the notification', async () => {
    const token = await seeded();
    const before = doc.snapshot();
    const path = '/api/places/tackle/tasks';
    expect((await read({}, { path })).statusCode).toBe(401); // no probing without a token
    const res = await read(bearer(token), { path });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({
      error: 'No place "tackle" — add it in Settings › Places',
      text: placeReadUnknownText('tackle'),
    });
    expect(placeReadUnknownText('tackle')).toBe(
      'Aperture: no place "tackle" — check the Shortcut\'s input or Settings › Places',
    );
    // A path the route regex refuses is the route's too — never the RPC dispatch, never a 404.
    for (const bad of ['/api/places/x', '/api/places//tasks', '/api/places/a%20b/tasks']) {
      expect((await read({}, { path: bad })).statusCode).toBe(401);
      const r = await read(bearer(token), { path: bad });
      expect(r.statusCode).toBe(422);
      expect(JSON.parse(r.body)).toEqual({ error: 'Not a place list', text: PLACE_READ_TEXT.path });
    }
    expect(doc.snapshot()).toEqual(before);
  });

  it('matches the slug case-insensitively: an automation passing "Grocer" reads grocer', async () => {
    const token = await seeded();
    const res = await read(bearer(token), { path: '/api/places/GroCer/tasks' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ slug: 'grocer', count: 1 });
  });

  it('an empty list is a 200 with text "" — the one case the Shortcut shows nothing', async () => {
    await backend.upsertPlace({ name: 'Tackle' });
    const token = (await backend.rotatePlaceToken()).token;
    const res = await read(bearer(token), { path: '/api/places/tackle/tasks' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ count: 0, titles: [], text: '' });
  });

  it('builds one writes per read, shared by the token count and the heartbeat', async () => {
    const token = await seeded();
    h.liveWritesCalls = 0;
    expect((await read(bearer(token))).statusCode).toBe(200);
    expect(h.liveWritesCalls).toBe(1);
  });

  it('a 500 has text too, and logs a fixed code plus the error name — never the message', async () => {
    const token = await seeded();
    const boom = Object.assign(new Error('secret detail'), { name: 'InternalServerError' });
    vi.spyOn(doc, 'query').mockRejectedValueOnce(boom);
    const res = await read(bearer(token));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal error', text: PLACE_READ_TEXT.error });
    expect(logs.filter((l) => l.includes('place_read')).map((l) => JSON.parse(l))).toEqual([
      { event: 'place_read', ok: false, reason: 'error', name: 'InternalServerError' },
    ]);
    expect(logs.join('\n')).not.toContain('secret detail');
  });

  it('a failed heartbeat after the count still answers 200 with the digest', async () => {
    const token = await seeded();
    const [place] = await backend.listPlaces();
    const key = { pk: 'u#u1', sk: `place#${place!.id}` };
    const putIf = doc.putIf.bind(doc);
    vi.spyOn(doc, 'putIf').mockImplementation(async (item, expected) => {
      if (item.PK === key.pk && item.SK === key.sk) throw new Error('throttled');
      return putIf(item, expected);
    });
    const res = await read(bearer(token));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ count: 1, text: 'Grocer · 1 — shampoo' });
    expect(logs.some((l) => l.includes('place_heartbeat_failed'))).toBe(true);
    const row = await new PlaceTokenStore(doc, liveWrites(doc)).get(hashPlaceToken(token));
    expect(row!.readsCount).toBe(1);
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
    expect(JSON.parse(res.body)).toEqual({
      error: 'Daily read cap reached',
      text: PLACE_READ_TEXT.cap,
    });
    expect(query).not.toHaveBeenCalled();
    expect(doc.snapshot()).toEqual(before);
  });

  it('401s a rotated-out or revoked token', async () => {
    const first = await seeded();
    const second = (await backend.rotatePlaceToken()).token;
    const stale = await read(bearer(first));
    expect(stale.statusCode).toBe(401);
    expect(JSON.parse(stale.body).text).toBe(PLACE_READ_TEXT.unauthorized);
    expect((await read(bearer(second))).statusCode).toBe(200);
    await backend.revokePlaceToken();
    expect((await read(bearer(second))).statusCode).toBe(401);
  });

  // The pointer is the authority: a lookup row whose delete was cut short still exists, but the pointer
  // no longer names it, so the old token is dead the moment revoke/rotate moved the pointer.
  it('401s the old token when its row survives a failed delete mid-revoke', async () => {
    const token = await seeded();
    const hash = hashPlaceToken(token);
    vi.spyOn(doc, 'delete').mockRejectedValueOnce(new Error('throttled'));
    await expect(backend.revokePlaceToken()).rejects.toThrow('throttled');
    expect(await new PlaceTokenStore(doc, liveWrites(doc)).get(hash)).not.toBeNull();
    const res = await read(bearer(token));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Unauthorized: place token revoked',
      text: PLACE_READ_TEXT.unauthorized,
    });
    expect(logs.map((l) => JSON.parse(l))).toContainEqual({
      event: 'place_read',
      ok: false,
      reason: 'revoked',
    });
  });

  it('401s the old token when its row survives a failed delete mid-rotate; the next rotate cleans up', async () => {
    const first = await seeded();
    const store = new PlaceTokenStore(doc, liveWrites(doc));
    vi.spyOn(doc, 'delete').mockRejectedValueOnce(new Error('throttled'));
    await expect(backend.rotatePlaceToken()).rejects.toThrow('throttled');
    expect(await store.get(hashPlaceToken(first))).not.toBeNull();
    expect((await read(bearer(first))).statusCode).toBe(401);
    const second = (await backend.rotatePlaceToken()).token;
    expect(await store.get(hashPlaceToken(first))).toBeNull(); // the leftover, retried
    expect((await read(bearer(first))).statusCode).toBe(401);
    expect((await read(bearer(second))).statusCode).toBe(200);
  });

  it('a just-minted token reads at once — the lookup and pointer reads are consistent', async () => {
    const old = await seeded();
    const ptrItem = await doc.get('u#u1', 'ptoken', { consistent: true });
    const token = (await backend.rotatePlaceToken()).token;
    // An eventually consistent read would still miss the new row and see the old pointer.
    doc.staleNextGets(placeTokenPk(hashPlaceToken(token)), PLACE_TOKEN_SK, null, 5);
    doc.staleNextGets('u#u1', 'ptoken', ptrItem, 5);
    expect((await read(bearer(token))).statusCode).toBe(200);
    expect((await read(bearer(old))).statusCode).toBe(401);
  });

  it('a place token opens nothing else: an RPC method 401s it', async () => {
    const token = await seeded();
    for (const method of ['listTasks', 'listPlaceTasks', 'rotatePlaceToken']) {
      const res = await handler({
        rawPath: `/api/${method}`,
        requestContext: { http: { method: 'POST', path: `/api/${method}` } },
        headers: { ...ORIGIN, ...bearer(token) },
        body: JSON.stringify({ args: ['grocer'] }),
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

// testMode is the CI smoke's dry run over a DIRECT invoke; over the Function URL it opens nothing.
// Voice capture: POST /api/capture with a capture token (capture.md). Grammar lines only here — the edge's
// live model is never called in a test; the model path is backend.capture.test.ts's.
describe('handler capture route', () => {
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
      scopedTokens: new ScopedTokenStore(doc, liveWrites(doc)),
    });
  const post = (
    headers: Record<string, string | undefined>,
    body: unknown,
    opts: { method?: string; path?: string; raw?: boolean } = {},
  ) => {
    const path = opts.path ?? '/api/capture';
    return handler({
      rawPath: path,
      requestContext: { http: { method: opts.method ?? 'POST', path } },
      headers: { ...ORIGIN, ...headers },
      body: opts.raw ? (body as string) : JSON.stringify(body),
    });
  };
  const bearer = (token: string) => ({ 'x-aperture-authorization': `Bearer ${token}` });
  const mint = async (name = 'iPhone') => (await backend.mintScopedToken('capture', name)).token;
  const said = (res: { body: string }) => (JSON.parse(res.body) as { say: string }).say;

  it('200: a grammar line becomes a task, answered with a sentence to speak and the receipt', async () => {
    const token = await mint();
    const res = await post(bearer(token), { text: 'call mum | ~15' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      say: 'Added: call mum.',
      raw: false,
      duplicate: false,
      due: null,
    });
    expect(body.detail).toBe('Added: call mum · no category · 15m');
    const task = await backend.getTask(body.id as string);
    expect(task).toMatchObject({ title: 'call mum', estimateMin: 15 });
    expect((await backend.listScopedTokens('capture'))[0]).toMatchObject({ usedToday: 1 });
    expect((await backend.listScopedTokens('capture'))[0]!.lastUsedAt).not.toBeNull();
  });

  it('the same line within a minute is the first one again — one task, the same id', async () => {
    const token = await mint();
    const first = JSON.parse((await post(bearer(token), { text: 'milk | ~5' })).body);
    const again = await post(bearer(token), { text: '  MILK  |  ~5 ' });
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ id: first.id, duplicate: true });
    expect(said(again)).toBe('Already added: milk.');
    expect((await backend.listTasks()).filter((t) => t.title === 'milk')).toHaveLength(1);
    // A different line is a new capture.
    const other = JSON.parse((await post(bearer(token), { text: 'eggs | ~5' })).body);
    expect(other.id).not.toBe(first.id);
  });

  it('401s a missing, malformed, unknown or revoked token with a say — writing nothing', async () => {
    const token = await mint();
    await backend.mintScopedToken('capture', 'Raycast');
    const placeToken = (await backend.rotatePlaceToken()).token;
    const before = doc.snapshot();
    const gets = doc.gets.length;
    for (const headers of [{}, bearer('good-jwt'), bearer('apc_short'), bearer(placeToken)]) {
      const res = await post(headers, { text: 'x | ~5' });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({
        error: 'Unauthorized',
        say: CAPTURE_SAY.unauthorized,
      });
    }
    expect(doc.gets.length).toBe(gets); // none of those cost a read
    expect((await post(bearer(`apc_${'A'.repeat(43)}`), { text: 'x | ~5' })).statusCode).toBe(401);
    expect(doc.snapshot()).toEqual(before);

    const [phone, mac] = await backend.listScopedTokens('capture');
    await backend.revokeScopedToken(phone!.id);
    expect((await post(bearer(token), { text: 'x | ~5' })).statusCode).toBe(401);
    // The neighbour still works.
    const other = await backend.mintScopedToken('capture', 'Spare');
    expect((await post(bearer(other.token), { text: 'x | ~5' })).statusCode).toBe(200);
    expect(mac).toBeDefined();
    expect(
      logs.some((l) => l.includes('"reason":"revoked"') || l.includes('"reason":"unknown"')),
    ).toBe(true);
  });

  it('a capture token opens nothing else: the RPC path and the place route refuse it', async () => {
    const token = await mint();
    const rpc = await handler({
      rawPath: '/api/listTasks',
      requestContext: { http: { method: 'POST', path: '/api/listTasks' } },
      headers: { ...ORIGIN, ...bearer(token) },
      body: JSON.stringify({ args: [] }),
    });
    expect(rpc.statusCode).toBe(401);
    const place = await handler({
      rawPath: '/api/places/grocer/tasks',
      requestContext: { http: { method: 'GET', path: '/api/places/grocer/tasks' } },
      headers: { ...ORIGIN, ...bearer(token) },
    });
    expect(place.statusCode).toBe(401);
  });

  it('405s anything but POST and 422s a bad path or body — after auth, uncounted, all with a say', async () => {
    const token = await mint();
    const get = await post(bearer(token), null, { method: 'GET' });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect(said(get)).toBe(CAPTURE_SAY.method);
    expect((await post({}, { text: 'x' }, { path: '/api/capture/x' })).statusCode).toBe(401);
    const cases: [unknown, boolean, string, string][] = [
      [{ text: 'x' }, false, '/api/capture/x', CAPTURE_SAY.path],
      ['{not json', true, '/api/capture', CAPTURE_SAY.empty],
      [['x'], false, '/api/capture', CAPTURE_SAY.empty],
      [{ text: 5 }, false, '/api/capture', CAPTURE_SAY.empty],
      [{ text: 'x', voice: 'yes' }, false, '/api/capture', CAPTURE_SAY.empty],
      [{ text: '   ' }, false, '/api/capture', CAPTURE_SAY.empty],
      [{ text: 'x'.repeat(2_501) }, false, '/api/capture', CAPTURE_SAY.tooLong],
    ];
    for (const [body, raw, path, say] of cases) {
      const res = await post(bearer(token), body, { raw, path });
      expect(res.statusCode).toBe(422);
      expect(said(res)).toBe(say);
    }
    const big = await post(bearer(token), { text: 'x'.repeat(20_000) });
    expect(big.statusCode).toBe(413);
    expect(said(big)).toBe(CAPTURE_SAY.tooLong);
    expect((await backend.listScopedTokens('capture'))[0]!.usedToday).toBe(0);
    expect(await backend.listTasks()).toEqual([]);
  });

  it('a voice flag sent as the text "true" counts, and a base64 body reads', async () => {
    const token = await mint();
    const res = await post(bearer(token), { text: 'a | ~5', voice: 'true' });
    expect(res.statusCode).toBe(200);
    const b64 = await handler({
      rawPath: '/api/capture',
      requestContext: { http: { method: 'POST', path: '/api/capture' } },
      headers: { ...ORIGIN, ...bearer(token) },
      body: Buffer.from(JSON.stringify({ text: 'b | ~5' })).toString('base64'),
      isBase64Encoded: true,
    });
    expect(b64.statusCode).toBe(200);
    expect(said(b64)).toBe('Added: b.');
  });

  it(`429s past ${CAPTURE_DAILY_CAP} a day with a say, adding nothing`, async () => {
    const token = await mint();
    const store = new ScopedTokenStore(doc, liveWrites(doc));
    const [info] = await backend.listScopedTokens('capture');
    const row = (await store.row('u1', info!.id))!;
    const day = dayKey(Date.now(), 0);
    await store.replaceRow('u1', row, {
      ...row,
      usesDay: day,
      uses: CAPTURE_DAILY_CAP,
      updatedAt: row.updatedAt + 1,
    });
    const res = await post(bearer(token), { text: 'x | ~5' });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Daily capture cap reached',
      say: CAPTURE_SAY.cap,
    });
    expect(await backend.listTasks()).toEqual([]);
  });

  it('409s with a spoken "say it again" when every retry of the token row lost a race (F224)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const token = await mint();
    const [info] = await backend.listScopedTokens('capture');
    const key = [pk('u1'), sk.stoken(info!.id)] as const;
    const rival = () => {
      const row = doc.snapshot().find((i) => i.PK === key[0] && i.SK === key[1])!;
      doc.putNow({ ...row, updatedAt: (row.updatedAt as number) + 1 });
      doc.interceptNextPutIf(...key, rival);
    };
    doc.interceptNextPutIf(...key, rival);
    const res = await post(bearer(token), { text: 'milk | ~5' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Capture token busy', say: CAPTURE_SAY.busy });
    expect(await backend.listTasks()).toEqual([]);
    const line = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === 'capture');
    expect(line).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('never logs the text, the token or its hash — the outcome only', async () => {
    const token = await mint();
    await post(bearer(token), { text: 'secret plan | ~5' });
    await post(bearer(`apc_${'B'.repeat(43)}`), { text: 'secret plan | ~5' });
    const all = logs.join('\n');
    for (const leak of ['secret plan', token, token.slice(4)]) expect(all).not.toContain(leak);
    const lines = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const cap = lines.filter((l) => l.event === 'capture');
    expect(cap.map((l) => [l.ok, l.reason])).toEqual([
      [true, 'ok'],
      [false, 'unknown'],
    ]);
  });

  it('a 500 still says something, and logs only the error name', async () => {
    const token = await mint();
    vi.spyOn(BackendClient.prototype, 'createTask').mockRejectedValueOnce(
      new Error('secret detail'),
    );
    const res = await post(bearer(token), { text: 'x | ~5' });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Internal error', say: CAPTURE_SAY.error });
    expect(logs.join('\n')).not.toContain('secret detail');
    // The failed line is forgotten: a retry is a new capture, not "already got that".
    const retry = await post(bearer(token), { text: 'x | ~5' });
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.body)).toMatchObject({ duplicate: false });
  });
});

describe('handler testMode and body parsing', () => {
  let logs: string[];
  beforeEach(() => {
    h.doc = new InMemoryDoc();
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
  });
  afterEach(() => vi.restoreAllMocks());

  const http = (method: string, body: string, auth?: string) =>
    handler({
      rawPath: `/api/${method}`,
      requestContext: { http: { method: 'POST', path: `/api/${method}` } },
      headers: auth ? { authorization: auth } : {},
      body,
    });
  const errorOf = (res: { body?: string }) =>
    (JSON.parse(res.body ?? '{}') as { error?: string }).error;

  it('an HTTP request with testMode and no JWT is a 401 — the flag opens nothing over the Function URL', async () => {
    const doc = h.doc as InMemoryDoc;
    for (const [method, args] of [
      ['getSettings', []],
      ['createTask', [{ title: 'x' }]],
    ] as const) {
      const res = await http(method, JSON.stringify({ testMode: true, args }));
      expect(res.statusCode).toBe(401);
    }
    expect(doc.size).toBe(0);
    expect(doc.gets).toHaveLength(0);
  });

  it('an HTTP request with testMode and a valid JWT is refused with 400, nothing dispatched', async () => {
    const doc = h.doc as InMemoryDoc;
    const res = await http(
      'createTask',
      JSON.stringify({ testMode: true, args: [{ title: 'x' }] }),
      'Bearer good-jwt',
    );
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatch(/direct invoke/);
    expect(doc.size).toBe(0);
  });

  it('a direct invoke with testMode runs as smoke-test and persists nothing (the CI smoke path)', async () => {
    const doc = h.doc as InMemoryDoc;
    // Exactly smoke.ts's buildEvent shape: no requestContext, no header.
    const created = await handler({
      rawPath: '/api/createTask',
      body: JSON.stringify({ testMode: true, args: [{ title: 'x' }] }),
    });
    expect(created.statusCode).toBe(200);
    expect(doc.size).toBe(0);
    const settings = await handler({
      rawPath: '/api/getSettings',
      body: JSON.stringify({ testMode: true, args: [] }),
    });
    expect(settings.statusCode).toBe(200);
    expect(JSON.parse(settings.body ?? 'null')).toMatchObject({ dayStartHour: expect.any(Number) });
  });

  it('a malformed body is a 400 Invalid JSON, not a thrown handler', async () => {
    for (const raw of ['{not json', 'null', '[]', '"x"']) {
      const res = await http('getSettings', raw, 'Bearer good-jwt');
      expect(res.statusCode).toBe(400);
      expect(errorOf(res)).toBe('Invalid JSON');
    }
  });

  it('args that are not an array are refused with 400', async () => {
    const res = await http('getSettings', JSON.stringify({ args: 'x' }), 'Bearer good-jwt');
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toBe('args must be an array');
  });

  it('logs one rpc_failed line per failed call — method, status, name — never the body, the header or the message', async () => {
    await http('getSettings', JSON.stringify({ args: [] })); // no JWT → 401
    await http('getSettings', '{not json', 'Bearer good-jwt'); // 400
    vi.spyOn(h.doc, 'get').mockRejectedValueOnce(new TypeError('secret detail'));
    await http('getSettings', JSON.stringify({ args: [] }), 'Bearer good-jwt'); // 500
    await http('x'.repeat(2000), JSON.stringify({ args: [] }), 'Bearer good-jwt'); // 404, path text
    expect(logs.map((l) => JSON.parse(l) as unknown)).toEqual([
      { event: 'rpc_failed', method: 'getSettings', status: 401, name: 'Error' },
      { event: 'rpc_failed', method: 'getSettings', status: 400, name: 'Error' },
      { event: 'rpc_failed', method: 'getSettings', status: 500, name: 'TypeError' },
      { event: 'rpc_failed', method: 'unknown', status: 404, name: 'Error' },
    ]);
    const all = logs.join('\n');
    for (const leak of ['good-jwt', '{not json', 'secret detail', 'Invalid JSON', 'xxxx'])
      expect(all).not.toContain(leak);
  });

  it('over HTTP an unknown patch key is a 400 naming it, writing nothing; a legal story patch saves', async () => {
    const jwt = 'Bearer good-jwt';
    const story = JSON.parse(
      (await http('createStory', JSON.stringify({ args: [{ title: 'mine' }] }), jwt)).body ?? '',
    ) as { id: string; title: string };
    const before = (h.doc as InMemoryDoc).snapshot();
    const bad = await http(
      'updateStory',
      JSON.stringify({ args: [story.id, { userId: 'x' }] }),
      jwt,
    );
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad)).toBe('Unknown story field: userId');
    const settings = await http(
      'updateSettings',
      JSON.stringify({ args: [{ googleAccounts: [] }] }),
      jwt,
    );
    expect(settings.statusCode).toBe(400);
    expect(errorOf(settings)).toBe('Unknown settings field: googleAccounts');
    expect((h.doc as InMemoryDoc).snapshot()).toEqual(before);
    const ok = await http(
      'updateStory',
      JSON.stringify({ args: [story.id, { title: 'renamed' }] }),
      jwt,
    );
    expect(ok.statusCode).toBe(200);
    expect((JSON.parse(ok.body ?? '') as { title: string }).title).toBe('renamed');
  });

  it('a wrongly shaped call is a 400 naming the problem, logged as a ShapeError, writing nothing', async () => {
    const jwt = 'Bearer good-jwt';
    for (const [method, args, error] of [
      ['createTask', [null], 'task must be an object'],
      ['createTask', ['x'], 'task must be an object'],
      ['createTask', [{}], 'title is required'],
      ['createTask', [{ title: 'x', userId: 'mallory' }], 'Unknown task field: userId'],
      ['getDay', ['2026-11-13', { consistent: true }], 'getDay takes at most 1 argument'],
      ['upsertSeries', [{ title: 'x', rule: 'weekly' }], 'categoryId is required'],
    ] as const) {
      const res = await http(method, JSON.stringify({ args }), jwt);
      expect(res.statusCode, `${method} ${JSON.stringify(args)}`).toBe(400);
      expect(errorOf(res)).toBe(error);
    }
    expect((h.doc as InMemoryDoc).size).toBe(0);
    expect(logs.map((l) => (JSON.parse(l) as { name: string }).name)).toEqual(
      Array(6).fill('ShapeError'),
    );
  });

  it('a body over RPC_BODY_MAX is a 413 before it is parsed', async () => {
    const pad = 'x'.repeat(RPC_BODY_MAX);
    const res = await http('getSettings', JSON.stringify({ args: [], pad }), 'Bearer good-jwt');
    expect(res.statusCode).toBe(413);
    const ok = await http('getSettings', JSON.stringify({ args: [], pad: 'x' }), 'Bearer good-jwt');
    expect(ok.statusCode).toBe(200);
  });

  it('a throttle or an AWS refusal on rpc is a 500 with the fixed body, never its text', async () => {
    const call = () => http('getSettings', JSON.stringify({ args: [] }), 'Bearer good-jwt');
    const throttle = Object.assign(new Error('arn:aws:dynamodb:table/secret slow down'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    const refused = Object.assign(new Error('arn:aws:dynamodb:table/secret bad item'), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400 },
    });
    for (const e of [throttle, refused]) {
      vi.spyOn(h.doc, 'get').mockRejectedValueOnce(e);
      const res = await call();
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('arn:aws');
      expect(errorOf(res)).toBe('Internal error');
    }
  });

  it('a fault inside dispatch is a 500 with a fixed body; a refusal keeps its message at 400', async () => {
    const call = () => http('getSettings', JSON.stringify({ args: [] }), 'Bearer good-jwt');
    vi.spyOn(h.doc, 'get').mockRejectedValueOnce(new TypeError('secret detail'));
    let res = await call();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret detail');
    expect(errorOf(res)).toBe('Internal error');

    const aws5xx = Object.assign(new Error('ServiceUnavailable'), {
      name: 'ServiceUnavailable',
      $metadata: { httpStatusCode: 503 },
    });
    vi.spyOn(h.doc, 'get').mockRejectedValueOnce(aws5xx);
    res = await call();
    expect(res.statusCode).toBe(500);

    vi.spyOn(h.doc, 'get').mockRejectedValueOnce(new Error('Not found: x'));
    res = await call();
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toBe('Not found: x');

    // A custom subclass (ConflictError and kin) is a refusal the app shows, not a fault.
    class ConflictError extends Error {
      name = 'ConflictError';
    }
    vi.spyOn(h.doc, 'get').mockRejectedValueOnce(new ConflictError('Conflict — try again'));
    res = await call();
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toBe('Conflict — try again');
  });
});
