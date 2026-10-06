import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { EventGoneError, PullIncompleteError } from './gateway';
import { LiveGoogle } from './liveGoogle';

// patchEvent's response handling, over a stubbed fetch (no network, no SSM). Every SSM read returns a
// value, and the token endpoint a fresh access token, so only the events call varies.
const ssm = { send: async () => ({ Parameter: { Value: 'v' } }) } as unknown as SSMClient;

function gateway(events: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.includes('oauth2')) return Response.json({ access_token: 'at', expires_in: 3600 });
    calls.push({ url, init });
    return events();
  });
  return { g: new LiveGoogle(ssm, { stage: 'test', appUrl: 'https://app.example' }), calls };
}
const input = { sub: 'A', calendarId: 'me@example.com', eventId: 'e1' };

afterEach(() => vi.unstubAllGlobals());

describe('LiveGoogle.patchEvent', () => {
  it('PATCHes only the given fields, as ISO instants', async () => {
    const { g, calls } = gateway(() => Response.json({ status: 'confirmed' }));
    await g.patchEvent({ ...input, title: 'pset', startMs: 0, endMs: 1_800_000 });
    expect(calls[0]!.url).toMatch(/\/calendars\/me%40example\.com\/events\/e1$/);
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      summary: 'pset',
      start: { date: null, dateTime: '1970-01-01T00:00:00.000Z' },
      end: { date: null, dateTime: '1970-01-01T00:30:00.000Z' },
    });
    await g.patchEvent({ ...input, title: 'renamed' });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ summary: 'renamed' });
  });

  it('an event deleted in Google is EventGoneError — 404, 410, or 200 with status cancelled', async () => {
    for (const res of [
      () => new Response(null, { status: 404 }),
      () => new Response(null, { status: 410 }),
      () => Response.json({ status: 'cancelled' }),
    ]) {
      const { g } = gateway(res);
      await expect(g.patchEvent({ ...input, title: 'x' })).rejects.toBeInstanceOf(EventGoneError);
    }
  });

  it('any other failure is a plain error', async () => {
    const { g } = gateway(() => new Response(null, { status: 500 }));
    const err = await g.patchEvent({ ...input, title: 'x' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(EventGoneError);
    expect(String(err)).toMatch(/events\.patch failed \(500\)/);
  });
});

describe('LiveGoogle.listEventChanges', () => {
  const ask = { sub: 'A', calendarId: 'me@example.com', deadlineMs: Number.MAX_SAFE_INTEGER };
  const queued = (...responses: (() => Response)[]) => {
    let i = 0;
    return gateway(() => responses[i++]!());
  };
  const params = (url: string) => new URL(url).searchParams;
  const item = { id: 'e1', summary: 'pset', updated: '2026-10-05T10:00:00.000Z' };

  it('a full sync bounds by timeMin and uses the fixed query; a token-ed one drops timeMin', async () => {
    const { g, calls } = queued(
      () => Response.json({ items: [item], nextSyncToken: 's1' }),
      () => Response.json({ items: [], nextSyncToken: 's2' }),
    );
    const first = await g.listEventChanges({ ...ask, syncToken: null });
    expect(first).toMatchObject({
      syncToken: 's1',
      full: true,
      events: [{ eventId: 'e1', title: 'pset' }],
    });
    const p0 = params(calls[0]!.url);
    expect(Object.fromEntries(p0)).toMatchObject({
      singleEvents: 'false',
      showDeleted: 'true',
      maxResults: '250',
    });
    expect(p0.has('timeMin')).toBe(true);
    expect(p0.has('syncToken')).toBe(false);
    const next = await g.listEventChanges({ ...ask, syncToken: 's1' });
    expect(next).toMatchObject({ syncToken: 's2', full: false, events: [] });
    const p1 = params(calls[1]!.url);
    expect(p1.get('syncToken')).toBe('s1');
    expect(p1.has('timeMin')).toBe(false);
    expect(p1.get('showDeleted')).toBe('true');
  });

  it('follows nextPageToken with the same query until the sync token', async () => {
    const { g, calls } = queued(
      () => Response.json({ items: [item], nextPageToken: 'p2' }),
      () => Response.json({ items: [{ ...item, id: 'e2' }], nextSyncToken: 's9' }),
    );
    const d = await g.listEventChanges({ ...ask, syncToken: 's1' });
    expect(d.events.map((e) => e.eventId)).toEqual(['e1', 'e2']);
    expect(d.syncToken).toBe('s9');
    expect(params(calls[1]!.url).get('pageToken')).toBe('p2');
    expect(params(calls[1]!.url).get('syncToken')).toBe('s1');
  });

  it('410 on a token → one full sync in the same call', async () => {
    const { g, calls } = queued(
      () => new Response(null, { status: 410 }),
      () => Response.json({ items: [], nextSyncToken: 'fresh' }),
    );
    expect(await g.listEventChanges({ ...ask, syncToken: 'old' })).toMatchObject({
      syncToken: 'fresh',
      full: true,
    });
    expect(params(calls[1]!.url).has('syncToken')).toBe(false);
  });

  it('past the deadline → PullIncompleteError, no token', async () => {
    const { g } = queued(() => Response.json({ items: [], nextPageToken: 'p2' }));
    await expect(
      g.listEventChanges({ ...ask, syncToken: 's1', deadlineMs: 0 }),
    ).rejects.toBeInstanceOf(PullIncompleteError);
  });

  it('a page cut off by the budget (not a slow call) reads as running out of time', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('oauth2')) return Response.json({ access_token: 'at', expires_in: 3600 });
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    });
    const g = new LiveGoogle(ssm, { stage: 'test', appUrl: 'https://app.example' });
    await expect(
      g.listEventChanges({ ...ask, syncToken: 's1', deadlineMs: Date.now() + 1_000 }),
    ).rejects.toBeInstanceOf(PullIncompleteError);
  });

  it('any other failure is a plain error', async () => {
    const { g } = queued(() => new Response(null, { status: 500 }));
    await expect(g.listEventChanges({ ...ask, syncToken: 's1' })).rejects.toThrow(
      /events\.list failed \(500\)/,
    );
  });
});

describe('LiveGoogle.insertEvent', () => {
  it('tags the event with its task id', async () => {
    const { g, calls } = gateway(() => Response.json({ id: 'new' }));
    await g.insertEvent({
      sub: 'A',
      calendarId: 'me@example.com',
      title: 't',
      startMs: 0,
      endMs: 60_000,
      taskId: 'T1',
    });
    expect(JSON.parse(calls[0]!.init.body as string).extendedProperties).toEqual({
      private: { apertureTaskId: 'T1' },
    });
  });
});
