import { AUTH_HEADER } from '@aperture/shared';
import { describe, expect, it, vi } from 'vitest';
import { MAX_IN_FLIGHT, SLOT_MS, createHttpClient } from './httpClient';
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

  it('drops a trailing undefined (an omitted optional), never sends it as null; an explicit null goes', async () => {
    const sent: string[] = [];
    const api = createHttpClient('', async (_url, init) => {
      sent.push(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 't1' }) };
    });
    await api.setTaskActual('t1', 30, undefined);
    await api.setTaskActual('t1', 30, null);
    await api.setTaskActual('t1', 30, 'went fine');
    expect(sent.map((b) => JSON.parse(b))).toEqual([
      { args: ['t1', 30] }, // keeps the reflection server-side
      { args: ['t1', 30, null] }, // clears it
      { args: ['t1', 30, 'went fine'] },
    ]);
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

  describe('the in-flight cap', () => {
    // A fetch the test answers by hand: which calls hit the wire, in what order, and how many at once.
    const wire = () => {
      const pending: { resolve: (status: number) => void; reject: (e: unknown) => void }[] = [];
      const started: string[] = []; // the first arg of each call, in the order it was sent
      let peak = 0;
      const fetchImpl: FetchLike = (_url, init) =>
        new Promise((resolve, reject) => {
          started.push(String((JSON.parse(init.body) as { args: unknown[] }).args[0]));
          pending.push({
            resolve: (status) => resolve({ ok: status < 400, status, text: async () => 'null' }),
            reject,
          });
          peak = Math.max(peak, pending.length);
        });
      const answer = (status = 200) => pending.shift()!.resolve(status);
      const drop = () => pending.shift()!.reject(new TypeError('Failed to fetch'));
      return { fetchImpl, pending, started, answer, drop, peak: () => peak };
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i));
    const client = (
      w: ReturnType<typeof wire>,
      sleep: (ms: number) => Promise<void> = async () => {},
    ) =>
      createHttpClient(
        '',
        w.fetchImpl,
        () => null,
        () => {},
        sleep,
      );

    it('never has more than MAX_IN_FLIGHT calls on the wire, and starts them in dispatch order', async () => {
      const w = wire();
      const api = client(w);
      const calls = ids(20).map((id) => api.getTask(id));
      await tick();
      expect(w.started).toEqual(ids(MAX_IN_FLIGHT));
      w.answer();
      await tick();
      expect(w.started).toEqual(ids(MAX_IN_FLIGHT + 1)); // the freed slot went to the next in line
      while (w.pending.length) {
        w.answer();
        await tick();
      }
      await Promise.all(calls);
      expect(w.started).toEqual(ids(20));
      expect(w.peak()).toBe(MAX_IN_FLIGHT);
    });

    it('a rejected fetch frees its slot', async () => {
      const w = wire();
      const api = client(w);
      const calls = ids(MAX_IN_FLIGHT + 1).map((id) => api.getTask(id));
      const dropped = calls[0]!.catch((e: unknown) => e); // handled now, so its rejection isn't unhandled
      await tick();
      expect(w.started).toHaveLength(MAX_IN_FLIGHT);
      w.drop();
      await tick();
      expect(w.started).toEqual(ids(MAX_IN_FLIGHT + 1));
      expect(await dropped).toBeInstanceOf(TypeError);
      while (w.pending.length) {
        w.answer();
        await tick();
      }
      await Promise.all(calls.slice(1));
    });

    it('a 429 re-enters the queue while it waits to retry', async () => {
      const w = wire();
      let wake = () => {};
      const api = client(w, () => new Promise<void>((r) => (wake = r)));
      const calls = ids(MAX_IN_FLIGHT + 1).map((id) => api.getTask(id));
      await tick();
      w.answer(429); // call 0 is throttled: it backs off holding no slot…
      await tick();
      expect(w.started).toEqual(ids(MAX_IN_FLIGHT + 1)); // …so call 8 took the slot at once
      expect(w.pending).toHaveLength(MAX_IN_FLIGHT);
      wake(); // its backoff is over: the wire is full, so it queues
      await tick();
      expect(w.started).toHaveLength(MAX_IN_FLIGHT + 1);
      w.answer(); // call 1 answers; the retry is next in line
      await tick();
      expect(w.started.at(-1)).toBe('0');
      while (w.pending.length) {
        w.answer();
        await tick();
      }
      await Promise.all(calls);
      expect(w.peak()).toBe(MAX_IN_FLIGHT);
    });

    it('a call that never answers frees its slot after SLOT_MS — the Lambda behind it has timed out', async () => {
      vi.useFakeTimers();
      try {
        const w = wire();
        const api = client(w);
        const calls = ids(MAX_IN_FLIGHT + 1).map((id) => api.getTask(id));
        await vi.advanceTimersByTimeAsync(SLOT_MS - 1);
        expect(w.started).toHaveLength(MAX_IN_FLIGHT); // eight stalled, the ninth still waiting
        await vi.advanceTimersByTimeAsync(1);
        expect(w.started).toEqual(ids(MAX_IN_FLIGHT + 1)); // the leases lapsed: the ninth is on the wire
        // The stalled calls still answer in their own time, and answering frees nothing twice.
        while (w.pending.length) {
          w.answer();
          await vi.advanceTimersByTimeAsync(0);
        }
        await Promise.all(calls);
        const late = ids(MAX_IN_FLIGHT + 2).map((id) => api.getTask(id));
        await vi.advanceTimersByTimeAsync(0);
        expect(w.started).toHaveLength(2 * MAX_IN_FLIGHT + 1); // the count is whole again: 8 go, 2 wait
        while (w.pending.length) {
          w.answer();
          await vi.advanceTimersByTimeAsync(0);
        }
        await Promise.all(late);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
