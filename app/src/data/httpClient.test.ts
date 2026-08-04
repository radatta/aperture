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
    const api = createHttpClient('', async () => ({ ok: false, status: 500, text: async () => '' }));
    await expect(api.listTasks()).rejects.toThrow(/listTasks failed \(500\)/);
  });

  it('resolves void methods (empty response body) to undefined', async () => {
    const api = createHttpClient('', async () => ({ ok: true, status: 200, text: async () => '' }));
    await expect(api.removePlan('p1')).resolves.toBeUndefined();
  });
});
