import { AUTH_HEADER } from '@aperture/shared';
import { describe, expect, it } from 'vitest';
import { createHttpClient } from './httpClient';
import type { FetchLike } from './httpClient';

describe('createHttpClient (RPC transport)', () => {
  it('posts positional args to /api/<method> and parses the JSON result', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 't1', title: 'x' }) };
    };
    const api = createHttpClient('https://api.test', fetchImpl);
    const task = await api.getTask('t1');

    expect(calls[0]!.url).toBe('https://api.test/api/getTask');
    expect(JSON.parse(calls[0]!.body)).toEqual({ args: ['t1'] });
    expect(task).toEqual({ id: 't1', title: 'x' });
  });

  it('passes object args through faithfully', async () => {
    let sent = '';
    const api = createHttpClient('', async (_url, init) => {
      sent = init.body;
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    });
    await api.createTask({ title: 'hi', estimateMin: 30, bufferMin: null });
    expect(JSON.parse(sent)).toEqual({ args: [{ title: 'hi', estimateMin: 30, bufferMin: null }] });
  });

  it('throws on a non-ok response', async () => {
    const api = createHttpClient('', async () => ({
      ok: false,
      status: 500,
      text: async () => '',
    }));
    await expect(api.listTasks()).rejects.toThrow(/listTasks failed \(500\)/);
  });

  it('resolves void methods (empty response body) to undefined', async () => {
    const api = createHttpClient('', async () => ({ ok: true, status: 200, text: async () => '' }));
    await expect(api.removePlan('p1')).resolves.toBeUndefined();
  });

  it('attaches a Bearer token from the provider when one is present', async () => {
    let headers: Record<string, string> = {};
    const api = createHttpClient(
      '',
      async (_url, init) => {
        headers = init.headers;
        return { ok: true, status: 200, text: async () => 'null' };
      },
      () => 'tok-123',
    );
    await api.listTasks();
    expect(headers[AUTH_HEADER]).toBe('Bearer tok-123');
    expect(headers['authorization']).toBeUndefined(); // never the reserved header (OAC uses it)
  });

  it('signals a 401 to the auth layer (so it can renew), and still throws', async () => {
    let reauths = 0;
    const api = createHttpClient(
      '',
      async () => ({ ok: false, status: 401, text: async () => '' }),
      () => 'stale-tok',
      () => void reauths++,
    );
    await expect(api.listTasks()).rejects.toThrow(/listTasks failed \(401\)/);
    expect(reauths).toBe(1);
  });

  it('leaves the auth layer alone on other failures — a 500 is not a token problem', async () => {
    let reauths = 0;
    const api = createHttpClient(
      '',
      async () => ({ ok: false, status: 500, text: async () => '' }),
      () => 'tok',
      () => void reauths++,
    );
    await expect(api.listTasks()).rejects.toThrow();
    expect(reauths).toBe(0);
  });

  it('omits Authorization when there is no token (stub/dev)', async () => {
    let headers: Record<string, string> = {};
    const api = createHttpClient(
      '',
      async (_url, init) => {
        headers = init.headers;
        return { ok: true, status: 200, text: async () => 'null' };
      },
      () => null,
    );
    await api.listTasks();
    expect(headers[AUTH_HEADER]).toBeUndefined();
  });
});
