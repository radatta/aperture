// The real page-world script (page/tag.js + inject-main.js, as the manifest loads them) in a jsdom page,
// fed LeetCode's traffic over both transports. This test plays the isolated world's part exactly as
// content.js does: the handshake, the real relay's envelope check, the real wire parse, the relay's admit.
import { afterEach, describe, expect, it } from 'vitest';
import type { JSDOM } from 'jsdom';
import { MAIN_JS, lib, page, run, until } from './load';
import { T } from './fixtures/traffic';

const relayLib = lib('relay');
const wire = lib('wire');
type Pair = { url: string; reqText: string | null; resText: string };
// Each canned pair answers once, in order — the pending check, then the judged one, share a URL.
const byUrl = (pairs: Pair[]) => {
  const left = [...pairs];
  return (url: string, body: string | null) => {
    const i = left.findIndex((p) => p.url === url && (p.reqText === null || p.reqText === body));
    return i < 0 ? '{}' : left.splice(i, 1)[0]!.resText;
  };
};

let dom: JSDOM | null = null;
afterEach(() => dom?.window.close());

const ctx = { screenSlug: 'two-sum', binding: { questionId: '1', status: 'active' } };
function loadMain(pairs: Pair[]) {
  dom = page('https://leetcode.com/problems/two-sum/description/');
  const w = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  const answer = byUrl(pairs);
  const relay = relayLib.createRelay();
  const capture = wire.createCapture();
  const raws: Array<Record<string, unknown>> = [];
  const seqs: number[] = [];
  const admitted: Array<Record<string, unknown>> = [];
  const rejected: string[] = [];
  let chain = Promise.resolve();
  w.addEventListener('aperture-lc-hello', (e: Event) => {
    if (relay.hello((e as CustomEvent).detail))
      w.dispatchEvent(new w.CustomEvent('aperture-lc-ack'));
  });
  w.addEventListener('aperture-lc', (e: Event) => {
    const detail = (e as CustomEvent).detail;
    chain = chain.then(async () => {
      const r = await relay.accept(detail);
      if (!r.ok) {
        rejected.push(r.reason);
        return;
      }
      raws.push(r.raw);
      seqs.push(JSON.parse(JSON.parse(detail).body).seq);
      for (const item of capture.observe(r.raw)) {
        const a = relayLib.admit(item, ctx);
        if (a.ok) admitted.push(item);
        else rejected.push(a.reason);
      }
    });
  });
  // LeetCode's two transports: fetch …
  w.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const body =
      init?.body != null
        ? String(init.body)
        : typeof input === 'string'
          ? null
          : await input.text();
    return new Response(answer(url, body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  // … and XMLHttpRequest, its state behind prototype getters as in a browser.
  class FakeXHR extends (w.EventTarget as typeof EventTarget) {
    url = '';
    s = 0;
    text = '';
    get status() {
      return this.s;
    }
    get responseType() {
      return '';
    }
    get responseText() {
      return this.text;
    }
    open(_m: string, url: string) {
      this.url = url;
    }
    send(body: string | null) {
      setTimeout(() => {
        this.s = 200;
        this.text = answer(this.url, body ?? null);
        this.dispatchEvent(new w.Event('loadend'));
      }, 5);
    }
  }
  w.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  run(dom, MAIN_JS);
  const post = (p: Pair) => w.fetch(p.url, { method: 'POST', body: p.reqText ?? undefined });
  const xhr = (p: Pair) => {
    const x = new w.XMLHttpRequest();
    x.open(p.reqText ? 'POST' : 'GET', p.url);
    x.send(p.reqText);
  };
  return { w, raws, seqs, admitted, rejected, post, xhr };
}
const shape = (items: Array<Record<string, unknown>>) =>
  items.map(({ kind, slug, questionId, payload }) => ({ kind, slug, questionId, payload }));

describe('inject-main in a page', () => {
  it('ships every captured LeetCode shape raw, and the isolated world classifies it: Runs without /v2/, the replay string, questionDetail, submit pairing', async () => {
    const { w, raws, seqs, admitted, rejected, post, xhr } = loadMain(Object.values(T) as Pair[]);
    expect((w as Record<string, unknown>).ApertureLC).toBeUndefined(); // the lib never stays on the page
    await post(T.syncedCode);
    await post(T.updateSyncedCode);
    xhr(T.updateNote);
    xhr(T.replay);
    await post(T.questionDetail);
    await post(T.nextQuestionDetail);
    await post(T.unrelated);
    await post(T.submit);
    await w.fetch(T.submitPending.url);
    xhr(T.submitCheck);
    await post(T.submissionDetails);
    await w.fetch(new Request(T.run.url, { method: 'POST', body: T.run.reqText }));
    await w.fetch(T.runCheck.url);
    await w.fetch('https://example.com/graphql/', {
      method: 'POST',
      body: T.updateSyncedCode.reqText,
    });

    const kinds = await until(() => (admitted.length >= 8 ? admitted.map((m) => m.kind) : null));
    await until(() => rejected.length >= 1);
    expect(rejected).toEqual(['off-screen-slug']); // the next problem's prefetched doc: not on screen
    expect(new Set(kinds)).toEqual(
      new Set(['hint', 'snapshot', 'note', 'replay', 'problem', 'submit', 'submitDetails', 'run']),
    );
    expect(admitted.find((m) => m.kind === 'run')).toMatchObject({
      slug: 'two-sum',
      payload: { interpretId: 'runcode_1_2_x' },
    });
    expect(admitted.find((m) => m.kind === 'submit')).toMatchObject({
      payload: { submissionId: '900001', result: { status_msg: 'Wrong Answer' } },
    });
    expect(admitted.filter((m) => m.kind === 'problem').map((m) => m.slug)).toEqual(['two-sum']);
    // Raw text only, numbered in order; nothing for another host.
    for (const r of raws) {
      expect(typeof r.url).toBe('string');
      expect(['string', 'object']).toContain(typeof r.reqText);
      expect(typeof r.reqAt).toBe('number');
    }
    expect(raws.some((r) => String(r.url).includes('example.com'))).toBe(false);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('relays what LeetCode really sent when a page script patches Response, Promise and JSON after load', async () => {
    const replayAll = async (m: ReturnType<typeof loadMain>) => {
      await m.post(T.updateSyncedCode);
      await m.post(T.submit);
      m.xhr(T.submitCheck);
      return until(() => (m.admitted.length >= 2 ? shape(m.admitted) : null));
    };
    const pairs = [T.updateSyncedCode, T.submit, T.submitCheck] as Pair[];
    const clean = await replayAll(loadMain(pairs));
    dom!.window.close();

    const m = loadMain(pairs);
    const w = m.w as unknown as Record<
      string,
      { prototype: Record<string, unknown> } & Record<string, unknown>
    >;
    const realText = Response.prototype.text;
    try {
      // What a hostile LeetCode script could do once our capture is in place.
      w.Object!.prototype.toJSON = () => ({ v: 3, seq: 1, url: '/graphql/', reqText: 'forged' });
      w.Promise!.prototype.then = function () {
        throw new Error('patched then');
      };
      w.Array!.prototype.join = () => 'forged';
      w.String!.prototype.padStart = () => 'forged';
      (w.JSON as unknown as { stringify: unknown }).stringify = () => '"forged"';
      Response.prototype.text = async () => '{"forged":true}';
      const patched = await replayAll(m);
      expect(patched).toEqual(clean);
      expect(m.rejected).toEqual([]);
    } finally {
      Response.prototype.text = realText;
    }
  });

  it('never changes what the page gets back', async () => {
    const { w } = loadMain([T.questionDetail as Pair]);
    const res = await w.fetch(T.questionDetail.url, {
      method: 'POST',
      body: T.questionDetail.reqText,
    });
    expect(await res.json()).toEqual(JSON.parse(T.questionDetail.resText));
  });
});
