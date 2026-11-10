// The real background page (lib/outbox.js + background.js, as the manifest loads them) in a vm, with a fake
// extension API and a scripted fetch standing in for Aperture.
import { describe, expect, it } from 'vitest';
import {
  AUTH_HEADER,
  SITTING_ACTIVE_ERROR,
  SITTING_ENDED_ERROR,
  SITTING_PROBLEM_MAX,
  SITTING_START_TIME_ERROR,
} from '@aperture/shared';
import { background, fakeExtension, src, until } from './load';

type Call = {
  url: string;
  headers: Record<string, string>;
  body: { args: [Record<string, unknown>] };
};
function setup(script: (call: Call, n: number) => { status: number; body: unknown }) {
  const ext = fakeExtension();
  const calls: Call[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    const r = script(call, calls.length);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  background({ chrome: ext.api, fetch, Response });
  const send = (msg: object) =>
    ext.api.runtime.sendMessage(msg) as Promise<Record<string, unknown>>;
  return { ext, calls, send };
}
const events = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `E${from + i}`,
    type: 'snapshot',
    at: 1,
    payload: { code: `v${from + i}` },
  }));
const ok = { status: 200, body: { accepted: 1, duplicates: 0, version: 3, status: 'active' } };

describe('background', () => {
  // Safari builds the background page itself from manifest background.scripts, and it was seen (2026-11-10)
  // not to read them as UTF-8: the outbox's "ended" string, with its em dash, stopped matching Aperture's, and
  // every event after a Done landed as failed ("refused: see Options"). So those files stay pure ASCII, any
  // other character written as a \u escape.
  it('loads only pure-ASCII scripts in the background page, whatever encoding Safari reads them in', () => {
    const manifest = JSON.parse(src('manifest.json')) as { background: { scripts: string[] } };
    for (const f of manifest.background.scripts) {
      const bad = src(f)
        .split('\n')
        .map((line, i) => ({ line: i + 1, text: line }))
        .filter((l) => [...l.text].some((c) => c.charCodeAt(0) > 0x7f));
      expect(bad, `${f} has non-ASCII text`).toEqual([]);
    }
  });

  it('keeps its copies of the shared strings in step with packages/shared', () => {
    expect(src('src/background.js')).toContain(`const AUTH_HEADER = '${AUTH_HEADER}'`);
    expect(src('src/content.js')).toContain(`const ACTIVE_ERROR = '${SITTING_ACTIVE_ERROR}'`);
    expect(src('src/content.js')).toContain(
      `const START_TIME_ERROR = '${SITTING_START_TIME_ERROR}'`,
    );
    expect(SITTING_PROBLEM_MAX).toBe(64 * 1024);
    expect(src('src/content.js')).toContain('const PROBLEM_MAX = 64 * 1024;');
  });

  it('posts events with the device token, in order, and records the sync for the badge', async () => {
    const { ext, calls, send } = setup(() => ok);
    await ext.local.set({
      apiOrigin: 'https://aperture.test/',
      deviceToken: 'test-token-not-a-secret',
    });
    // The content script counts a hand-off as landed only on exactly this reply.
    expect(
      await send({ type: 'enqueue', sittingId: 'SIT', slug: 'two-sum', events: events(60) }),
    ).toEqual({ ok: true });
    await until(() => calls.length === 2);
    expect(calls[0]!.url).toBe('https://aperture.test/api/lcSittingEvents');
    expect(calls[0]!.headers[AUTH_HEADER]).toBe('Bearer test-token-not-a-secret');
    expect(calls.map((c) => (c.body.args[0].events as unknown[]).length)).toEqual([50, 10]);
    expect(calls[0]!.body.args[0].sittingId).toBe('SIT');
    const sync = await until(() => ext.local.data['sync:two-sum'] as Record<string, unknown>);
    expect(sync).toMatchObject({ sittingId: 'SIT', status: 'active', version: 3, http: 200 });
    await until(() => (ext.local.data.outbox as { entries: unknown[] }).entries.length === 0);
  });

  it('retries a 5xx in order, pauses on a 401 until the token changes, and keeps a 400 as failed', async () => {
    let mode: 'down' | 'auth' | 'refuse' = 'down';
    const { ext, calls, send } = setup((call) =>
      mode === 'down'
        ? { status: 503, body: { error: 'busy' } }
        : mode === 'auth'
          ? { status: 401, body: { error: 'Unauthorized' } }
          : mode === 'refuse' && (call.body.args[0].events as Array<{ id: string }>)[0]!.id === 'E0'
            ? { status: 400, body: { error: 'A snapshot needs its code' } }
            : ok,
    );
    await ext.local.set({ apiOrigin: 'https://aperture.test', deviceToken: 't' });
    await send({ type: 'enqueue', sittingId: 'SIT', slug: 'two-sum', events: events(1) });
    await send({ type: 'enqueue', sittingId: 'SIT', slug: 'two-sum', events: events(1, 1) });
    await until(() => calls.length === 1);
    await until(() => ext.alarms.some((a) => a.name === 'outbox')); // re-armed for when the page is unloaded
    expect((ext.local.data.status as Record<string, unknown>).state).toBe('retrying');

    mode = 'auth';
    await send({ type: 'retry-now' });
    await until(() => (ext.local.data.outbox as { paused: string }).paused === 'auth');
    expect(calls.map((c) => (c.body.args[0].events as Array<{ id: string }>)[0]!.id)).toEqual([
      'E0',
      'E0',
    ]);

    mode = 'refuse';
    await ext.local.set({ deviceToken: 't2' });
    await send({ type: 'config-changed' });
    // E0 is refused and kept as failed; the one behind it still goes.
    await until(
      () =>
        calls.length === 4 &&
        (ext.local.data.outbox as { entries: unknown[] }).entries.length === 1,
    );
    expect((calls[3]!.body.args[0].events as Array<{ id: string }>)[0]!.id).toBe('E1');
    const failed = (ext.local.data.outbox as { entries: Array<Record<string, unknown>> })
      .entries[0]!;
    expect(failed).toMatchObject({
      state: 'failed',
      lastStatus: 400,
      lastError: 'A snapshot needs its code',
    });
    await send({ type: 'clear-failed' });
    await until(() => (ext.local.data.outbox as { entries: unknown[] }).entries.length === 0);
  });

  it('marks the sitting ended when Aperture says so, and drops what it refused', async () => {
    const { ext, send } = setup(() => ({ status: 400, body: { error: SITTING_ENDED_ERROR } }));
    await ext.local.set({ apiOrigin: 'https://aperture.test', deviceToken: 't' });
    await send({ type: 'enqueue', sittingId: 'SIT', slug: 'two-sum', events: events(1) });
    const sync = await until(() => ext.local.data['sync:two-sum'] as Record<string, unknown>);
    expect(sync).toMatchObject({ status: 'ended', http: 400 });
    await until(() => (ext.local.data.outbox as { entries: unknown[] }).entries.length === 0);
    expect((ext.local.data.status as Record<string, unknown>).failed).toBe(0);
  });

  // Inside the server's ten-minute grace after Done, a late batch answers 200 with the ended status (its after-Done
  // events skipped): that reply, not the 400, is how the badge learns the end then.
  it('marks the sitting ended from a 200 reply whose status says so, and counts the batch sent', async () => {
    const { ext, send } = setup(() => ({
      status: 200,
      body: { accepted: 0, duplicates: 0, skipped: 1, version: 3, status: 'done' },
    }));
    await ext.local.set({ apiOrigin: 'https://aperture.test', deviceToken: 't' });
    await send({ type: 'enqueue', sittingId: 'SIT', slug: 'two-sum', events: events(1) });
    const sync = await until(() => {
      const s = ext.local.data['sync:two-sum'] as Record<string, unknown> | undefined;
      return s?.status === 'done' ? s : undefined;
    });
    expect(sync).toMatchObject({ status: 'done', http: 200 });
    await until(() => (ext.local.data.outbox as { entries: unknown[] }).entries.length === 0);
    expect((ext.local.data.status as Record<string, unknown>).failed).toBe(0);
  });

  it('never counts a 200 that isn’t Aperture’s answer as sent (CloudFront’s index.html for an /api 404)', async () => {
    const ext = fakeExtension();
    const fetch = async () => new Response('<!doctype html><html></html>', { status: 200 });
    background({ chrome: ext.api, fetch, Response });
    await ext.local.set({ apiOrigin: 'https://aperture.test', deviceToken: 't' });
    await ext.api.runtime.sendMessage({
      type: 'enqueue',
      sittingId: 'SIT',
      slug: 'two-sum',
      events: events(1),
    });
    await until(
      () => (ext.local.data.status as Record<string, unknown> | undefined)?.state === 'retrying',
    );
    expect((ext.local.data.outbox as { entries: unknown[] }).entries).toHaveLength(1);
    expect((ext.local.data.status as Record<string, unknown>).detail).toContain('isn’t its API');
  });

  it('starts a sitting’s sync record afresh, so an old sitting’s late “ended” never marks the next one', async () => {
    const { ext, send } = setup((call) =>
      call.body.args[0].sittingId === 'OLD'
        ? { status: 400, body: { error: SITTING_ENDED_ERROR } }
        : { status: 503, body: { error: 'busy' } },
    );
    await ext.local.set({ apiOrigin: 'https://aperture.test', deviceToken: 't' });
    await send({ type: 'enqueue', sittingId: 'OLD', slug: 'two-sum', events: events(1) });
    await until(
      () => (ext.local.data['sync:two-sum'] as { status?: string } | undefined)?.status === 'ended',
    );
    await send({ type: 'enqueue', sittingId: 'NEW', slug: 'two-sum', events: events(1, 5) });
    const sync = await until(() => {
      const s = ext.local.data['sync:two-sum'] as Record<string, unknown> | undefined;
      return s && s.sittingId === 'NEW' ? s : null;
    });
    expect(sync.status).toBeUndefined();
  });

  it('answers Start directly, says when it isn’t configured, and remembers Just looking for the session', async () => {
    const { ext, calls, send } = setup(() => ({
      status: 200,
      body: { sitting: { id: 'S' }, resumed: false },
    }));
    expect(await send({ type: 'start', body: {} })).toMatchObject({
      status: -1,
      error: expect.stringContaining('options'),
    });
    await ext.local.set({ apiOrigin: 'https://aperture.test', deviceToken: 't' });
    expect(await send({ type: 'start', body: { problemSlug: 'two-sum' } })).toMatchObject({
      status: 200,
      json: { sitting: { id: 'S' } },
    });
    expect(calls[0]!.url).toBe('https://aperture.test/api/lcSittingStart');
    expect(await send({ type: 'dismissed?', slug: 'two-sum' })).toEqual({ dismissed: false });
    await send({ type: 'dismiss', slug: 'two-sum' });
    expect(await send({ type: 'dismissed?', slug: 'two-sum' })).toEqual({ dismissed: true });
    expect(ext.session.data['dismissed:two-sum']).toBe(true);
    expect(ext.local.data['dismissed:two-sum']).toBeUndefined();
  });

  it('answers an enqueue it couldn’t store with {ok: false} and the error, so the content script retries it', async () => {
    const { ext, send } = setup(() => ok);
    const set = ext.local.set.bind(ext.local);
    ext.local.set = async (items: Record<string, unknown>) => {
      if ('outbox' in items) throw new Error('QuotaExceededError');
      return set(items);
    };
    expect(
      await send({ type: 'enqueue', sittingId: 'SIT', slug: 'two-sum', events: events(1) }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('QuotaExceededError') });
  });

  it('ignores messages from anything but the extension itself', async () => {
    const { ext, calls } = setup(() => ok);
    await ext.local.set({ apiOrigin: 'https://aperture.test', deviceToken: 't' });
    const replies: unknown[] = [];
    for (const l of ext.msgListeners)
      l({ type: 'start', body: {} }, { id: 'someone-else' }, (v) => replies.push(v));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    expect(replies).toEqual([]);
  });
});
