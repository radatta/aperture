// The gated seam for the full catalog's source (lcCatalog.ts → LC_CATALOG_SOURCE): one GET of the pinned dataset file
// on raw.githubusercontent.com — a public, MIT-licensed metadata file, never leetcode.com. Like the other gateways a
// testMode/smoke request gets `noopCatalogSource`, tests and the local server get `fakeCatalogSource`, and the live one
// is wired only in the Lambda entrypoints. It writes nothing and never throws: every failure is an outcome.

export type CatalogFetch = { ok: true; data: unknown } | { ok: false; error: string };
export interface CatalogSource {
  fetch(url: string): Promise<CatalogFetch>;
}

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024; // the pinned file is ~2.6 MB

export function liveCatalogSource(
  cfg: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): CatalogSource {
  const doFetch = cfg.fetch ?? fetch;
  const max = cfg.maxBytes ?? MAX_BYTES;
  return {
    async fetch(url) {
      if (!url.startsWith('https://raw.githubusercontent.com/'))
        return { ok: false, error: 'not the pinned source host' };
      try {
        const res = await doFetch(url, {
          signal: AbortSignal.timeout(cfg.timeoutMs ?? TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `source HTTP ${res.status}` };
        if (Number(res.headers.get('content-length') ?? 0) > max)
          return { ok: false, error: 'source too large' };
        const text = await res.text();
        if (text.length > max) return { ok: false, error: 'source too large' };
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

export const noopCatalogSource = (): CatalogSource => ({
  fetch: async () => ({ ok: false, error: 'the catalog source is off here' }),
});

// The test double: `next` is the outcome (the fixture rows by default); `urls` records each fetch.
export class FakeCatalogSource implements CatalogSource {
  urls: string[] = [];
  constructor(public next: CatalogFetch) {}
  async fetch(url: string): Promise<CatalogFetch> {
    this.urls.push(url);
    return this.next;
  }
}
