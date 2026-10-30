import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from './api';
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
      'getTask',
      'listBacklog',
      'listCategories',
      'listTasks',
    ]);
    expect(Object.keys(api.writes).sort()).toEqual(['createTask', 'deleteTask']);
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
