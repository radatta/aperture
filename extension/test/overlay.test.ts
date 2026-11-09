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
const SELECTORS = {
  editorReset: '[data-fake=reset]',
  resetConfirm: '[data-fake=confirm]',
  timerClicks: ['[data-fake=timer-reset]', '[data-fake=timer-start]'],
};
type Msg = {
  type: string;
  body?: Record<string, unknown>;
  events?: Array<{ type: string; payload?: unknown }>;
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
    handle(msg: Msg) {
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

function open(path: string, ext: ReturnType<typeof fakeExtension>) {
  const dom = page(`https://leetcode.com${path}`, src('test/fixtures/fake-leetcode.html'));
  pages.push(dom);
  const w = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
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
  const fake = () => w.__fake as { resets: number; timerStarts: number; syncs: number };
  return { w, phase, text, button, tap, badge, fake };
}
const messages = (ext: ReturnType<typeof fakeExtension>, type: string) =>
  (ext.sent as Msg[]).filter((m) => m.type === type);
const sentEvents = (ext: ReturnType<typeof fakeExtension>) =>
  messages(ext, 'enqueue').flatMap((m) => m.events ?? []);

describe('the overlay on a LeetCode problem', () => {
  it('Start resets the editor, starts the timer and opens a sitting; capture flows; a reload resumes; a second problem is refused', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ selectors: SELECTORS });

    const p = open('/problems/two-sum/description/', ext);
    await until(() => p.phase() === 'prompt');
    p.tap('start');
    await until(() => p.phase() === 'active', 8000);
    expect(p.fake()).toMatchObject({ resets: 1, timerStarts: 1 });
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
    expect(r.fake().resets).toBe(0);
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
    await ext.local.set({ selectors: SELECTORS });
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
    expect(p.fake()).toMatchObject({ resets: 0, timerStarts: 0 });
    // Nor can the page read what the overlay says: its root is closed and its host carries no state.
    const host = p.w.document.querySelector('aperture-lc-overlay')!;
    expect(host.shadowRoot).toBeNull();
    expect(host.getAttribute('data-phase')).toBeNull();
  });

  it('keeps the sitting when a reload’s resume is refused for any reason but its end', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ selectors: SELECTORS });
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
    await ext.local.set({ selectors: SELECTORS });
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

  it('hands the pending snapshot over when the page is hidden', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ selectors: SELECTORS });
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
    expect(again.fake().resets).toBe(0);
    // Nothing is captured for a problem with no sitting.
    const code = again.w.document.querySelector('[data-fake=code]') as HTMLTextAreaElement;
    code.dispatchEvent(new again.w.Event('input'));
    await new Promise((res) => setTimeout(res, 800));
    expect(messages(ext, 'enqueue')).toEqual([]);
    expect(messages(ext, 'start')).toEqual([]);
  });
});
