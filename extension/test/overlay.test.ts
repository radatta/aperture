// Both worlds' real scripts (as the manifest loads them) over the fake LeetCode page in jsdom, with a fake
// extension API whose background answers like A1's server: the overlay's Start clicks LeetCode's own reset,
// confirm and timer; the binding resumes a reload; SPA navigation re-prompts.
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { JSDOM } from 'jsdom';
import { SITTING_ACTIVE_ERROR, isUlid, normalizeSittingStart } from '@aperture/shared';
import { ISOLATED_JS, MAIN_JS, fakeExtension, page, run, src, until } from './load';

const { createServer } = createRequire(import.meta.url)('./fixtures/fake-leetcode-server.js');
const SELECTORS = {
  editorReset: '[data-fake=reset]',
  resetConfirm: '[data-fake=confirm]',
  timerClicks: ['[data-fake=timer-reset]', '[data-fake=timer-start]'],
};
type Msg = { type: string; body?: Record<string, unknown>; events?: Array<{ type: string; payload?: unknown }>; slug?: string };

// The background, as far as content.js can tell: A1's Start (resume by clientSittingId, one open sitting).
function fakeBackground() {
  const sittings: Array<{ id: string; slug: string; clientSittingId: string; clientStartedAt: number; status: string }> = [];
  const dismissed = new Set<string>();
  let n = 0;
  return {
    sittings,
    handle(msg: Msg) {
      if (msg.type === 'dismiss') dismissed.add(String(msg.slug));
      if (msg.type === 'dismissed?') return { dismissed: dismissed.has(String(msg.slug)) };
      if (msg.type !== 'start') return { ok: true };
      const b = msg.body!;
      normalizeSittingStart(b as never); // what A1 refuses, this would throw on
      let s = sittings.find((x) => x.status === 'active' && x.slug === b.problemSlug);
      const other = sittings.find((x) => x.status === 'active' && x.slug !== b.problemSlug);
      if (!s && other) return { status: 400, json: { error: SITTING_ACTIVE_ERROR }, error: SITTING_ACTIVE_ERROR };
      const resumed = !!s;
      if (!s) {
        s = { id: `01SITTING0000000000000000${n++}`, slug: String(b.problemSlug), clientSittingId: String(b.clientSittingId), clientStartedAt: Number(b.startedAt), status: 'active' };
        sittings.push(s);
      }
      return {
        status: 200,
        json: {
          resumed,
          sitting: { ...s, problemSlug: s.slug, problemTitle: b.problemTitle, questionId: b.questionId },
        },
      };
    },
  };
}

const pages: JSDOM[] = [];
afterEach(() => {
  pages.splice(0).forEach((d) => d.window.close());
});

function open(path: string, ext: ReturnType<typeof fakeExtension>) {
  const dom = page(`https://leetcode.com${path}`, src('test/fixtures/fake-leetcode.html'));
  pages.push(dom);
  const w = dom.window as unknown as Window & Record<string, unknown>;
  const lc = createServer();
  const fetchFake = async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url, w.location.href);
    const body = init?.body != null ? String(init.body) : null;
    const r = lc.respond(url.pathname, init?.method ?? 'GET', body) ?? { status: 404, body: '{}' };
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  run(dom, MAIN_JS, { fetch: fetchFake });
  run(dom, ISOLATED_JS, { chrome: ext.api });
  run(dom, ['test/fixtures/fake-leetcode.js']);
  const host = () => w.document.querySelector('aperture-lc-overlay') as HTMLElement | null;
  const phase = () => host()?.getAttribute('data-phase');
  const button = (ap: string) => host()?.shadowRoot?.querySelector(`[data-ap=${ap}]`) as HTMLElement | null;
  const badge = () =>
    (w.document.querySelector('aperture-lc-badge') as HTMLElement | null)?.shadowRoot?.querySelector('[data-ap=badge]')?.textContent;
  const fake = () => w.__fake as { resets: number; timerStarts: number };
  return { w, phase, button, badge, fake };
}
const messages = (ext: ReturnType<typeof fakeExtension>, type: string) => (ext.sent as Msg[]).filter((m) => m.type === type);
const sentEvents = (ext: ReturnType<typeof fakeExtension>) => messages(ext, 'enqueue').flatMap((m) => m.events ?? []);

describe('the overlay on a LeetCode problem', () => {
  it('Start resets the editor, starts the timer and opens a sitting; capture flows; a reload resumes; a second problem is refused', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    await ext.local.set({ selectors: SELECTORS });

    const p = open('/problems/two-sum/description/', ext);
    await until(() => p.phase() === 'prompt');
    p.button('start')!.click();
    await until(() => p.phase() === 'active', 8000);
    expect(p.fake()).toMatchObject({ resets: 1, timerStarts: 1 });
    const [start] = messages(ext, 'start');
    expect(isUlid(String(start!.body!.clientSittingId))).toBe(true);
    expect(start!.body).toMatchObject({ problemSlug: 'two-sum', problemTitle: 'Two Sum', difficulty: 'Easy', topicTags: ['Array', 'Hash Table'], lang: 'Python3', questionId: '1' });
    await until(() => p.badge()?.startsWith('Aperture · 0m'));

    // Typing → a snapshot (coalesced ≤ 3 s); Submit → the judged submit at once; the timer read.
    const code = p.w.document.querySelector('[data-fake=code]') as HTMLTextAreaElement;
    code.value += 'return [0, 1]\n';
    code.dispatchEvent(new p.w.Event('input'));
    await until(() => sentEvents(ext).some((e) => e.type === 'snapshot' && (e.payload as { code: string }).code.includes('return [0, 1]')), 6000);
    (p.w.document.querySelector('[data-e2e-locator=console-submit-button]') as HTMLElement).click();
    await until(() => sentEvents(ext).some((e) => e.type === 'submit'), 6000);
    const submit = sentEvents(ext).find((e) => e.type === 'submit')!;
    expect(submit.payload).toMatchObject({ slug: 'two-sum', result: { state: 'SUCCESS', status_msg: 'Accepted' }, request: { typed_code: code.value } });
    await until(() => sentEvents(ext).some((e) => e.type === 'timer'), 6000);
    // LeetCode's questionDetail after the submit late-fills the problem doc with a repeat Start.
    await until(() => messages(ext, 'start').some((m) => m.body!.problem), 6000);
    expect(new Set(messages(ext, 'start').map((m) => m.body!.clientSittingId))).toEqual(new Set([start!.body!.clientSittingId]));

    // A reload mid-sitting: no overlay, no reset, the same sitting.
    const r = open('/problems/two-sum/description/', ext);
    await until(() => r.phase() === 'active', 6000);
    expect(r.fake().resets).toBe(0);
    expect(bg.sittings).toHaveLength(1);

    // "Next problem" (an SPA nav) re-prompts; its Start is refused while two-sum is open.
    (r.w.document.querySelector('[data-fake=next]') as HTMLElement).click();
    await until(() => r.phase() === 'prompt', 3000);
    r.button('start')!.click();
    await until(() => r.phase() === 'failed', 8000);
    expect(r.w.document.querySelector('aperture-lc-overlay')!.shadowRoot!.textContent).toContain(`${SITTING_ACTIVE_ERROR} Then Retry.`);
  }, 40_000);

  it('says LeetCode’s reset isn’t configured, and Start anyway opens the sitting without a clear', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.button('start')!.click();
    await until(() => p.phase() === 'failed');
    expect(p.w.document.querySelector('aperture-lc-overlay')!.shadowRoot!.textContent).toContain('reset button isn’t configured');
    p.button('anyway')!.click();
    await until(() => p.phase() === 'active');
    expect(p.fake().resets).toBe(0);
    expect(bg.sittings).toHaveLength(1);
  });

  it('Just looking dismisses without touching the editor, and is remembered for the problem', async () => {
    const bg = fakeBackground();
    const ext = fakeExtension({ onMessage: (m) => bg.handle(m as Msg) });
    const p = open('/problems/two-sum/', ext);
    await until(() => p.phase() === 'prompt');
    p.button('look')!.click();
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
