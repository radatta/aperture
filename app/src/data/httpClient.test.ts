import { AUTH_HEADER } from '@aperture/shared';
import { describe, expect, it } from 'vitest';
import { createHttpClient } from './httpClient';
import { ApiError } from './retry';
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

  it('a 400 throws the backend’s refusal, so the UI says why; anything else stays generic', async () => {
    const reply = (status: number, body: string) =>
      createHttpClient('', async () => ({ ok: false, status, text: async () => body }));
    const why = 'Part 2 isn’t finished — complete, drop or delete it first';
    await expect(
      reply(400, JSON.stringify({ error: why })).transitionTask('p', 'done'),
    ).rejects.toThrow(why);
    await expect(reply(400, 'not json').listTasks()).rejects.toThrow(/listTasks failed \(400\)/);
    await expect(reply(400, '{}').listTasks()).rejects.toThrow(/listTasks failed \(400\)/);
    await expect(
      reply(500, JSON.stringify({ error: 'internal detail' })).listTasks(),
    ).rejects.toThrow(/listTasks failed \(500\)/);
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
  it('throws an ApiError carrying the status', async () => {
    const api = createHttpClient('', async () => ({
      ok: false,
      status: 503,
      text: async () => '',
    }));
    const err = await api.listTasks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
  });

  describe('a 429 (Lambda never ran)', () => {
    const replies = (...statuses: number[]) => {
      const calls: string[] = [];
      const fetchImpl: FetchLike = async (url) => {
        calls.push(url);
        const status = statuses.shift() ?? 200;
        return { ok: status < 400, status, text: async () => 'null' };
      };
      const waits: number[] = [];
      const sleep = async (ms: number) => void waits.push(ms);
      return {
        calls,
        waits,
        api: createHttpClient(
          '',
          fetchImpl,
          () => null,
          () => {},
          sleep,
        ),
      };
    };

    it('retries a write on a 429, then succeeds', async () => {
      const { api, calls, waits } = replies(429, 429, 200);
      await api.createTask({ title: 'hi', estimateMin: 30, bufferMin: null });
      expect(calls).toHaveLength(3);
      expect(waits).toHaveLength(2);
    });

    it('gives up after two retries and throws the 429', async () => {
      const { api, calls } = replies(429, 429, 429, 200);
      const err = await api.listTasks().catch((e: unknown) => e);
      expect((err as ApiError).status).toBe(429);
      expect(calls).toHaveLength(3);
    });

    it('never retries a write on a 500 or a dropped connection — it may have landed', async () => {
      const { api, calls } = replies(500, 200);
      await expect(api.stopSession('s1', 'completed')).rejects.toThrow(/\(500\)/);
      expect(calls).toHaveLength(1);

      let sent = 0;
      const offline = createHttpClient(
        '',
        async () => {
          sent++;
          throw new TypeError('Failed to fetch');
        },
        () => null,
        () => {},
        async () => {},
      );
      await expect(offline.stopSession('s1', 'completed')).rejects.toThrow(TypeError);
      expect(sent).toBe(1);
    });
  });
});
