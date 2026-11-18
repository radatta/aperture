// The gated seam for the full catalog's source (lcCatalog.ts → LC_CATALOG_SOURCE): one GET of the pinned dataset file
// on raw.githubusercontent.com — a public, MIT-licensed metadata file, never leetcode.com. Only the coach worker
// fetches (an import runs nowhere else, and never in testMode); tests and the local server use `FakeCatalogSource`.
// It writes nothing and never throws: every failure is an outcome. No redirect is followed, and the body is cut off
// at `maxBytes` as it streams.

export type CatalogFetch = { ok: true; data: unknown } | { ok: false; error: string };
export interface CatalogSource {
  fetch(url: string): Promise<CatalogFetch>;
}

const HOST = 'https://raw.githubusercontent.com/';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024; // the pinned file is ~2.6 MB

export function liveCatalogSource(
  cfg: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): CatalogSource {
  const doFetch = cfg.fetch ?? fetch;
  const max = cfg.maxBytes ?? MAX_BYTES;
  return {
    async fetch(url) {
      if (!url.startsWith(HOST)) return { ok: false, error: 'not the pinned source host' };
      try {
        const res = await doFetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(cfg.timeoutMs ?? TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `source HTTP ${res.status}` };
        if (Number(res.headers.get('content-length') ?? 0) > max)
          return { ok: false, error: 'source too large' };
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const reader = res.body?.getReader();
        if (!reader) return { ok: false, error: 'source had no body' };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > max) {
            await reader.cancel();
            return { ok: false, error: 'source too large' };
          }
          chunks.push(value);
        }
        const text = new TextDecoder().decode(Buffer.concat(chunks));
        return { ok: true, data: JSON.parse(text) as unknown };
      } catch (err) {
        const name = (err as Error).name;
        return {
          ok: false,
          error:
            name === 'TimeoutError' || name === 'AbortError'
              ? 'source timed out'
              : name === 'SyntaxError'
                ? 'source is not JSON'
                : `source fetch failed (${name})`,
        };
      }
    },
  };
}

// The test double: `next` is the outcome; `urls` records each fetch.
export class FakeCatalogSource implements CatalogSource {
  urls: string[] = [];
  constructor(public next: CatalogFetch) {}
  async fetch(url: string): Promise<CatalogFetch> {
    this.urls.push(url);
    return this.next;
  }
}
