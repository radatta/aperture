import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { EventGoneError } from './gateway';
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
      start: { dateTime: '1970-01-01T00:00:00.000Z' },
      end: { dateTime: '1970-01-01T00:30:00.000Z' },
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
