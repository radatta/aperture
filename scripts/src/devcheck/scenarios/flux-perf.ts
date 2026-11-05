// Flux performance on dev (docs/areas/flux D63–D64): the Flux pages load as their own chunk — `/` never
// fetches it, a Flux visit fetches one — and the edge serves the tracking wasm brotli-encoded with its decoded
// size as metadata. The wasm is found from the deployed build itself: sw.js's precache names the worker
// chunk, the worker chunk names the wasm — so the GET proves the commit under test, with no camera and no
// local dist. The chunk evidence is the page's resource timing, which sees a chunk the service worker
// served as well as one from the network.
import { assertBrWasmHeaders } from '../../../aws/flux-wasm.mjs';
import { DEV_ORIGIN, assertDevOrigin } from '../config';
import { noConsoleErrors, type Scenario } from '../scenario';

const CHUNK = /\/assets\/flux-pages-[\w-]+\.js$/;
const WORKER = /\/?assets\/flux\.worker-[\w-]+\.js/; // the precache manifest writes it without the slash
const WASM = /\/assets\/vision_wasm_module_internal-[\w-]+\.br\.wasm/;

// Every resource the page has loaded so far (the SW-served ones included), by URL.
// Throws if the buffer (250 entries by default) filled, so a "no chunk" check can't pass by overflow.
const loaded = async (ctx: Parameters<Scenario['steps'][number]['run']>[0]) => {
  const names = await ctx.page.evaluate<string[]>(
    "performance.getEntriesByType('resource').map((e) => e.name).concat(performance.getEntriesByType('navigation').map((e) => e.name))",
  );
  if (names.length >= 250) throw new Error(`resource timing buffer full (${names.length} entries)`);
  return names;
};

// The gate (a test user who never opened Flux) or the tabs: Settings may still be loading when the shell is up.
async function pastTheGate(ctx: Parameters<Scenario['steps'][number]['run']>[0]): Promise<void> {
  const gate = ctx.page.getByRole('button', { name: /I understand/ });
  const tabs = ctx.page.getByRole('navigation', { name: 'Flux sections' });
  await gate.or(tabs).first().waitFor({ timeout: 15_000 });
  if (await gate.isVisible()) {
    ctx.log('accepting the Flux disclaimer for the test user');
    await gate.click();
  }
}

async function fetchDev(path: string, init?: RequestInit): Promise<Response> {
  const url = `${DEV_ORIGIN}${path}`;
  assertDevOrigin(url);
  const r = await fetch(url, init);
  if (r.status !== 200) throw new Error(`${path}: expected 200, got ${r.status}`);
  return r;
}

export const fluxPerf: Scenario = {
  id: 'flux-perf',
  title: 'Flux loads as its own chunk, and the edge serves the wasm brotli-encoded',
  tiers: ['full'],
  rows: [
    {
      id: 'lazy-home',
      entry: 'ui',
      kind: 'nominal',
      what: 'The home loads with no Flux chunk (flux-pages-*.js) request',
    },
    {
      id: 'lazy-flux',
      entry: 'ui',
      kind: 'nominal',
      what: '/flux fetches one Flux chunk and the Library renders',
    },
    {
      id: 'deep-link',
      entry: 'ui',
      kind: 'nominal',
      what: 'A reload on /flux/history renders History inside the shell',
    },
    {
      id: 'deep-link-loading',
      entry: 'ui',
      kind: 'edge',
      what: 'While the Flux chunk is still loading, the shell is up with "Loading…" in the outlet, not a blank page',
      offDev: {
        file: 'app/src/routes.test.tsx',
        test: 'a deep link to /flux/history keeps the shell up, with "Loading…" in the outlet, until the Flux chunk lands',
        why: 'dev serves the precached chunk from the service worker in a few ms and a Playwright route cannot hold a SW-served request; the test renders the real AppShell and the same lazyPage helper routes.tsx uses, over a chunk it holds — the deep-link row proves the real route table’s rendered result on dev',
      },
    },
    {
      id: 'wasm-br',
      entry: 'api',
      kind: 'nominal',
      what: 'The edge answers the wasm with content-encoding br, application/wasm and a numeric raw length, and the decoded body is that many bytes of wasm',
    },
    {
      id: 'progress-clamp',
      entry: 'ui',
      kind: 'edge',
      what: 'The download bar never passes 100% on a brotli body (content-length is the wire size, the bytes counted are decoded)',
      offDev: {
        file: 'app/src/modules/flux/engine/assets.test.ts',
        test: 'a decoded body never exceeds the raw-length total',
        why: 'the bar shows only after Start, which needs a camera the harness has not got — a needs-you row would leave the clamp unproven, so the named test (the real loader fed a br-shaped response) is the proof instead',
      },
    },
    {
      id: 'cache-hit',
      entry: 'ui',
      kind: 'edge',
      what: 'A wasm already in the Cache API (the decoded copy from last time) loads without a download',
      offDev: {
        file: 'app/src/modules/flux/engine/assets.test.ts',
        test: 'serves the second load from the cache without touching the network',
        why: 'reaching the loader on dev needs a camera — a needs-you row would leave the cache path unproven, so the named test (the real loader against an in-memory Cache API) is the proof instead',
      },
    },
    {
      id: 'iphone-first-load',
      entry: 'ios',
      kind: 'nominal',
      what: 'iPhone, Settings → clear website data → Flux → Start: the download takes seconds (2.7 MB on the wire, was 13 MB); airplane mode → relaunch → tracking still works',
      needsYou: 'iOS Safari and a camera',
    },
  ],
  steps: [
    {
      id: 'home',
      entry: 'ui',
      proves: ['lazy-home'],
      title: 'The home loads without the Flux chunk',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.page
          .getByRole('button', { name: 'Night', exact: true })
          .waitFor({ timeout: 15_000 });
        await ctx.ui.settle();
        const chunks = (await loaded(ctx)).filter((u) => CHUNK.test(u));
        if (chunks.length) throw new Error(`the home loaded the Flux chunk: ${chunks.join(', ')}`);
      },
    },
    {
      id: 'library',
      entry: 'ui',
      proves: ['lazy-flux'],
      title: '/flux fetches one Flux chunk and the Library renders',
      async run(ctx) {
        await ctx.ui.goto('/flux');
        await pastTheGate(ctx);
        await ctx.ui.expectText('Neck Rotation', 15_000);
        const chunks = [...new Set((await loaded(ctx)).filter((u) => CHUNK.test(u)))];
        if (chunks.length !== 1)
          throw new Error(`expected one Flux chunk, saw ${chunks.length}: ${chunks.join(', ')}`);
        ctx.log(`Flux chunk ${chunks[0]}`);
        await ctx.shot('library');
      },
    },
    {
      id: 'deep-link',
      entry: 'ui',
      proves: ['deep-link'],
      title: 'A reload on /flux/history renders History inside the shell',
      async run(ctx) {
        await ctx.ui.goto('/flux/history');
        await ctx.page.reload({ waitUntil: 'domcontentloaded' });
        await pastTheGate(ctx);
        await ctx.ui.expectText('Today', 15_000);
        const nav = ctx.page.getByRole('link', { name: 'Flux', exact: true });
        if (!(await nav.first().isVisible())) throw new Error('the shell nav is not on screen');
        await ctx.shot('history-deep-link');
      },
    },
    {
      id: 'wasm',
      entry: 'api',
      proves: ['wasm-br'],
      title:
        'The edge serves the deployed wasm brotli-encoded, with its raw length, and the body decodes',
      async run(ctx) {
        const sw = await (await fetchDev('/sw.js')).text();
        const named = WORKER.exec(sw)?.[0];
        if (!named) throw new Error('sw.js names no flux.worker chunk in its precache');
        const worker = '/' + named.replace(/^\//, '');
        const wasm = WASM.exec(await (await fetchDev(worker)).text())?.[0];
        if (!wasm) throw new Error(`${worker} names no *.br.wasm`);
        ctx.log(`wasm ${wasm}`);
        const head = await fetchDev(wasm, { method: 'HEAD', headers: { 'accept-encoding': 'br' } });
        const raw = assertBrWasmHeaders((name) => head.headers.get(name));
        const res = await fetchDev(wasm, { headers: { 'accept-encoding': 'br' } });
        assertBrWasmHeaders((name) => res.headers.get(name));
        const wire = Number(res.headers.get('content-length'));
        const body = new Uint8Array(await res.arrayBuffer());
        if (body.byteLength !== raw)
          throw new Error(`decoded ${body.byteLength} B, raw-length says ${raw}`);
        if (!(wire > 0 && wire < raw / 3))
          throw new Error(`content-length ${wire} B is not a brotli wire size for ${raw} B`);
        // \0asm — the module magic; a web page or a double-encoded body fails here.
        if (body[0] !== 0 || body[1] !== 0x61 || body[2] !== 0x73 || body[3] !== 0x6d)
          throw new Error('the decoded body is not a wasm module');
        ctx.log(
          `wasm ${raw.toLocaleString()} B decoded from ${wire.toLocaleString()} B on the wire`,
        );
      },
    },
    noConsoleErrors,
  ],
};
