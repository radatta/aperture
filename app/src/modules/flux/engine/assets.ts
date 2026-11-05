import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';
import modelUrl from './model/face_landmarker.float16.v1.task?url';

// Flux's tracking assets, self-hosted as hashed, immutable files (no CDN; nothing leaves the device). The
// 13 MB wasm and the 3.8 MB model are deliberately not in the SW precache — only Flux users pay for them
// — so the worker caches them itself here, with byte progress for the first download. The JS glue is a
// plain hashed .js, which the precache already covers. Runs inside the worker (CacheStorage and fetch
// both exist there), so the bytes never cross to the main thread.

const CACHE = 'aperture-flux-assets';

export interface FluxAssets {
  // MediaPipe's WasmFileset: the module glue by URL, the binary as a blob: URL of the cached bytes.
  readonly fileset: { readonly wasmLoaderPath: string; readonly wasmBinaryPath: string };
  readonly modelBytes: Uint8Array;
}

export interface AssetDeps {
  readonly fetch: typeof fetch;
  // Absent where CacheStorage isn't exposed (or throws, e.g. a private window): just fetch.
  readonly caches: CacheStorage | undefined;
}

const defaultDeps = (): AssetDeps => ({
  fetch: (...args) => fetch(...args),
  caches: typeof caches === 'undefined' ? undefined : caches,
});

export async function loadFluxAssets(
  onProgress: (loaded: number, total: number) => void,
  deps: AssetDeps = defaultDeps(),
): Promise<FluxAssets> {
  const cache = await deps.caches?.open(CACHE).catch(() => undefined);
  const urls = [wasmBinaryUrl, modelUrl];
  const responses = await Promise.all(urls.map((url) => cachedOrFetched(url, cache, deps)));
  const totals = responses.map(rawLength);
  const loaded = urls.map(() => 0);
  const report = () =>
    onProgress(
      loaded.reduce((a, b) => a + b, 0),
      totals.reduce((a, b) => a + b, 0),
    );
  const [wasm, model] = await Promise.all(
    responses.map((r, i) =>
      readAll(r, (n) => {
        // The bytes counted are decoded; a total that came from a wrong or missing header must not let
        // the bar pass 100%.
        loaded[i] = totals[i] ? Math.min(n, totals[i]) : n;
        report();
      }),
    ),
  );
  if (!wasm || !model) throw new Error('Flux assets: missing download');
  if (cache) void prune(cache, urls);
  return {
    fileset: {
      wasmLoaderPath: wasmLoaderUrl,
      // The type matters: WebKit's streaming compile rejects anything but application/wasm.
      wasmBinaryPath: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
    },
    modelBytes: model,
  };
}

async function cachedOrFetched(
  url: string,
  cache: Cache | undefined,
  deps: AssetDeps,
): Promise<Response> {
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) return hit;
  const res = await deps.fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${name(url)} (HTTP ${res.status})`);
  // A missing asset comes back as the SPA fallback — 200 text/html — which would otherwise be handed
  // to the wasm compiler as garbage.
  if ((res.headers.get('content-type') ?? '').includes('text/html'))
    throw new Error(`Couldn't download ${name(url)} (got a web page, not the file)`);
  // Store a copy while the original streams to the caller (not awaited — awaiting would hold the
  // progress bar at 0 until the whole download landed). A failed put only costs a re-download.
  if (cache) void cache.put(url, res.clone()).catch(() => undefined);
  return res;
}

// The download's size in decoded bytes. The wasm is published brotli-encoded, so its content-length is the
// wire size (about a fifth) while the stream below yields decoded bytes; publish-frontend.mjs stamps the
// raw size as x-amz-meta-raw-length (D63). Anything else (the model, a local preview) is served as-is.
function rawLength(res: Response): number {
  const raw = Number(res.headers.get('x-amz-meta-raw-length'));
  if (Number.isInteger(raw) && raw > 0) return raw;
  return Number(res.headers.get('content-length')) || 0;
}

async function readAll(
  res: Response,
  onBytes: (n: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onBytes(buf.byteLength);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
    onBytes(n);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// Drop entries for older hashed assets, so an upgrade doesn't leave 17 MB behind per version.
async function prune(cache: Cache, keep: readonly string[]): Promise<void> {
  try {
    const wanted = new Set(keep.map((u) => new URL(u, self.location.href).href));
    for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
  } catch {
    // best effort
  }
}

const name = (url: string) =>
  url.endsWith('.wasm') ? 'the tracking engine' : 'the tracking model';
