import { describe, expect, it, vi } from 'vitest';
import {
  CATEGORY_VIA,
  FINANCE_BUCKET_VIA,
  FINANCE_LINK_VIA,
  FINANCE_RULE_VIA,
  MCP_CATEGORY_VIA,
  PLACE_TOKEN_VIA,
  HABIT_VIA,
  PLACE_VIA,
  MCP_SERIES_VIA,
  PUSH_SUB_VIA,
  REMINDER_TOGGLES_VIA,
  SERIES_VIA,
  UI_CATEGORY_VIA,
  UI_PLACE_VIA,
  UI_PUSH_SUB_VIA,
  UI_SERIES_VIA,
  harnessPushId,
  isHarnessPushId,
  createApiClient,
  financeRowOf,
  isGone,
  ledgerKind,
  type FetchLike,
} from './api';
import { DEV_ORIGIN } from './config';
import type { Ledger, LedgerEntry } from './ledger';

function memLedger(): Ledger & { entries: Omit<LedgerEntry, 't'>[] } {
  const entries: Omit<LedgerEntry, 't'>[] = [];
  return {
    entries,
    append: (x) => void entries.push(x),
    read: () => entries.map((x) => ({ t: '', ...x })),
    has: (id) => entries.some((x) => x.op === 'created' && x.id === id),
  };
}

const reply = (status: number, body: unknown) => ({
  status,
  text: async () => JSON.stringify(body),
});

describe('createApiClient', () => {
  it('posts {args} to the dev origin with the bearer token in the BFF header', async () => {
    const fetch = vi.fn<FetchLike>(async () => reply(200, []));
    const api = createApiClient({ fetch, token: () => 'tok', ledger: memLedger(), run: 'r1' });
    await api.reads.getTask('t1');
    expect(fetch).toHaveBeenCalledWith(`${DEV_ORIGIN}/api/getTask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aperture-authorization': 'Bearer tok' },
      body: '{"args":["t1"]}',
    });
  });

  it('awaits fresh before reading the bearer, once a request however often it retries', async () => {
    let tok = 'a';
    const fresh = vi.fn(async () => {
      tok = 'b';
    });
    let n = 0;
    const fetch = vi.fn<FetchLike>(async () => (++n < 2 ? reply(429, {}) : reply(200, null)));
    const api = createApiClient({
      fetch,
      token: () => tok,
      fresh,
      ledger: memLedger(),
      run: 'r1',
      sleep: async () => undefined,
    });
    await api.reads.getTask('t1');
    expect(fetch.mock.calls.map((c) => c[1].headers['x-aperture-authorization'])).toEqual([
      'Bearer b',
      'Bearer b',
    ]);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('exposes exactly the declared reads and writes', () => {
    const api = createApiClient({
      fetch: vi.fn(),
      token: () => '',
      ledger: memLedger(),
      run: 'r1',
    });
    expect(Object.keys(api.reads).sort()).toEqual([
      'draftSittingReview',
      'getAttachmentDownloadUrl',
      'getCalibration',
      'getDay',
      'getFinanceTransaction',
      'getFluxSet',
      'getFluxWeekNote',
      'getPlaceTokenStatus',
      'getPushStatus',
      'getSettings',
      'getSitting',
      'getTask',
      'legacyWrite',
      'listAttachments',
      'listBacklog',
      'listCategories',
      'listFinanceRules',
      'listFinanceTransactions',
      'listFluxSets',
      'listHabitChecks',
      'listHabits',
      'listPlaceTasks',
      'listPlaces',
      'listPlansForDay',
      'listRolls',
      'listRunningSessions',
      'listSeries',
      'listSessionsForDay',
      'listSittingReplay',
      'listSittings',
      'listTasks',
      'placeDigestRaw',
      'probePresigned',
    ]);
    expect(Object.keys(api.writes).sort()).toEqual([
      'archiveHabit',
      'archiveRoll',
      'checkHabit',
      'createAttachment',
      'createSeries',
      'createTask',
      'deleteAttachment',
      'deleteCategory',
      'deleteFinanceRule',
      'deleteFluxSet',
      'deletePlace',
      'deleteSeries',
      'deleteSitting',
      'deleteTask',
      'finishTask',
      'lcSittingEvents',
      'lcSittingEventsToUnknown',
      'lcSittingStart',
      'linkLeetcodeRoll',
      'recordFinanceBucket',
      'recordFinanceLink',
      'recordFluxSet',
      'recordPlaceTokenMint',
      'recordReminderToggles',
      'removeHarnessStray',
      'removePlan',
      'removeSitting',
      'restoreReminderToggles',
      'revokePlaceToken',
      'rotatePlaceToken',
      'sendTestPush',
      'setCategoryArea',
      'setDayCapacity',
      'setDayIntent',
      'setReminderSettings',
      'setRollActive',
      'setSittingPrepTarget',
      'setSittingReview',
      'setSittingReviewToUnknown',
      'setTaskActual',
      'setTaskDue',
      'setTaskEstimate',
      'startSession',
      'stopSession',
      'subscribeHarnessPush',
      'subscribePush',
      'subscribePushExpectingRefusal',
      'transitionTask',
      'uncheckHabit',
      'unlinkFinanceRefund',
      'unsetFinanceBucket',
      'unsubscribePush',
      'updateSettings',
      'upsertCategory',
      'upsertFinanceRule',
      'upsertHabit',
      'upsertPlace',
      'upsertPlan',
      'upsertRoll',
    ]);
  });

  it('records a Flux set as created before the call, and deletes only a recorded Flux set', async () => {
    const fetch = vi.fn<FetchLike>(async () => reply(200, { id: 'F1' }));
    const ledger = memLedger();
    const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
    await api.writes.recordFluxSet({
      id: 'F1',
      day: '2026-10-21',
      exerciseId: 'chin-tuck',
      kind: 'holdAtTarget',
      side: null,
      condition: null,
      count: 10,
      avgPeakDeg: null,
      avgErrorDeg: null,
      rom: { pitch: 1, yaw: 1, roll: 1 },
      calibrated: true,
      delegate: 'CPU',
      durationSec: 60,
      completedAt: 1,
      repTaskId: null,
      stoppedEarly: false,
      planned: 10,
    });
    expect(ledger.entries).toEqual([
      { run: 'r1', op: 'created', id: 'F1', via: 'api:recordFluxSet', title: 'flux chin-tuck' },
    ]);
    await expect(api.writes.deleteFluxSet('not-mine')).rejects.toThrow(/LEDGER_GUARD/);
    await expect(api.writes.deleteTask('F1')).rejects.toThrow(/LEDGER_GUARD/); // a set isn't a task
    await api.writes.deleteFluxSet('F1');
    expect(fetch).toHaveBeenLastCalledWith(
      `${DEV_ORIGIN}/api/deleteFluxSet`,
      expect.objectContaining({ body: '{"args":["F1"]}' }),
    );
  });

  it('records intent before the create and created after, with the server id', async () => {
    const ledger = memLedger();
    const fetch = vi.fn<FetchLike>(async () => {
      expect(ledger.entries.map((x) => x.op)).toEqual(['intent']); // intent is durable before the request
      return reply(200, { id: 'srv-1', title: 'x' });
    });
    const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
    await api.writes.createTask({ title: 'x' });
    expect(ledger.entries).toEqual([
      { run: 'r1', op: 'intent', via: 'api:createTask', title: 'x' },
      { run: 'r1', op: 'created', id: 'srv-1', via: 'api:createTask', title: 'x' },
    ]);
  });

  it('refuses to delete an id the ledger never recorded — without a request', async () => {
    const fetch = vi.fn<FetchLike>();
    const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
    await expect(api.writes.deleteTask('someone-elses')).rejects.toThrow(/LEDGER_GUARD/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses setTaskActual on an id the ledger never recorded — without a request', async () => {
    const fetch = vi.fn<FetchLike>();
    const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
    await expect(api.writes.setTaskActual('someone-elses', 10, 'x')).rejects.toThrow(
      /LEDGER_GUARD/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses setTaskEstimate on an id the ledger never recorded — without a request', async () => {
    const fetch = vi.fn<FetchLike>();
    const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
    await expect(api.writes.setTaskEstimate('someone-elses', null, null)).rejects.toThrow(
      /LEDGER_GUARD/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('deletes a recorded id', async () => {
    const ledger = memLedger();
    ledger.append({ run: 'r0', op: 'created', id: 'mine' });
    const fetch = vi.fn<FetchLike>(async () => reply(200, null));
    await createApiClient({ fetch, token: () => 't', ledger, run: 'r1' }).writes.deleteTask('mine');
    expect(fetch).toHaveBeenCalledWith(
      `${DEV_ORIGIN}/api/deleteTask`,
      expect.objectContaining({ body: '{"args":["mine"]}' }),
    );
  });

  describe('attachments', () => {
    const PUT_URL =
      'https://aperturedata-dev-files8e6940b8-abc.s3.us-west-1.amazonaws.com/u/s/T1/A1?X-Amz-Signature=x';
    const ATT = {
      id: 'A1',
      taskId: 'T1',
      s3Key: 'u/s/T1/A1',
      contentType: 'text/plain',
      status: 'pending',
    };
    const mine = () => {
      const ledger = memLedger();
      ledger.append({ run: 'r0', op: 'created', id: 'T1' });
      return ledger;
    };
    const s3Fake = (uploadUrl = PUT_URL) =>
      vi.fn<FetchLike>(async (url) => {
        if (url.endsWith('/api/createAttachmentUploadUrl'))
          return reply(200, { attachment: ATT, uploadUrl });
        if (url.endsWith('/api/confirmAttachment')) return reply(200, { ...ATT, status: 'ready' });
        return reply(200, null);
      });

    it('mints, PUTs the bytes to the presigned URL with the signed type, then confirms', async () => {
      const fetch = s3Fake();
      const api = createApiClient({ fetch, token: () => 't', ledger: mine(), run: 'r1' });
      const a = await api.writes.createAttachment('T1', {
        filename: 'a.txt',
        contentType: 'text/plain',
        text: 'hello',
      });
      expect(a.status).toBe('ready');
      const [mint, put, confirm] = fetch.mock.calls;
      expect(JSON.parse(mint![1].body as string).args[0]).toEqual({
        taskId: 'T1',
        filename: 'a.txt',
        contentType: 'text/plain',
        size: 5,
      });
      expect(put![0]).toBe(PUT_URL);
      expect(put![1]).toMatchObject({
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        redirect: 'error',
      });
      expect(new TextDecoder().decode(put![1].body as Uint8Array)).toBe('hello');
      expect(confirm![0]).toBe(`${DEV_ORIGIN}/api/confirmAttachment`);
    });

    it('leaves an upload pending when asked (no confirm)', async () => {
      const fetch = s3Fake();
      const api = createApiClient({ fetch, token: () => 't', ledger: mine(), run: 'r1' });
      const a = await api.writes.createAttachment('T1', {
        filename: 'c.txt',
        contentType: 'text/plain',
        text: 'c',
        confirm: false,
      });
      expect(a.status).toBe('pending');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('refuses an unledgered task, and an upload URL off the dev Files bucket, before any PUT', async () => {
      const fetch = s3Fake(
        'https://aperturedata-prod-files1-abc.s3.us-west-1.amazonaws.com/u/x?X-Amz-Signature=x',
      );
      const api = createApiClient({ fetch, token: () => 't', ledger: mine(), run: 'r1' });
      const file = { filename: 'a.txt', contentType: 'text/plain', text: 'a' };
      await expect(api.writes.createAttachment('not-mine', file)).rejects.toThrow(/LEDGER_GUARD/);
      expect(fetch).not.toHaveBeenCalled();
      await expect(api.writes.createAttachment('T1', file)).rejects.toThrow(/dev Files bucket/);
      expect(fetch).toHaveBeenCalledTimes(1); // the mint only
    });

    it('deletes only an attachment this client created, on a ledgered task', async () => {
      const fetch = s3Fake();
      const api = createApiClient({ fetch, token: () => 't', ledger: mine(), run: 'r1' });
      await expect(api.writes.deleteAttachment('T1', 'A1')).rejects.toThrow(/LEDGER_GUARD/);
      await api.writes.createAttachment('T1', {
        filename: 'a',
        contentType: 'text/plain',
        text: 'a',
      });
      await expect(api.writes.deleteAttachment('other', 'A1')).rejects.toThrow(/LEDGER_GUARD/);
      await api.writes.deleteAttachment('T1', 'A1');
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/deleteAttachment`,
        expect.objectContaining({ body: '{"args":["A1"]}' }),
      );
    });

    it('probes a presigned URL with a bodiless GET and returns only the status', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(404, 'NoSuchKey'));
      const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
      expect(await api.reads.probePresigned(PUT_URL)).toBe(404);
      expect(fetch).toHaveBeenCalledWith(PUT_URL, {
        method: 'GET',
        headers: {},
        redirect: 'error',
      });
      await expect(api.reads.probePresigned(`${DEV_ORIGIN}/u/x`)).rejects.toThrow(/refusing/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('a deleted object is gone at 403 (no ListBucket, so S3 hides NoSuchKey) or 404', () => {
      expect([403, 404, 200, 500].map(isGone)).toEqual([true, true, false, false]);
    });
  });

  describe('places', () => {
    const SECRET = `apl_${'x'.repeat(43)}`;

    it('names each ledger id’s kind by the via it was created with', () => {
      const entries = [
        { run: 'r', op: 'created' as const, id: 'T', via: 'ui:createTask' },
        { run: 'r', op: 'created' as const, id: 'F', via: 'api:recordFluxSet' },
        { run: 'r', op: 'created' as const, id: 'P', via: PLACE_VIA },
        { run: 'r', op: 'created' as const, id: 'Q', via: UI_PLACE_VIA },
        { run: 'r', op: 'created' as const, id: 'place-token:r', via: PLACE_TOKEN_VIA },
        { run: 'r', op: 'created' as const, id: 'finance-bucket:r:tx1', via: FINANCE_BUCKET_VIA },
        { run: 'r', op: 'created' as const, id: 'finance-link:r:tx2', via: FINANCE_LINK_VIA },
        { run: 'r', op: 'created' as const, id: 'R', via: FINANCE_RULE_VIA },
        { run: 'r', op: 'created' as const, id: 'C', via: CATEGORY_VIA },
        { run: 'r', op: 'created' as const, id: 'S', via: SERIES_VIA },
        { run: 'r', op: 'created' as const, id: 'S2', via: UI_SERIES_VIA },
        { run: 'r', op: 'created' as const, id: 'S3', via: MCP_SERIES_VIA },
        { run: 'r', op: 'created' as const, id: 'H', via: HABIT_VIA },
        { run: 'r', op: 'created' as const, id: 'C2', via: UI_CATEGORY_VIA },
        { run: 'r', op: 'created' as const, id: 'C3', via: MCP_CATEGORY_VIA },
      ].map((e) => ({ t: '', ...e }));
      expect(
        [
          'T',
          'F',
          'P',
          'Q',
          'place-token:r',
          'finance-bucket:r:tx1',
          'finance-link:r:tx2',
          'R',
          'C',
          'S',
          'S2',
          'S3',
          'H',
          'C2',
          'C3',
          'never',
        ].map((id) => ledgerKind(entries, id)),
      ).toEqual([
        'task',
        'flux',
        'place',
        'place',
        'placeToken',
        'financeBucket',
        'financeLink',
        'financeRule',
        'category',
        'series',
        'series',
        'series',
        'habit',
        'category',
        'category',
        'task',
      ]);
    });

    it('GETs the Shortcut route on the dev origin with the place token, never the session token', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(200, { count: 0 }));
      const api = createApiClient({ fetch, token: () => 'jwt', ledger: memLedger(), run: 'r1' });
      expect(await api.reads.placeDigestRaw('safeway', SECRET)).toEqual({
        status: 200,
        body: { count: 0 },
      });
      expect(fetch).toHaveBeenLastCalledWith(`${DEV_ORIGIN}/api/places/safeway/tasks`, {
        method: 'GET',
        headers: { 'x-aperture-authorization': `Bearer ${SECRET}` },
        redirect: 'error',
      });
      await api.reads.placeDigestRaw('safeway', null, 'POST');
      expect(fetch).toHaveBeenLastCalledWith(`${DEV_ORIGIN}/api/places/safeway/tasks`, {
        method: 'POST',
        headers: {},
        redirect: 'error',
      });
    });

    it('returns a refusal as its status and body; a slug is kept inside the path', async () => {
      const refusal = { error: 'No place "x"', text: 'No place "x"' };
      const fetch = vi.fn<FetchLike>(async () => reply(422, refusal));
      const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
      expect(await api.reads.placeDigestRaw('x', SECRET)).toEqual({ status: 422, body: refusal });
      await api.reads.placeDigestRaw('../../listTasks', SECRET);
      expect(fetch.mock.calls.at(-1)![0]).toBe(
        `${DEV_ORIGIN}/api/places/..%2F..%2FlistTasks/tasks`,
      );
    });

    it('returns the BFF’s own 429 (the daily cap) at once, but backs off a Lambda throttle', async () => {
      const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
      const cap = vi.fn<FetchLike>(async () => reply(429, { error: 'Daily read cap reached' }));
      const capped = createApiClient({
        fetch: cap,
        token: () => 't',
        ledger: memLedger(),
        run: 'r1',
        sleep,
      });
      expect((await capped.reads.placeDigestRaw('s', SECRET)).status).toBe(429);
      expect(cap).toHaveBeenCalledTimes(1);
      expect(capped.throttles()).toBe(0); // the BFF's own cap isn't a Lambda throttle
      let n = 0;
      const throttled = vi.fn<FetchLike>(async () =>
        ++n < 2 ? reply(429, { Message: 'Rate Exceeded.' }) : reply(200, { count: 1 }),
      );
      const api = createApiClient({
        fetch: throttled,
        token: () => 't',
        ledger: memLedger(),
        run: 'r1',
        sleep,
      });
      expect(await api.reads.placeDigestRaw('s', SECRET)).toEqual({
        status: 200,
        body: { count: 1 },
      });
      expect(throttled).toHaveBeenCalledTimes(2);
      expect(api.throttles()).toBe(1);
    });

    it('ledgers a place create (intent, then the server id); an edit or delete must name a recorded place', async () => {
      const ledger = memLedger();
      const fetch = vi.fn<FetchLike>(async () =>
        reply(200, { id: 'P1', name: 'Shop', slug: 'shop', lastReadAt: null }),
      );
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      await api.writes.upsertPlace({ name: 'Shop' });
      expect(ledger.entries).toEqual([
        { run: 'r1', op: 'intent', via: PLACE_VIA, title: 'Shop' },
        { run: 'r1', op: 'created', id: 'P1', via: PLACE_VIA, title: 'Shop' },
      ]);
      ledger.append({ run: 'r0', op: 'created', id: 'T1', via: 'api:createTask' });
      fetch.mockClear();
      await expect(api.writes.upsertPlace({ id: 'theirs', name: 'X' })).rejects.toThrow(
        /LEDGER_GUARD/,
      );
      await expect(api.writes.deletePlace('theirs', null)).rejects.toThrow(/LEDGER_GUARD/);
      await expect(api.writes.deletePlace('T1', null)).rejects.toThrow(/LEDGER_GUARD/); // a task isn't a place
      await expect(api.writes.deleteTask('P1')).rejects.toThrow(/LEDGER_GUARD/); // nor a place a task
      expect(fetch).not.toHaveBeenCalled();
      await api.writes.deletePlace('P1', null);
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/deletePlace`,
        expect.objectContaining({ body: '{"args":["P1",null]}' }),
      );
    });

    it('records the token as place-token:<run> before the rotate, once a run, and never its plaintext', async () => {
      const ledger = memLedger();
      const fetch = vi.fn<FetchLike>(async () => {
        expect(ledger.entries.map((x) => x.op)).toEqual(['created']); // durable before the request
        return reply(200, { token: SECRET, status: { active: true, hint: 'xxxx' } });
      });
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      expect((await api.writes.rotatePlaceToken()).token).toBe(SECRET);
      await api.writes.rotatePlaceToken();
      expect(ledger.entries).toEqual([
        {
          run: 'r1',
          op: 'created',
          id: 'place-token:r1',
          via: PLACE_TOKEN_VIA,
          title: 'place token',
        },
      ]);
      expect(JSON.stringify(ledger.entries)).not.toContain(SECRET);
    });

    it('records a browser mint (Settings’ Generate / Rotate) under the same id, with no request', async () => {
      const ledger = memLedger();
      const fetch = vi.fn<FetchLike>(async () => reply(200, { token: SECRET, status: {} }));
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      api.writes.recordPlaceTokenMint();
      expect(fetch).not.toHaveBeenCalled();
      await api.writes.rotatePlaceToken();
      api.writes.recordPlaceTokenMint();
      expect(ledger.entries).toEqual([
        {
          run: 'r1',
          op: 'created',
          id: 'place-token:r1',
          via: PLACE_TOKEN_VIA,
          title: 'place token',
        },
      ]);
      await api.writes.revokePlaceToken(); // the recorded mint is what lets cleanup revoke it
    });

    it('revokes only while a run’s minted token is unresolved in the ledger', async () => {
      const ledger = memLedger();
      const fetch = vi.fn<FetchLike>(async () => reply(200, null));
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      await expect(api.writes.revokePlaceToken()).rejects.toThrow(/LEDGER_GUARD/);
      ledger.append({ run: 'r0', op: 'created', id: 'place-token:r0', via: PLACE_TOKEN_VIA });
      ledger.append({ run: 'r0', op: 'deleted', id: 'place-token:r0' });
      await expect(api.writes.revokePlaceToken()).rejects.toThrow(/LEDGER_GUARD/);
      expect(fetch).not.toHaveBeenCalled();
      ledger.append({ run: 'r2', op: 'created', id: 'place-token:r2', via: PLACE_TOKEN_VIA });
      await api.writes.revokePlaceToken();
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/revokePlaceToken`,
        expect.objectContaining({ body: '{"args":[]}' }),
      );
    });
  });

  it('retries a Lambda throttle (429), which never ran the call, then succeeds', async () => {
    let n = 0;
    const fetch = vi.fn<FetchLike>(async () =>
      ++n < 3 ? reply(429, { Reason: 'ConcurrentInvocationLimitExceeded' }) : reply(200, []),
    );
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1', sleep });
    expect(await api.reads.listTasks()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it('gives up after five throttle retries with the 429 in the error', async () => {
    const fetch = vi.fn<FetchLike>(async () => reply(429, { message: 'Rate Exceeded.' }));
    const api = createApiClient({
      fetch,
      token: () => 't',
      ledger: memLedger(),
      run: 'r1',
      sleep: async () => undefined,
    });
    await expect(api.reads.listTasks()).rejects.toThrow(/HTTP 429.*Rate Exceeded/);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('probes the removed legacy write with no input, as the JWT or a bogus device token, and returns the raw answer', async () => {
    const fetch = vi.fn<FetchLike>(async () => ({
      status: 200,
      text: async () => '<!doctype html>',
    }));
    const api = createApiClient({ fetch, token: () => 'tok', ledger: memLedger(), run: 'r1' });
    expect(await api.reads.legacyWrite('jwt')).toEqual({ status: 200, text: '<!doctype html>' });
    await api.reads.legacyWrite('bogus-device');
    const sent = fetch.mock.calls.map(([url, init]) => [url, init.headers, init.body]);
    expect(sent).toEqual([
      [
        `${DEV_ORIGIN}/api/recordLeetcodeAttempt`,
        { 'content-type': 'application/json', 'x-aperture-authorization': 'Bearer tok' },
        '{"args":[]}',
      ],
      [
        `${DEV_ORIGIN}/api/recordLeetcodeAttempt`,
        {
          'content-type': 'application/json',
          'x-aperture-authorization': 'Bearer devcheck-not-a-device-token',
        },
        '{"args":[]}',
      ],
    ]);
  });

  it('throws on a non-200 with the status and body', async () => {
    const fetch = vi.fn<FetchLike>(async () => reply(401, { error: 'Unauthorized' }));
    const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
    await expect(api.reads.listTasks()).rejects.toThrow(/listTasks → HTTP 401.*Unauthorized/);
  });

  describe('finance (the fixture bank’s rows)', () => {
    it('records a bucket set / a link as finance-<kind>:<run>:<row> once a run, with no request', () => {
      const ledger = memLedger();
      const fetch = vi.fn<FetchLike>();
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      api.writes.recordFinanceBucket('tx1');
      api.writes.recordFinanceBucket('tx1');
      api.writes.recordFinanceLink('tx1');
      expect(fetch).not.toHaveBeenCalled();
      expect(ledger.entries).toEqual([
        {
          run: 'r1',
          op: 'created',
          id: 'finance-bucket:r1:tx1',
          via: FINANCE_BUCKET_VIA,
          title: 'bucket on tx1',
        },
        {
          run: 'r1',
          op: 'created',
          id: 'finance-link:r1:tx1',
          via: FINANCE_LINK_VIA,
          title: 'link on tx1',
        },
      ]);
      expect(financeRowOf('finance-bucket:r1:tx1')).toBe('tx1');
      expect(financeRowOf('finance-link:r1:01HZZ')).toBe('01HZZ');
    });

    it('clears only a recorded bucket / link, by the row the id names, through the row’s own method', async () => {
      const ledger = memLedger();
      const fetch = vi.fn<FetchLike>(async () => reply(200, []));
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      await expect(api.writes.unsetFinanceBucket('finance-bucket:r1:tx1')).rejects.toThrow(
        /LEDGER_GUARD/,
      );
      await expect(api.writes.unlinkFinanceRefund('finance-link:r1:tx1')).rejects.toThrow(
        /LEDGER_GUARD/,
      );
      api.writes.recordFinanceBucket('tx1');
      api.writes.recordFinanceLink('tx2');
      await expect(api.writes.unsetFinanceBucket('finance-link:r1:tx2')).rejects.toThrow(
        /LEDGER_GUARD/,
      ); // a link isn't a bucket
      await expect(api.writes.deleteTask('finance-bucket:r1:tx1')).rejects.toThrow(/LEDGER_GUARD/); // nor a task
      expect(fetch).not.toHaveBeenCalled();
      await api.writes.unsetFinanceBucket('finance-bucket:r1:tx1');
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/setFinanceBucket`,
        expect.objectContaining({ body: '{"args":[{"ids":["tx1"],"bucket":null}]}' }),
      );
      await api.writes.unlinkFinanceRefund('finance-link:r1:tx2');
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/linkFinanceRefund`,
        expect.objectContaining({ body: '{"args":["tx2",null]}' }),
      );
    });

    it('records a rule from the create response, and deletes only a recorded rule', async () => {
      const ledger = memLedger();
      const fetch = vi.fn<FetchLike>(async () =>
        reply(200, { id: 'R1', pattern: 'devcheck', bucket: 'budget' }),
      );
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      await expect(api.writes.deleteFinanceRule('R0')).rejects.toThrow(/LEDGER_GUARD/);
      const rule = await api.writes.upsertFinanceRule({ pattern: 'devcheck', bucket: 'budget' });
      expect(rule.id).toBe('R1');
      expect(ledger.entries).toEqual([
        { run: 'r1', op: 'intent', via: FINANCE_RULE_VIA, title: 'devcheck' },
        { run: 'r1', op: 'created', id: 'R1', via: FINANCE_RULE_VIA, title: 'devcheck' },
      ]);
      await api.writes.deleteFinanceRule('R1');
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/deleteFinanceRule`,
        expect.objectContaining({ body: '{"args":["R1"]}' }),
      );
    });

    it('reads one row back from the whole range, null when gone', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(200, [{ id: 'tx1', bucket: 'budget' }]));
      const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
      expect((await api.reads.getFinanceTransaction('tx1'))?.bucket).toBe('budget');
      expect(await api.reads.getFinanceTransaction('tx9')).toBeNull();
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/listFinanceTransactions`,
        expect.objectContaining({ body: '{"args":[{"from":"2000-01-01","to":"2100-01-01"}]}' }),
      );
    });
  });

  describe('reminders', () => {
    const input = {
      endpoint: 'https://web.push.apple.com/devcheck-n1',
      keys: { p256dh: 'BPk', auth: 'au' },
      label: 'devcheck',
    };

    it('ledgers a subscribe (intent, then the server id) and removes only a device it recorded', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(200, { id: 'D1', label: 'devcheck' }));
      const ledger = memLedger();
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      expect(await api.writes.subscribePush(input)).toMatchObject({ id: 'D1' });
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/subscribePush`,
        expect.objectContaining({ body: JSON.stringify({ args: [input] }) }),
      );
      expect(ledger.entries).toEqual([
        { run: 'r1', op: 'intent', via: PUSH_SUB_VIA, title: 'devcheck' },
        { run: 'r1', op: 'created', id: 'D1', via: PUSH_SUB_VIA, title: 'devcheck' },
      ]);
      expect(ledgerKind(ledger.read(), 'D1')).toBe('pushsub');
      // The ledger never holds the endpoint or keys.
      expect(JSON.stringify(ledger.entries)).not.toMatch(/devcheck-n1|BPk|"au"/);
      await api.writes.unsubscribePush('D1');
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/unsubscribePush`,
        expect.objectContaining({ body: '{"args":["D1"]}' }),
      );
      await expect(api.writes.unsubscribePush('D9')).rejects.toThrow(
        /never recorded it as a pushsub/,
      );
      ledger.append({ run: 'r1', op: 'created', id: 'T1', via: 'api:createTask' });
      await expect(api.writes.unsubscribePush('T1')).rejects.toThrow(
        /never recorded it as a pushsub/,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('reads status and queues a test through the BFF', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(200, null));
      const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
      await api.reads.getPushStatus();
      await api.writes.sendTestPush();
      expect(fetch.mock.calls.map((c) => c[0])).toEqual([
        `${DEV_ORIGIN}/api/getPushStatus`,
        `${DEV_ORIGIN}/api/sendTestPush`,
      ]);
    });

    it('a refused subscribe ledgers nothing and answers the refusal; one that lands is recorded and fails', async () => {
      const ledger = memLedger();
      const refuse = vi.fn<FetchLike>(async () => reply(400, { error: 'not a push service' }));
      const api = createApiClient({ fetch: refuse, token: () => 't', ledger, run: 'r1' });
      expect(await api.writes.subscribePushExpectingRefusal(input)).toBe('not a push service');
      expect(ledger.entries).toEqual([]);
      const accept = vi.fn<FetchLike>(async () => reply(200, { id: 'D7' }));
      const api2 = createApiClient({ fetch: accept, token: () => 't', ledger, run: 'r1' });
      await expect(api2.writes.subscribePushExpectingRefusal(input)).rejects.toThrow(
        /should have refused/,
      );
      expect(ledger.entries).toEqual([
        { run: 'r1', op: 'created', id: 'D7', via: PUSH_SUB_VIA, title: 'devcheck' },
      ]);
      // A throttle is backed off; any other failure isn't a refusal.
      const broken = vi.fn<FetchLike>(async () => reply(500, 'oops'));
      const api3 = createApiClient({
        fetch: broken,
        token: () => 't',
        ledger: memLedger(),
        run: 'r1',
      });
      await expect(api3.writes.subscribePushExpectingRefusal(input)).rejects.toThrow(/HTTP 500/);
    });

    it('names a device Enable subscribed, and the toggles a run flipped, by their via', () => {
      const entries = [
        { run: 'r', op: 'created' as const, id: 'U', via: UI_PUSH_SUB_VIA },
        { run: 'r', op: 'created' as const, id: 'reminder-toggles:r', via: REMINDER_TOGGLES_VIA },
      ].map((e) => ({ t: '', ...e }));
      expect(['U', 'reminder-toggles:r'].map((id) => ledgerKind(entries, id))).toEqual([
        'pushsub',
        'reminderToggles',
      ]);
    });

    it('removes a harness device by its fixed-slot id — recorded first — and refuses any other', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(200, null));
      const ledger = memLedger();
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      const id = harnessPushId('e2e');
      // lambdas/src/backend.push.test.ts pins the BFF's id for the same endpoint: they can't drift apart.
      expect(id).toBe('54c270db2e586463');
      await api.writes.removeHarnessStray(id, 'Devcheck A x');
      expect(ledger.entries).toEqual([
        { run: 'r1', op: 'created', id, via: PUSH_SUB_VIA, title: 'stray Devcheck A x' },
      ]);
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/unsubscribePush`,
        expect.objectContaining({ body: JSON.stringify({ args: [id] }) }),
      );
      await expect(api.writes.removeHarnessStray('0123456789abcdef', 'iPhone')).rejects.toThrow(
        /not one of the harness's fixed endpoints/,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(isHarnessPushId(harnessPushId('banner'))).toBe(true);
    });

    it('records a harness slot’s id before the subscribe, so a lost answer still leaves it to clean', async () => {
      const ledger = memLedger();
      const lost = vi.fn<FetchLike>(async () => {
        throw new Error('socket hang up');
      });
      const api = createApiClient({ fetch: lost, token: () => 't', ledger, run: 'r1' });
      const keys = { p256dh: 'BPk', auth: 'au' };
      await expect(api.writes.subscribeHarnessPush('e2e', keys, 'Devcheck A x')).rejects.toThrow();
      expect(ledger.entries).toEqual([
        {
          run: 'r1',
          op: 'created',
          id: '54c270db2e586463',
          via: PUSH_SUB_VIA,
          title: 'Devcheck A x',
        },
      ]);
      expect(ledgerKind(ledger.read(), '54c270db2e586463')).toBe('pushsub');
      // Answered: posted to the slot's endpoint, recorded once; an id the server derives otherwise fails.
      const ok = vi.fn<FetchLike>(async () => reply(200, { id: '54c270db2e586463', label: 'x' }));
      const api2 = createApiClient({ fetch: ok, token: () => 't', ledger, run: 'r1' });
      await api2.writes.subscribeHarnessPush('e2e', keys, 'Devcheck A x');
      expect(ok).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/subscribePush`,
        expect.objectContaining({
          body: JSON.stringify({
            args: [
              { endpoint: 'https://web.push.apple.com/devcheck-e2e', keys, label: 'Devcheck A x' },
            ],
          }),
        }),
      );
      expect(ledger.entries).toHaveLength(1);
      const moved = vi.fn<FetchLike>(async () => reply(200, { id: 'ffffffffffffffff' }));
      const api3 = createApiClient({ fetch: moved, token: () => 't', ledger, run: 'r1' });
      await expect(api3.writes.subscribeHarnessPush('c', keys, 'C')).rejects.toThrow(
        /derivation moved/,
      );
    });

    it('re-dates only a task this harness created', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(200, { id: 'T1', title: 'x' }));
      const ledger = memLedger();
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      await expect(api.writes.setTaskDue('T9', { dueDay: '2026-11-05' })).rejects.toThrow(
        /never recorded/,
      );
      await api.writes.createTask({ title: 'x' });
      await api.writes.setTaskDue('T1', { dueDay: '2026-11-05', dueTime: '10:00' });
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/setTaskDue`,
        expect.objectContaining({
          body: JSON.stringify({ args: ['T1', { dueDay: '2026-11-05', dueTime: '10:00' }] }),
        }),
      );
    });

    it('restoring the toggles records nothing new, and needs some run to have flipped them', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(200, {}));
      const ledger = memLedger();
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r2' });
      await expect(api.writes.restoreReminderToggles()).rejects.toThrow(/no run recorded flipping/);
      expect(fetch).not.toHaveBeenCalled();
      ledger.append({
        run: 'r1',
        op: 'created',
        id: 'reminder-toggles:r1',
        via: REMINDER_TOGGLES_VIA,
      });
      await api.writes.restoreReminderToggles(); // the sweep restoring r1's flip
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/updateSettings`,
        expect.objectContaining({
          body: JSON.stringify({
            args: [{ remindTimed: true, remindDueDay: true, remindPlanned: true }],
          }),
        }),
      );
      expect(ledger.entries.map((e) => e.id)).toEqual(['reminder-toggles:r1']); // no r2 entry
    });

    it('writes only the three reminder toggles to settings, recording the run before the first', async () => {
      const fetch = vi.fn<FetchLike>(async () => reply(200, {}));
      const ledger = memLedger();
      const api = createApiClient({ fetch, token: () => 't', ledger, run: 'r1' });
      api.writes.recordReminderToggles();
      await api.writes.setReminderSettings({ remindTimed: false, remindPlanned: true });
      expect(ledger.entries).toEqual([
        {
          run: 'r1',
          op: 'created',
          id: 'reminder-toggles:r1',
          via: REMINDER_TOGGLES_VIA,
          title: 'reminder toggles',
        },
      ]);
      expect(fetch).toHaveBeenLastCalledWith(
        `${DEV_ORIGIN}/api/updateSettings`,
        expect.objectContaining({
          body: JSON.stringify({ args: [{ remindTimed: false, remindPlanned: true }] }),
        }),
      );
      await expect(
        api.writes.setReminderSettings({ dayStartHour: 0 } as unknown as { remindTimed: boolean }),
      ).rejects.toThrow(/reminder toggles only/);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
