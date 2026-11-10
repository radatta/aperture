// Both worlds' real scripts (as the manifest loads them) over the fake LeetCode page in jsdom, with a fake
// extension API whose background answers like A1's server: the overlay's Start clicks LeetCode's own reset,
// confirm and timer; the binding resumes a reload; SPA navigation re-prompts.
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { JSDOM } from 'jsdom';
import {
  SITTING_ACTIVE_ERROR,
  SITTING_ENDED_ERROR,
  isUlid,
  normalizeSittingStart,
  problemCompanies,
  problemStatementText,
} from '@aperture/shared';
import {
  FetchedResponse,
  ISOLATED_JS,
  MAIN_JS,
  fakeExtension,
  page,
  run,
  shadowRoots,
  src,
  trustedClick,
  until,
} from './load';

const { createServer } = createRequire(import.meta.url)('./fixtures/fake-leetcode-server.js');
const idl = createRequire(import.meta.url)('jsdom/lib/generated/idl/utils.js');
// A trusted window event (the browser's own focus), as content.js only acts on those.
function trustedFocus(w: Window & typeof globalThis) {
  const ev = idl.implForWrapper(new w.Event('focus'));
  ev.isTrusted = true;
  idl.implForWrapper(w)._dispatch(ev);
}
type Msg = {
  type: string;
  body?: Record<string, unknown>;
  events?: Array<{ id?: string; type: string; payload?: unknown }>;
  slug?: string;
};

// The background, as far as content.js can tell: A1's Start (resume by clientSittingId, one open sitting).
function fakeBackground(opts: { configured?: boolean } = {}) {
  const sittings: Array<{
    id: string;
    slug: string;
    clientSittingId: string;
    clientStartedAt: number;
    status: string;
  }> = [];
  const dismissed = new Set<string>();
  let n = 0;
  const bg = {
    sittings,
    refuse: null as null | { status: number; error: string },
    hold: null as null | Promise<void>, // the next Start's answer waits for it
    handle(msg: Msg): unknown {
      if (msg.type === 'start' && bg.hold) {
        const h = bg.hold;
        bg.hold = null;
        return h.then(() => bg.handle(msg));
      }
      if (msg.type === 'dismiss') dismissed.add(String(msg.slug));
      if (msg.type === 'dismissed?') return { dismissed: dismissed.has(String(msg.slug)) };
      if (msg.type !== 'start') return { ok: true };
      if (opts.configured === false)
        return {
          status: -1,
          json: null,
          error: 'Set the Aperture origin and device token in the extension’s options.',
        };
      if (bg.refuse)
        return {
          status: bg.refuse.status,
          json: { error: bg.refuse.error },
          error: bg.refuse.error,
        };
      const b = msg.body!;
      normalizeSittingStart(b as never); // what A1 refuses, this would throw on
      let s = sittings.find((x) => x.status === 'active' && x.slug === b.problemSlug);
      const other = sittings.find((x) => x.status === 'active' && x.slug !== b.problemSlug);
      if (!s && other)
        return { status: 400, json: { error: SITTING_ACTIVE_ERROR }, error: SITTING_ACTIVE_ERROR };
      const resumed = !!s;
      if (!s) {
        s = {
          id: `01SITTING0000000000000000${n++}`,
          slug: String(b.problemSlug),
          clientSittingId: String(b.clientSittingId),
          clientStartedAt: Number(b.startedAt),
          status: 'active',
        };
        sittings.push(s);
      }
      return {
        status: 200,
        json: {
          resumed,
          sitting: {
            ...s,
            problemSlug: s.slug,
            problemTitle: b.problemTitle,
            questionId: b.questionId,
          },
        },
      };
    },
  };
  return bg;
}

const pages: JSDOM[] = [];
afterEach(() => {
  pages.splice(0).forEach((d) => d.window.close());
});

// `nextData`: the __NEXT_DATA__ a fresh load of LeetCode carries (it server-renders the problem doc there).
// `loading`: the scripts run while the page still parses, as Safari's document_start does (debug log 8) — the
// tag isn't there yet, and comes with DOMContentLoaded at `loaded()`. jsdom alone runs them at "interactive".
function open(
  path: string,
  ext: ReturnType<typeof fakeExtension>,
  opts: {
    nextData?: unknown;
    loading?: boolean;
    css?: { supports(p: string, v: string): boolean };
    lateHint?: boolean; // LeetCode names the question only on fake().sendHint()
  } = {},
) {
  const tag =
    opts.nextData === undefined
      ? ''
      : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(opts.nextData).replace(/</g, '\\u003c')}</script>`;
  let html = src('test/fixtures/fake-leetcode.html');
  if (!opts.loading) html = html.replace('</head>', `${tag}</head>`);
  const dom = page(`https://leetcode.com${path}`, html);
  pages.push(dom);
  const w = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  let ready = 'loading';
  if (opts.loading) {
    Object.defineProperty(w.document, 'readyState', { get: () => ready, configurable: true });
    // jsdom's own DOMContentLoaded (it has parsed already) never reaches the scripts: only loaded()'s does.
    const early = (e: Event) => ready === 'loading' && e.stopImmediatePropagation();
    w.document.addEventListener('DOMContentLoaded', early, true);
  }
  const loaded = () => {
    w.document.head.insertAdjacentHTML('beforeend', tag);
    ready = 'interactive';
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  };
  const lc = createServer();
  const fetchFake = async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url, w.location.href);
    const body = init?.body != null ? String(init.body) : null;
    const r = lc.respond(url.pathname, init?.method ?? 'GET', body) ?? { status: 404, body: '{}' };
    return new FetchedResponse(r.body, {
      status: r.status,
      headers: { 'content-type': 'application/json' },
      url: url.href,
    });
  };
  const rootOf = shadowRoots(dom);
  if (opts.css) (w as Record<string, unknown>).CSS = opts.css; // the browser's CSS namespace, as the page's scripts see it
  if (opts.lateHint) w.__fakeOpts = { lateHint: true };
  run(dom, MAIN_JS, { fetch: fetchFake });
  run(dom, ISOLATED_JS, { chrome: ext.api });
  run(dom, ['test/fixtures/fake-leetcode.js']);
  const host = () => w.document.querySelector('aperture-lc-overlay') as HTMLElement | null;
  const root = () => rootOf(host());
  const phase = () => root()?.querySelector('[data-phase]')?.getAttribute('data-phase');
  const text = () => root()?.textContent ?? '';
  const button = (ap: string) => root()?.querySelector(`[data-ap=${ap}]`) as HTMLElement | null;
  const badge = () =>
    rootOf(w.document.querySelector('aperture-lc-badge'))?.querySelector('[data-ap=badge]')
      ?.textContent;
  const tap = (ap: string) => trustedClick(button(ap)!);
  const fake = () =>
    w.__fake as {
      resets: number;
      timerStarts: number;
      timerResets: number;
      timerOpens: number;
      strays: number;
      syncs: number;
      resetCloses: boolean;
      resetInert: boolean;
      stickyPopup: boolean;
      timerResetClicks: number;
      slowNext: boolean;
      finishNext: () => void;
      fetchDoc: () => void;
      sendHint: () => void;
      setTimer: (s: Record<string, unknown>) => void;
    };
  const style = () => root()?.querySelector('style')?.textContent ?? '';
  return { w, phase, text, button, tap, badge, fake, style, loaded };
}
const messages = (ext: ReturnType<typeof fakeExtension>, type: string) =>
  (ext.sent as Msg[]).filter((m) => m.type === type);
const sentEvents = (ext: ReturnType<typeof fakeExtension>) =>
  messages(ext, 'enqueue').flatMap((m) => m.events ?? []);

describe('the overlay on a LeetCode problem', () => {
  it('Start resets the editor, starts the timer and opens a sitting; capture flows; a reload resumes; a second problem is refused', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });

    const p = open('/problems/two-sum/description/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    // On the shipped selectors (no override), a timer never used: LeetCode's reset, then the opener and Start.
    expect(p.fake()).toMatchObject({
      resets: 1,
      timerStarts: 1,
      timerResets: 0,
      timerOpens: 1,
      strays: 0,
    });
    const [start] = messages(ext, 'start');
    expect(isUlid(String(start!.body!.clientSittingId))).toBe(true);
    expect(start!.body).toMatchObject({
      problemSlug: 'two-sum',
      problemTitle: 'Two Sum',
      difficulty: 'Easy',
      topicTags: ['Array', 'Hash Table'],
      lang: 'Python3',
    });
    // LeetCode names the question (syncedCode) on its own schedule: in the Start if it came first, else the
    // binding learns it — either way the sitting has it.
    expect([null, '1']).toContain(start!.body!.questionId);
    await until(
      () =>
        (ext.local.data['sitting:two-sum'] as { questionId?: string } | undefined)?.questionId ===
        '1',
    );
    await until(() => p.badge()?.startsWith('Aperture · 0m'));

    // Typing → a snapshot, held for its 30 s window; Submit → the judged submit at once, and the pending
    // snapshot goes ahead of it in the same hand-off; the timer read.
    const code = p.w.document.querySelector('[data-fake=code]') as HTMLTextAreaElement;
    const syncs = p.fake().syncs;
    code.value += 'return [0, 1]\n';
    code.dispatchEvent(new p.w.Event('input'));
    await until(() => p.fake().syncs > syncs, 3000); // LeetCode's autosave went
    await new Promise((res) => setTimeout(res, 100)); // and the relay has it
    expect(sentEvents(ext).some((e) => e.type === 'snapshot')).toBe(false);
    (p.w.document.querySelector('[data-e2e-locator=console-submit-button]') as HTMLElement).click();
    await until(() => sentEvents(ext).some((e) => e.type === 'submit'), 6000);
    const withSubmit = messages(ext, 'enqueue').find((m) =>
      m.events!.some((e) => e.type === 'submit'),
    )!;
    expect(withSubmit.events!.map((e) => e.type)).toEqual(['snapshot', 'submit']);
    expect((withSubmit.events![0]!.payload as { code: string }).code).toContain('return [0, 1]');
    const submit = sentEvents(ext).find((e) => e.type === 'submit')!;
    expect(submit.payload).toMatchObject({
      slug: 'two-sum',
      result: { state: 'SUCCESS', status_msg: 'Accepted' },
      request: { typed_code: code.value },
    });
    await until(() => sentEvents(ext).some((e) => e.type === 'timer'), 6000);
    // LeetCode's questionDetail after the submit late-fills the problem doc with a repeat Start.
    await until(() => messages(ext, 'start').some((m) => m.body!.problem), 6000);
    expect(new Set(messages(ext, 'start').map((m) => m.body!.clientSittingId))).toEqual(
      new Set([start!.body!.clientSittingId]),
    );

    // A reload mid-sitting: no overlay, no reset, the same sitting.
    const r = open('/problems/two-sum/description/', ext);
    await until(() => r.phase() === 'active', 6000);
    expect(r.fake()).toMatchObject({ resets: 0, timerStarts: 0, timerResets: 0, timerOpens: 0 });
    expect(bg.sittings).toHaveLength(1);

    // "Next problem" (an SPA nav) re-prompts; its Start is refused while two-sum is open.
    (r.w.document.querySelector('[data-fake=next]') as HTMLElement).click();
    await until(() => r.phase() === 'prompt', 3000);
    r.tap('start');
    await until(() => r.phase() === 'failed', 8000);
    expect(r.text()).toContain(`${SITTING_ACTIVE_ERROR} Then Retry.`);
  }, 40_000);

  it('opens the sitting first, says LeetCode’s reset isn’t configured, and Continue without a clear goes active', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ selectors: { editorReset: null } }); // a step turned off in Options
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'failed');
    expect(p.text()).toContain('reset button isn’t configured');
    expect(bg.sittings).toHaveLength(1); // Aperture said yes before any click
    expect(p.button('look')).toBeNull(); // the sitting is open: Retry or Continue
    p.tap('continue');
    await until(() => p.phase() === 'active');
    expect(p.fake().resets).toBe(0);
    expect(bg.sittings).toHaveLength(1);
  });

  it('ignores a page script’s click on Start, and clicks nothing on LeetCode for a Start Aperture refuses', async () => {
    const bg = fakeBackground({ configured: false });
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.button('start')!.click(); // what a LeetCode script can do: an untrusted click
    p.button('look')!.click();
    await new Promise((res) => setTimeout(res, 300));
    expect(p.phase()).toBe('prompt');
    expect(messages(ext, 'start')).toEqual([]);
    p.tap('start');
    await until(() => p.phase() === 'failed');
    expect(p.text()).toContain('extension’s options');
    expect(messages(ext, 'start')).toHaveLength(1); // asked, refused — and nothing on LeetCode was clicked
    expect(p.fake()).toMatchObject({
      resets: 0,
      timerStarts: 0,
      timerResets: 0,
      timerOpens: 0,
      strays: 0,
    });
    // Nor can the page read what the overlay says: its root is closed and its host carries no state.
    const host = p.w.document.querySelector('aperture-lc-overlay')!;
    expect(host.shadowRoot).toBeNull();
    expect(host.getAttribute('data-phase')).toBeNull();
  });

  it('keeps the sitting when a reload’s resume is refused for any reason but its end', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    bg.refuse = { status: 401, error: 'Unauthorized' };
    const r = open('/problems/two-sum/', ext);
    await until(() => r.phase() === 'active', 6000);
    expect(ext.local.data['sitting:two-sum']).toBeTruthy();
    bg.refuse = { status: 400, error: SITTING_ENDED_ERROR };
    const e = open('/problems/two-sum/', ext);
    await until(() => e.phase() === 'prompt', 6000);
    expect(ext.local.data['sitting:two-sum']).toBeUndefined();
  }, 20_000);

  it('sends a submit judged after moving to the next problem to its own problem’s sitting', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    const sitting = (ext.local.data['sitting:two-sum'] as { sittingId: string }).sittingId;
    // Submit, and move on before LeetCode has judged it.
    (p.w.document.querySelector('[data-e2e-locator=console-submit-button]') as HTMLElement).click();
    (p.w.document.querySelector('[data-fake=next]') as HTMLElement).click();
    await until(() => p.phase() === 'prompt', 3000); // the next problem asks, as ever
    const late = await until(
      () =>
        messages(ext, 'enqueue').find((m) => m.events!.some((e) => e.type === 'submit')) as
          (Msg & { sittingId?: string }) | undefined,
      6000,
    );
    expect(late).toMatchObject({ slug: 'two-sum', sittingId: sitting });
    expect(messages(ext, 'enqueue').every((m) => m.slug === 'two-sum')).toBe(true); // nothing to the next one
  }, 20_000);

  it('sends a submit judged after leaving for the problem list to its problem’s sitting', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    (p.w.document.querySelector('[data-e2e-locator=console-submit-button]') as HTMLElement).click();
    p.w.history.pushState({}, '', '/problemset/');
    await until(() => p.phase() === 'hidden', 3000);
    const late = await until(
      () =>
        messages(ext, 'enqueue').find((m) => m.events!.some((e) => e.type === 'submit')) as
          (Msg & { sittingId?: string }) | undefined,
      6000,
    );
    expect(late).toMatchObject({ slug: 'two-sum' });
  }, 20_000);

  it('hands the pending snapshot over when the page is hidden', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    const code = p.w.document.querySelector('[data-fake=code]') as HTMLTextAreaElement;
    const syncs = p.fake().syncs;
    code.value += 'return []\n';
    code.dispatchEvent(new p.w.Event('input'));
    await until(() => p.fake().syncs > syncs, 3000);
    await new Promise((res) => setTimeout(res, 100));
    expect(
      sentEvents(ext).some((e) => (e.payload as { code?: string })?.code?.includes('return []')),
    ).toBe(false);
    p.w.dispatchEvent(new p.w.Event('pagehide'));
    await until(() =>
      sentEvents(ext).some(
        (e) => e.type === 'snapshot' && (e.payload as { code: string }).code.includes('return []'),
      ),
    );
  }, 20_000);

  it('Just looking dismisses without touching the editor, and is remembered for the problem', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('look');
    expect(p.phase()).toBe('hidden');
    await until(() => messages(ext, 'dismiss').length === 1);
    const again = open('/problems/two-sum/', ext);
    await until(() => messages(ext, 'dismissed?').length === 2);
    await new Promise((res) => setTimeout(res, 300));
    expect(again.phase()).toBe('hidden');
    expect(again.fake()).toMatchObject({
      resets: 0,
      timerStarts: 0,
      timerResets: 0,
      timerOpens: 0,
    });
    // Nothing is captured for a problem with no sitting.
    const code = again.w.document.querySelector('[data-fake=code]') as HTMLTextAreaElement;
    code.dispatchEvent(new again.w.Event('input'));
    await new Promise((res) => setTimeout(res, 800));
    expect(messages(ext, 'enqueue')).toEqual([]);
    expect(messages(ext, 'start')).toEqual([]);
  });
  // LeetCode's timer as the debug log recorded it: a countdown left paused, a stopwatch left running, idle.
  const NOW = () => Date.now();
  const PAUSED_COUNTDOWN = () => ({
    mode: 'reverse',
    startTimestamp: null,
    pauseMs: 6550,
    endMs: 3600000,
    lastUsedEndMs: 3600000,
    status: 'pause',
    isUserPaused: true,
    alertMinute: 10,
  });
  const RUNNING_STOPWATCH = () => ({
    mode: 'forward',
    startTimestamp: NOW() - 90_000,
    pauseMs: null,
    endMs: null,
    lastUsedEndMs: 3600000,
    status: 'running',
    isUserPaused: false,
    alertMinute: 10,
  });
  const timerState = (p: ReturnType<typeof open>) =>
    JSON.parse(p.w.localStorage.getItem('QD_TIMER_STATE') ?? 'null') as {
      mode: string;
      status: string;
      startTimestamp: number | null;
    } | null;
  async function startOn(
    seed: Record<string, unknown> | null,
    opts: { selectors?: Record<string, unknown>; resetCloses?: boolean; debug?: boolean } = {},
  ) {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    if (opts.selectors) await ext.local.set({ selectors: opts.selectors });
    if (opts.debug) await ext.local.set({ debug: true });
    const p = open('/problems/two-sum/', ext);
    if (seed) p.fake().setTimer(seed);
    if (opts.resetCloses) p.fake().resetCloses = true;
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active' || p.phase() === 'failed', 8000);
    return { p, ext, bg };
  }

  it('restarts a timer left running or paused: LeetCode’s reset first, then Start from the pop-up that stays open', async () => {
    for (const [seed, mode] of [
      [PAUSED_COUNTDOWN(), 'reverse'],
      [RUNNING_STOPWATCH(), 'forward'],
    ] as const) {
      const { p } = await startOn(seed);
      expect(p.phase()).toBe('active');
      expect(p.fake()).toMatchObject({ timerResets: 1, timerStarts: 1, timerOpens: 0, strays: 0 });
      const t = timerState(p)!;
      expect(t).toMatchObject({ mode, status: 'running' }); // the mode LeetCode last used, kept
      expect(Date.now() - t.startTimestamp!).toBeLessThan(5000); // started just now, not resumed
    }
  }, 30_000);

  it('opens an idle timer under either name', async () => {
    const forward = await startOn({ ...RUNNING_STOPWATCH(), status: 'idle', startTimestamp: null });
    expect(
      forward.p.w.document.querySelector('[data-fake=opener]')?.getAttribute('aria-label'),
    ).toBe('Stopwatch');
    expect(forward.p.fake()).toMatchObject({ timerOpens: 1, timerStarts: 1, timerResets: 0 });
    expect(timerState(forward.p)).toMatchObject({ mode: 'forward', status: 'running' });
    const { p } = await startOn({
      ...PAUSED_COUNTDOWN(),
      status: 'idle',
      pauseMs: null,
      isUserPaused: false,
    });
    expect(p.phase()).toBe('active');
    expect(p.w.document.querySelector('[data-fake=opener]')?.getAttribute('aria-label')).toBe(
      'Timer',
    );
    expect(p.fake()).toMatchObject({ timerOpens: 1, timerStarts: 1, timerResets: 0 });
    expect(timerState(p)).toMatchObject({ mode: 'reverse', status: 'running' });
  });

  it('still starts when LeetCode’s pop-up closes after its reset', async () => {
    const { p } = await startOn(PAUSED_COUNTDOWN(), { resetCloses: true });
    expect(p.phase()).toBe('active');
    expect(p.fake()).toMatchObject({ timerResets: 1, timerOpens: 1, timerStarts: 1 });
  }, 15_000);

  it('names the control it couldn’t find, clicks nothing else, and a fixed selector works on Retry; debug mode records the timer’s controls', async () => {
    const { p, ext } = await startOn(null, { selectors: { timerStart: 'button[' }, debug: true });
    expect(p.phase()).toBe('failed');
    expect(p.text()).toContain('Start button (timerStart)');
    expect(p.text()).toContain('Continue without the timer');
    expect(p.fake()).toMatchObject({ resets: 1, timerStarts: 0, strays: 0 });
    const log = await until(() => {
      const l = ext.local.data.debugLog as
        Array<{ type: string; roleButtons?: Array<{ attrs: Record<string, string> }> }> | undefined;
      return l?.find((e) => e.type === 'controls');
    }, 6000);
    expect(log!.roleButtons!.map((b) => b.attrs['aria-label'])).toContain('Stopwatch');
    // The way the failed step took is logged too: opened the idle timer, never started it.
    const path = await until(() =>
      (
        ext.local.data.debugLog as Array<{ type: string; opened?: boolean; started?: boolean }>
      )?.find((e) => e.type === 'timer'),
    );
    expect(path).toMatchObject({ status: null, opened: true }); // no timer state: never used
    expect(path).not.toHaveProperty('started');
    await ext.local.remove('selectors'); // the fix, pasted in Options: back to the defaults
    await new Promise((res) => setTimeout(res, 100));
    p.tap('retry');
    await until(() => p.phase() === 'active', 8000);
    expect(p.fake()).toMatchObject({ resets: 1, timerStarts: 1, strays: 0 });
  }, 20_000);

  it('finds no reset button when the toolbar gains an icon, rather than clicking a neighbour', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    const extra = p.w.document.createElement('button');
    extra.addEventListener('click', () => p.fake().strays++);
    p.w.document.querySelector('[data-fake=toolbar]')!.prepend(extra);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'failed', 8000);
    expect(p.text()).toContain('Couldn’t find LeetCode’s reset button (editorReset)');
    expect(p.fake()).toMatchObject({ resets: 0, strays: 0 });
  });

  it('Retry after a failed confirm goes back to the reset once LeetCode’s dialog has gone, and repeats the confirm while it is open', async () => {
    const { p, ext } = await startOn(null, { selectors: { resetConfirm: '#gone' } });
    expect(p.phase()).toBe('failed');
    expect(p.text()).toContain('confirm button (resetConfirm)');
    const modal = () => p.w.document.querySelector('#editor [role="dialog"][aria-modal="true"]');
    expect(modal()).not.toBeNull(); // LeetCode's dialog is still asking; the streaks pop-over is beside it
    let resetClicks = 0;
    p.w.document.querySelector('[data-fake=reset]')!.addEventListener('click', () => resetClicks++);
    await ext.local.remove('selectors');
    await new Promise((res) => setTimeout(res, 100));
    p.tap('retry'); // the dialog is open: repeat the confirm, no second reset
    await until(() => p.phase() === 'active', 8000);
    expect(resetClicks).toBe(0);
    expect(p.fake().resets).toBe(1);

    // Again, with his own Cancel on LeetCode's dialog in between: Retry clicks the reset again.
    const again = await startOn(null, { selectors: { resetConfirm: '#gone' } });
    (again.p.w.document.querySelector('[data-fake=cancel]') as HTMLElement).click();
    let again2 = 0;
    again.p.w.document
      .querySelector('[data-fake=reset]')!
      .addEventListener('click', () => again2++);
    await again.ext.local.remove('selectors');
    await new Promise((res) => setTimeout(res, 100));
    again.p.tap('retry');
    await until(() => again.p.phase() === 'active', 8000);
    expect(again2).toBe(1);
    expect(again.p.fake()).toMatchObject({ resets: 1, strays: 0 });
  }, 30_000);
  it('says LeetCode’s timer didn’t ask to confirm its reset; Retry after our overlay dismissed its pop-up clicks Reset again, not the closing one', async () => {
    const { p, ext } = await startOn(PAUSED_COUNTDOWN(), {
      selectors: { timerResetConfirm: '#gone' },
    });
    expect(p.phase()).toBe('failed');
    expect(p.text()).toContain('didn’t ask to confirm its reset (timerResetConfirm)');
    expect(p.text()).toContain('Continue without the timer');
    const open = () => p.w.document.querySelector('#radix-_r_c_[data-state="open"] button');
    expect(open()?.textContent).toMatch(/^Reset /); // LeetCode's pop-up is still asking
    await ext.local.remove('selectors');
    await new Promise((res) => setTimeout(res, 100));
    p.tap('retry'); // the click on our overlay dismisses it: closing, still in the DOM, inert
    await until(() => p.phase() === 'active', 8000);
    // LeetCode's Reset was clicked again (twice in all), and the pop-up's Reset once — in the open one.
    expect(p.fake()).toMatchObject({
      timerResetClicks: 2,
      timerResets: 1,
      timerStarts: 1,
      strays: 0,
    });
    expect(timerState(p)).toMatchObject({ mode: 'reverse', status: 'running' });
  }, 20_000);

  it('a Retry that finds LeetCode’s pop-up still open and asking confirms it, without clicking Reset again', async () => {
    const { p, ext } = await startOn(PAUSED_COUNTDOWN(), {
      selectors: { timerResetConfirm: '#gone' },
    });
    expect(p.phase()).toBe('failed');
    p.fake().stickyPopup = true; // this time the pop-up stays put through the click on our overlay
    await ext.local.remove('selectors');
    await new Promise((res) => setTimeout(res, 100));
    p.tap('retry');
    await until(() => p.phase() === 'active', 8000);
    expect(p.fake()).toMatchObject({
      timerResetClicks: 1,
      timerResets: 1,
      timerStarts: 1,
      strays: 0,
    });
  }, 20_000);

  it('says LeetCode’s timer didn’t reset when its Reset never lands, and clicks no Start', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    p.fake().setTimer(PAUSED_COUNTDOWN());
    p.fake().resetInert = true;
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'failed', 8000);
    expect(p.text()).toContain('LeetCode’s timer didn’t reset.');
    expect(p.fake()).toMatchObject({ timerResets: 1, timerStarts: 0, strays: 0 });
  });

  it('a timer key turned off in Options says the timer isn’t configured and clicks none of its controls', async () => {
    const { p } = await startOn(RUNNING_STOPWATCH(), { selectors: { timerOpen: null } });
    expect(p.phase()).toBe('failed');
    expect(p.text()).toContain('LeetCode’s timer isn’t configured');
    expect(p.fake()).toMatchObject({ resets: 1, timerResets: 0, timerOpens: 0, timerStarts: 0 });
    p.tap('continue');
    await until(() => p.phase() === 'active');
  });

  it('names the new problem after Next, not the one the tab title still names, and Starts it under that name', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt' && p.text().includes('Two Sum'));
    p.fake().slowNext = true;
    (p.w.document.querySelector('[data-fake=next]') as HTMLElement).click();
    // The tab title still names Two Sum and no doc has come: the slug's name, never the last problem's.
    await until(() => p.text().includes('Add Two Numbers'));
    expect(p.w.document.title).toBe('Two Sum - LeetCode');
    expect(p.text()).not.toContain('Two Sum');
    // The tab title catches up: the overlay repaints with it.
    p.w.document.title = 'add two numbers - LeetCode';
    await until(() => p.text().includes('add two numbers'), 3000);
    // LeetCode's doc arrives: its name wins, and the overlay repaints again.
    p.fake().finishNext();
    await until(() => p.text().includes('Add Two Numbers'), 3000);
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(messages(ext, 'start').at(-1)!.body).toMatchObject({
      problemSlug: 'add-two-numbers',
      problemTitle: 'Add Two Numbers',
    });
  }, 20_000);

  it('Starts with no difficulty or tags rather than the last problem’s, while the page still shows it', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.fake().slowNext = true;
    (p.w.document.querySelector('[data-fake=next]') as HTMLElement).click();
    await until(() => p.text().includes('Add Two Numbers'));
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(messages(ext, 'start').at(-1)!.body).toMatchObject({
      problemSlug: 'add-two-numbers',
      problemTitle: 'Add Two Numbers',
      difficulty: null,
      topicTags: null,
    });
  }, 20_000);

  it('coming back to the tab re-sends LeetCode’s timer reading, so the badge learns of a Done marked in Aperture', async () => {
    const { p, ext } = await startOn(RUNNING_STOPWATCH());
    expect(p.phase()).toBe('active');
    const timers = () => sentEvents(ext).filter((e) => e.type === 'timer').length;
    await until(() => timers() >= 1, 8000);
    const before = timers();
    await new Promise((res) => setTimeout(res, 2500)); // the timer's reading is unchanged: nothing new goes
    expect(timers()).toBe(before);
    trustedFocus(p.w);
    await until(() => timers() > before, 8000);
    // Aperture's answer to that send ended the sitting (the background writes sync:<slug>): the badge says so.
    const b = ext.local.data['sitting:two-sum'] as { sittingId: string };
    await ext.local.set({ 'sync:two-sum': { sittingId: b.sittingId, status: 'ended' } });
    await until(() => p.phase() === 'ended');
    expect(p.badge()).toBe('Aperture · Sitting ended in Aperture');
  }, 30_000);

  it('reads the background’s word itself when Safari doesn’t pass its storage changes on: synced, then ended', async () => {
    const { p, ext } = await startOn(RUNNING_STOPWATCH());
    expect(p.phase()).toBe('active');
    const b = ext.local.data['sitting:two-sum'] as { sittingId: string };
    // Written behind the page's back: no onChanged reaches it, as in Safari.
    ext.local.data['sync:two-sum'] = {
      sittingId: b.sittingId,
      status: 'active',
      lastSyncAt: Date.now(),
    };
    await until(() => p.badge()?.includes('synced'), 8000);
    ext.local.data['sync:two-sum'] = { sittingId: b.sittingId, status: 'ended' };
    await until(() => p.phase() === 'ended', 8000);
    expect(p.badge()).toBe('Aperture · Sitting ended in Aperture');
  }, 30_000);

  const TAB_NOT_FOUND = 'Invalid call to runtime.sendMessage(). Tab not found.';
  const submitClick = (p: ReturnType<typeof open>) =>
    (p.w.document.querySelector('[data-e2e-locator=console-submit-button]') as HTMLElement).click();
  const ids = (ms: Msg[]) => ms.flatMap((m) => m.events!.map((e) => String(e.id)));

  it('retries a hand-off Safari refuses (Tab not found), in order, and every refused event lands once', async () => {
    const bg = fakeBackground();
    let refusals = 2;
    const refused: Msg[] = [];
    const delivered: Msg[] = [];
    const ext = fakeExtension({
      onMessage: (m) => {
        const msg = m as Msg;
        const hasSubmit = msg.type === 'enqueue' && msg.events!.some((e) => e.type === 'submit');
        if (hasSubmit && refusals > 0) {
          refusals--;
          refused.push(msg);
          // Safari's refusal, then a reply that isn't the background's {ok: true} (its storage write failed).
          if (refusals === 1) throw new Error(TAB_NOT_FOUND);
          return { ok: false, error: 'QuotaExceededError' };
        }
        if (msg.type === 'enqueue') delivered.push(msg);
        return bg.handle(msg);
      },
    });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    submitClick(p);
    await until(() => refused.length === 1, 8000);
    // A second submit while the first is still being retried: it waits its turn and lands after it.
    submitClick(p);
    await until(
      () => delivered.flatMap((m) => m.events!).filter((e) => e.type === 'submit').length === 2,
      8000,
    );
    expect(refused).toHaveLength(2);
    const got = ids(delivered);
    for (const id of ids(refused)) expect(got.filter((x) => x === id)).toHaveLength(1);
    const submits = delivered.flatMap((m) => m.events!).filter((e) => e.type === 'submit');
    expect(got.indexOf(String(submits[0]!.id))).toBeLessThan(got.indexOf(String(submits[1]!.id)));
    expect(p.badge()).not.toContain('reload this page');
  }, 30_000);

  it('keeps a hand-off every try refused, says to keep the tab open (not reload) until it lands, and sends it again on coming back', async () => {
    const bg = fakeBackground();
    let refuse = true;
    const delivered: Msg[] = [];
    const ext = fakeExtension({
      onMessage: (m) => {
        const msg = m as Msg;
        if (msg.type === 'enqueue' && refuse) throw new Error(TAB_NOT_FOUND);
        if (msg.type === 'enqueue') delivered.push(msg);
        return bg.handle(msg);
      },
    });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    submitClick(p);
    await until(() => p.badge()?.includes('events waiting'), 20_000);
    await new Promise((res) => setTimeout(res, 5500)); // past the badge's 5 s repaint: still says so
    // Not "reload": a reload would lose the kept events.
    expect(p.badge()).toBe(
      'Aperture · events waiting to reach the extension — retrying, keep this tab open',
    );
    // The extension itself gone (reloaded or updated): only then is a reload the way out.
    const runtime = ext.api.runtime as { id?: string };
    runtime.id = undefined;
    await until(() => p.badge()?.includes('the extension was reloaded — reload this page'), 7000);
    runtime.id = 'ext-id';
    // Taken out to try again, still refused: the badge keeps saying so through the retry waits.
    trustedFocus(p.w);
    await new Promise((res) => setTimeout(res, 1000));
    expect(p.badge()).toContain('events waiting');
    refuse = false;
    trustedFocus(p.w);
    // Behind any later batch still in its retry wait (at most 10 s), in order.
    await until(() => delivered.some((m) => m.events!.some((e) => e.type === 'submit')), 20_000);
    await until(() => !p.badge()?.includes('events waiting'), 3000);
  }, 75_000);
});

// The debug log's first entry of a type (Options → Debug mode on), once its 2 s flush has written it.
type DebugEntry = { type: string } & Record<string, unknown>;
const logged = (ext: ReturnType<typeof fakeExtension>, type: string) =>
  until(() => (ext.local.data.debugLog as DebugEntry[] | undefined)?.find((e) => e.type === type));

// The problem doc a fresh load renders into __NEXT_DATA__ (debug log 8, 2026-11-10): the statement and the
// companies on a Start Safari never sees LeetCode fetch a doc for. Values synthetic.
describe('the problem doc from the page', () => {
  const SSR = {
    title: 'Two Sum',
    titleSlug: 'two-sum',
    questionId: '1',
    questionFrontendId: '1',
    difficulty: 'Easy',
    topicTags: [{ name: 'Array', slug: 'array' }],
    content: '<p>Find <code>two</code> numbers.</p>',
    companyTagStatsV2: '{"three_months":[{"name":"Acme","timesEncountered":3}]}',
    codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: 'class Solution: pass' }],
  };
  const nextData = (question: Record<string, unknown>) => ({
    props: {
      pageProps: {
        dehydratedState: {
          queries: [
            { queryKey: ['globalData', {}], state: { data: {} } },
            {
              queryKey: ['questionDetail', { titleSlug: question.titleSlug }],
              state: { data: { question } },
            },
          ],
        },
      },
    },
  });
  const startOf = (ext: ReturnType<typeof fakeExtension>) =>
    messages(ext, 'start')[0]!.body as Record<string, unknown> & { problem: unknown };

  it('a fresh load’s Start carries the statement and the companies, read as the server reads them', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ debug: true });
    const p = open('/problems/two-sum/description/', ext, { nextData: nextData(SSR) });
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    const raw = startOf(ext).problem;
    expect(raw).toEqual(SSR); // whole: it fits the cap
    expect(startOf(ext)).toMatchObject({ frontendId: '1' }); // the page's, for display: no doc was fetched
    expect(problemStatementText({ raw })).toBe('Find two numbers.');
    expect(problemCompanies({ raw })).toEqual(['Acme']);
    expect(ext.local.data['sitting:two-sum']).toMatchObject({ problemSent: true });
    // The probe: sizes and shape only.
    expect(await logged(ext, 'pageDoc')).toMatchObject({
      when: 'load',
      chars: expect.any(Number), // the tag's length in characters, not bytes
      found: true,
      match: true,
      fit: 'whole',
      cleaned: 0,
    });
  }, 20_000);

  it('reads it at DOMContentLoaded when the scripts ran while the page was still loading, as in Safari', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ debug: true });
    const page = { ...SSR, title: 'Two Sum (page)' };
    const p = open('/problems/two-sum/', ext, { nextData: nextData(page), loading: true });
    await until(() => p.phase() === 'prompt');
    p.loaded();
    await until(() => p.text().includes('Two Sum (page)')); // read at load, before any Start
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(startOf(ext).problem).toEqual(page);
    expect(await logged(ext, 'pageDoc')).toMatchObject({
      when: 'load',
      readyState: 'interactive',
      found: true,
    });
  }, 20_000);

  it('takes the page’s display number only as up to six digits', async () => {
    for (const questionFrontendId of ['abc', '1234567', 12.5]) {
      const bg = fakeBackground();
      const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
      const p = open('/problems/two-sum/', ext, {
        nextData: nextData({ ...SSR, questionFrontendId }),
      });
      await until(() => p.phase() === 'prompt');
      p.tap('start');
      await until(() => p.phase() === 'active', 8000);
      expect(startOf(ext).frontendId, String(questionFrontendId)).toBeNull();
    }
  }, 30_000);

  it('an id the page made unprintable never stalls the Start', async () => {
    // The page's JSON parses to an own `toString: 0`, so String() of it throws inside startBody.
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext, {
      nextData: nextData({ ...SSR, questionFrontendId: { toString: 0 } }),
    });
    await until(() => p.phase() === 'prompt');
    p.w.localStorage.setItem('qd_solve_session:two-sum', '{"id":{"toString":0}}');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(startOf(ext)).toMatchObject({ frontendId: null, lcSolveSessionId: null });
  }, 20_000);

  it('a page doc A1 couldn’t store never blocks the Start: it goes cleaned, everything storable kept', async () => {
    const bg = fakeBackground(); // its Start runs A1’s normalizeSittingStart, which refuses an unstorable doc
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ debug: true });
    let nested: unknown = 'too deep';
    for (let i = 0; i < 25; i++) nested = [nested];
    const odd = { ...SSR, likes: 2 ** 53, acRate: 1e-200, envInfo: { nested }, hints: ['h'] };
    const p = open('/problems/two-sum/', ext, { nextData: nextData(odd) });
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    // Through JSON: the body was built in the page's realm, whose Array isn't this one's.
    const raw = JSON.parse(JSON.stringify(startOf(ext).problem)) as Record<string, unknown>;
    expect(raw).toMatchObject({
      content: SSR.content,
      hints: ['h'],
      envInfo: { nested: expect.any(Array) },
    });
    expect(raw).not.toHaveProperty('likes');
    expect(raw).not.toHaveProperty('acRate');
    expect(await logged(ext, 'pageDoc')).toMatchObject({ fit: 'whole', cleaned: 3 });
  }, 20_000);

  it('blank page values never block the Start: a blank solve session, blank tag links, a blank slug name', async () => {
    // The fake background runs A1’s normalizeSittingStart, which refuses a blank required text.
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext); // no doc: the tags come from the page's links
    await until(() => p.phase() === 'prompt');
    p.w.localStorage.setItem('qd_solve_session:two-sum', '{"id":"   "}');
    p.w.document.body.insertAdjacentHTML(
      'beforeend',
      '<a href="/tag/-"></a><a href="/tag/ "> </a>',
    );
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(startOf(ext)).toMatchObject({
      lcSolveSessionId: null,
      topicTags: ['Array', 'Hash Table'],
    });
    // A slug that humanizes to nothing, with no doc and a tab title for another problem: named by the slug.
    const bg2 = fakeBackground();
    const ext2 = fakeExtension({ onMessage: (m) => bg2.handle(m as Msg) });
    const q = open('/problems/-/', ext2);
    await until(() => q.phase() === 'prompt');
    q.tap('start');
    await until(() => q.phase() === 'active', 8000);
    expect(startOf(ext2)).toMatchObject({ problemSlug: '-', problemTitle: '-' });
  }, 30_000);

  it('a page doc for another problem is ignored, even once the address names it', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const forged = {
      ...SSR,
      title: 'Forged Name',
      titleSlug: 'add-two-numbers',
      content: '<p>f</p>',
    };
    const p = open('/problems/two-sum/', ext, { nextData: nextData(forged) });
    await until(() => p.phase() === 'prompt' && p.text().includes('Two Sum'));
    p.fake().slowNext = true; // no doc of its own comes for the next problem
    (p.w.document.querySelector('[data-fake=next]') as HTMLElement).click();
    await until(() => p.text().includes('Add Two Numbers'));
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(startOf(ext)).toMatchObject({
      problemSlug: 'add-two-numbers',
      problemTitle: 'Add Two Numbers',
      problem: null,
    });
    expect(p.text()).not.toContain('Forged Name');
  }, 20_000);

  it('LeetCode’s fetched doc wins over the page’s', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext, {
      nextData: nextData({ ...SSR, title: 'Two Sum (page)', questionFrontendId: '77' }),
    });
    await until(() => p.phase() === 'prompt' && p.text().includes('Two Sum (page)'));
    p.fake().fetchDoc();
    await until(() => !p.text().includes('(page)'));
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(startOf(ext)).toMatchObject({
      problemTitle: 'Two Sum',
      frontendId: '1', // the fetched doc's, over the page's 77
      problem: { title: 'Two Sum' },
    });
    expect(startOf(ext).problem).not.toHaveProperty('content'); // the fake server's doc has none
  }, 20_000);

  it('never takes a question id from the page: a forged one still lets the sitting’s snapshots through', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const forged = { ...SSR, questionId: '999', questionFrontendId: '999' };
    const p = open('/problems/two-sum/', ext, { nextData: nextData(forged) });
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    // The page's number is shown (display only); its question id is never taken.
    expect(startOf(ext)).toMatchObject({ frontendId: '999', problem: { questionId: '999' } });
    expect([null, '1']).toContain(startOf(ext).questionId);
    await until(
      () => (ext.local.data['sitting:two-sum'] as { questionId?: string }).questionId === '1',
    );
    const code = p.w.document.querySelector('[data-fake=code]') as HTMLTextAreaElement;
    code.value += 'return [0, 1]\n';
    code.dispatchEvent(new p.w.Event('input'));
    (p.w.document.querySelector('[data-e2e-locator=console-submit-button]') as HTMLElement).click();
    await until(() => sentEvents(ext).some((e) => e.type === 'snapshot'), 6000);
  }, 20_000);

  it('a reload fills in the doc a Start went without', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(ext.local.data['sitting:two-sum']).toMatchObject({ problemSent: false });
    const r = open('/problems/two-sum/', ext, { nextData: nextData(SSR) });
    await until(() => r.phase() === 'active', 6000);
    await until(() => messages(ext, 'start').some((m) => m.body!.problem));
    expect(messages(ext, 'start').at(-1)!.body).toMatchObject({
      problem: { content: SSR.content },
    });
    await until(() => (ext.local.data['sitting:two-sum'] as { problemSent?: boolean }).problemSent);
    expect(bg.sittings).toHaveLength(1);
  }, 20_000);

  it('a fill whose binding learns the question id meanwhile still marks the doc sent', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext, {
      nextData: nextData(SSR),
      loading: true,
      lateHint: true,
    });
    await until(() => p.phase() === 'prompt');
    p.tap('start'); // before the page's doc is parsed, and before LeetCode names the question
    await until(() => p.phase() === 'active', 8000);
    const bound = () =>
      ext.local.data['sitting:two-sum'] as { questionId?: string | null; problemSent?: boolean };
    expect(bound()).toMatchObject({ questionId: null, problemSent: false });
    let release = () => {};
    bg.hold = new Promise<void>((res) => (release = res));
    p.loaded(); // the page's doc → the fill, held
    await until(() => messages(ext, 'start').length === 2);
    p.fake().sendHint(); // LeetCode names the question mid-fill: the binding is rewritten
    await until(() => bound().questionId === '1');
    release();
    await until(() => bound().problemSent === true);
    expect(bound().questionId).toBe('1');
  }, 20_000);

  it('a doc that comes while Start is still going is sent once the sitting is active', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    let release = () => {};
    bg.hold = new Promise<void>((res) => (release = res));
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => messages(ext, 'start').length === 1); // its body went without a doc
    p.fake().fetchDoc(); // LeetCode's doc lands while Aperture is still answering
    await new Promise((res) => setTimeout(res, 300));
    release();
    await until(() => p.phase() === 'active', 8000);
    expect(startOf(ext).problem).toBeNull();
    await until(() => messages(ext, 'start').some((m) => m.body!.problem), 6000);
    expect(new Set(messages(ext, 'start').map((m) => m.body!.clientSittingId)).size).toBe(1);
  }, 20_000);
});

describe('the scrim', () => {
  it('hides the editor: near-solid, blurred under both names; its probe is logged', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ debug: true });
    const asked: string[] = [];
    const css = { supports: (prop: string, v: string) => (asked.push(`${prop}: ${v}`), true) };
    const p = open('/problems/two-sum/', ext, { css });
    await until(() => p.phase() === 'prompt');
    const scrim = p.style().match(/\.scrim \{[^}]*\}/)?.[0] ?? '';
    expect(scrim).toContain('background: rgba(12, 14, 18, 0.94)');
    expect(scrim).toContain('-webkit-backdrop-filter: blur(20px)');
    expect(scrim).toMatch(/[^-]backdrop-filter: blur\(20px\)/);
    expect(await logged(ext, 'scrim')).toMatchObject({
      supports: { std: true, webkit: true },
      computed: expect.any(Object),
    });
    expect(asked).toEqual(['backdrop-filter: blur(20px)', '-webkit-backdrop-filter: blur(20px)']);
  });
});

describe('the debug log’s wire probe', () => {
  // Counts the isolated world's calls to wire.opNames (the parse only the probe needs).
  const counting = (p: ReturnType<typeof open>) => {
    const wire = (p.w as unknown as { ApertureLC: { wire: { opNames: (t: unknown) => string[] } } })
      .ApertureLC.wire;
    const real = wire.opNames;
    const calls = { n: 0 };
    wire.opNames = (t) => (calls.n++, real(t));
    return calls;
  };
  const traffic = async (p: ReturnType<typeof open>) => {
    p.fake().fetchDoc();
    await new Promise((res) => setTimeout(res, 300));
  };

  it('parses a request’s operation names only with Debug mode on, and logs them', async () => {
    const off = fakeExtension({ onMessage: (m) => fakeBackground().handle(m as Msg) });
    const p = open('/problems/two-sum/', off);
    await until(() => p.phase() === 'prompt');
    const calls = counting(p);
    await traffic(p);
    expect(calls.n).toBe(0);

    const on = fakeExtension({ onMessage: (m) => fakeBackground().handle(m as Msg) });
    await on.local.set({ debug: true });
    const q = open('/problems/two-sum/', on);
    await until(() => q.phase() === 'prompt');
    const seen = counting(q);
    await traffic(q);
    expect(seen.n).toBeGreaterThan(0);
    const entry = await until(() =>
      (on.local.data.debugLog as DebugEntry[] | undefined)?.find(
        (e) => e.type === 'wire' && JSON.stringify(e.ops) === '["questionDetail"]',
      ),
    );
    expect(entry).toMatchObject({
      how: 'fetch:ok',
      req: expect.any(Number),
      res: expect.any(Number),
    });
  }, 20_000);
});
