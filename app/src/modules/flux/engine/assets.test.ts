import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFluxAssets, type AssetDeps } from './assets';

// A minimal in-memory CacheStorage: one cache, keyed by URL.
function memoryCaches() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (url: string) => store.get(url)?.clone(),
    put: async (url: string, res: Response) => {
      store.set(url, new Response(await res.arrayBuffer(), { headers: res.headers }));
    },
    keys: async () => [...store.keys()].map((u) => new Request(new URL(u, 'http://localhost/'))),
    delete: async (req: Request) => store.delete(new URL(req.url).pathname),
  };
  return { store, caches: { open: async () => cache } as unknown as CacheStorage };
}

const bytes = (n: number) =>
  new Response(new Uint8Array(n).fill(7), {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(n) },
  });

let origCreate: typeof URL.createObjectURL;
beforeEach(() => {
  origCreate = URL.createObjectURL;
  URL.createObjectURL = () => 'blob:wasm'; // jsdom lacks it
});
afterEach(() => {
  URL.createObjectURL = origCreate;
});

describe('loadFluxAssets', () => {
  it('downloads both files with monotone progress, hands back a blob wasm URL and the model bytes', async () => {
    const { caches } = memoryCaches();
    const fetch = vi.fn(async (url: RequestInfo | URL) =>
      bytes(String(url).endsWith('.wasm') ? 300 : 100),
    );
    const seen: [number, number][] = [];
    const assets = await loadFluxAssets((l, t) => seen.push([l, t]), {
      fetch: fetch as AssetDeps['fetch'],
      caches,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(assets.fileset.wasmBinaryPath).toBe('blob:wasm');
    expect(assets.fileset.wasmLoaderPath).toMatch(/vision_wasm_module_internal/);
    expect(assets.modelBytes.byteLength).toBe(100);
    expect(seen.at(-1)).toEqual([400, 400]);
    for (let i = 1; i < seen.length; i++)
      expect(seen[i]?.[0]).toBeGreaterThanOrEqual(seen[i - 1]?.[0] ?? 0);
  });

  it('serves the second load from the cache without touching the network', async () => {
    const { caches } = memoryCaches();
    const fetch = vi.fn(async () => bytes(50));
    await loadFluxAssets(() => {}, { fetch: fetch as AssetDeps['fetch'], caches });
    await new Promise((r) => setTimeout(r, 0)); // let the background puts land
    fetch.mockClear();
    const again = await loadFluxAssets(() => {}, { fetch: fetch as AssetDeps['fetch'], caches });
    expect(fetch).not.toHaveBeenCalled();
    expect(again.modelBytes.byteLength).toBe(50);
  });

  it('rejects the SPA fallback (200 text/html) instead of compiling a web page', async () => {
    const fetch = vi.fn(
      async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(
      loadFluxAssets(() => {}, { fetch: fetch as AssetDeps['fetch'], caches: undefined }),
    ).rejects.toThrow(/got a web page/);
  });

  it('reports an HTTP failure with the status', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    await expect(
      loadFluxAssets(() => {}, { fetch: fetch as AssetDeps['fetch'], caches: undefined }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('still works when CacheStorage refuses to open', async () => {
    const caches = { open: () => Promise.reject(new Error('blocked')) } as unknown as CacheStorage;
    const fetch = vi.fn(async () => bytes(10));
    const assets = await loadFluxAssets(() => {}, { fetch: fetch as AssetDeps['fetch'], caches });
    expect(assets.modelBytes.byteLength).toBe(10);
  });
});
