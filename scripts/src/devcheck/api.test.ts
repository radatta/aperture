import { describe, expect, it, vi } from 'vitest';
import { createApiClient, isGone, type FetchLike } from './api';
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

  it('exposes exactly the declared reads and writes', () => {
    const api = createApiClient({
      fetch: vi.fn(),
      token: () => '',
      ledger: memLedger(),
      run: 'r1',
    });
    expect(Object.keys(api.reads).sort()).toEqual([
      'getAttachmentDownloadUrl',
      'getFluxSet',
      'getSettings',
      'getTask',
      'listAttachments',
      'listBacklog',
      'listCategories',
      'listFluxSets',
      'listTasks',
      'probePresigned',
    ]);
    expect(Object.keys(api.writes).sort()).toEqual([
      'createAttachment',
      'createTask',
      'deleteAttachment',
      'deleteFluxSet',
      'deleteTask',
      'recordFluxSet',
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

  it('throws on a non-200 with the status and body', async () => {
    const fetch = vi.fn<FetchLike>(async () => reply(401, { error: 'Unauthorized' }));
    const api = createApiClient({ fetch, token: () => 't', ledger: memLedger(), run: 'r1' });
    await expect(api.reads.listTasks()).rejects.toThrow(/listTasks → HTTP 401.*Unauthorized/);
  });
});
