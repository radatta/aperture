import { describe, expect, it } from 'vitest';
import { liveCatalogSource } from './source';

// The live source gateway over an injected fetch: every branch of the one network path.
const URL_OK = 'https://raw.githubusercontent.com/owner/repo/0123/data/file.json';
const calls: { url: string; init: RequestInit }[] = [];
const source = (respond: () => Response | Promise<Response>, maxBytes?: number) =>
  liveCatalogSource({
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch,
    maxBytes,
  });
const body = (text: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers });

describe('liveCatalogSource', () => {
  it('parses the file, never following a redirect', async () => {
    const got = await source(() => body('[{"a":1}]')).fetch(URL_OK);
    expect(got).toEqual({ ok: true, data: [{ a: 1 }] });
    expect(calls.at(-1)!.init.redirect).toBe('error');
  });

  it('refuses any other host before a request', async () => {
    const before = calls.length;
    expect(await source(() => body('[]')).fetch('https://example.com/x.json')).toEqual({
      ok: false,
      error: 'not the pinned source host',
    });
    expect(calls.length).toBe(before);
  });

  it('maps a bad status, a size over the cap (declared or streamed), bad JSON and a timeout', async () => {
    expect(await source(() => body('nope', 404)).fetch(URL_OK)).toEqual({
      ok: false,
      error: 'source HTTP 404',
    });
    expect(
      await source(() => body('[]', 200, { 'content-length': '999' }), 10).fetch(URL_OK),
    ).toEqual({ ok: false, error: 'source too large' });
    expect(await source(() => body('x'.repeat(50)), 10).fetch(URL_OK)).toEqual({
      ok: false,
      error: 'source too large',
    });
    expect(await source(() => body('{not json')).fetch(URL_OK)).toEqual({
      ok: false,
      error: 'source is not JSON',
    });
    expect(
      await source(() =>
        Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
      ).fetch(URL_OK),
    ).toEqual({ ok: false, error: 'source timed out' });
    expect(await source(() => Promise.reject(new TypeError('redirect'))).fetch(URL_OK)).toEqual({
      ok: false,
      error: 'source fetch failed (TypeError)',
    });
  });
});
