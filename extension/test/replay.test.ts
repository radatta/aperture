// The real page-world script (page/tag.js + page/wire.js + inject-main.js, as the manifest loads them) in a
// jsdom page, fed LeetCode's traffic over both transports; this test plays the isolated world's part of the
// handshake and checks every message with the real relay.
import { afterEach, describe, expect, it } from 'vitest';
import type { JSDOM } from 'jsdom';
import { MAIN_JS, lib, page, run, until } from './load';
import { T } from './fixtures/traffic';

const relayLib = lib('relay');
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

function loadMain(pairs: Pair[]) {
  dom = page('https://leetcode.com/problems/two-sum/description/');
  const w = dom.window as unknown as Window & Record<string, unknown>;
  const answer = byUrl(pairs);
  const relay = relayLib.createRelay();
  const accepted: Array<Record<string, unknown>> = [];
  const rejected: string[] = [];
  let chain = Promise.resolve();
  w.addEventListener('aperture-lc-hello', (e: Event) => {
    if (relay.hello((e as CustomEvent).detail)) w.dispatchEvent(new w.CustomEvent('aperture-lc-ack'));
  });
  w.addEventListener('aperture-lc', (e: Event) => {
    const detail = (e as CustomEvent).detail;
    chain = chain.then(async () => {
      const r = await relay.accept(detail, { screenSlug: 'two-sum', binding: { questionId: '1', status: 'active' } });
      if (r.ok) accepted.push(r.msg);
      else rejected.push(r.reason);
    });
  });
  // LeetCode's two transports: fetch …
  w.fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init?.body != null ? String(init.body) : typeof input === 'string' ? null : await input.text();
    return new Response(answer(url, body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  // … and XMLHttpRequest.
  class FakeXHR extends (w.EventTarget as typeof EventTarget) {
    url = '';
    status = 0;
    responseType = '';
    responseText = '';
    response: unknown = null;
    open(_m: string, url: string) {
      this.url = url;
    }
    send(body: string | null) {
      setTimeout(() => {
        this.status = 200;
        this.responseText = answer(this.url, body ?? null);
        this.dispatchEvent(new w.Event('loadend'));
      }, 5);
    }
  }
  w.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  run(dom, MAIN_JS);
  return { w, accepted, rejected };
}

describe('inject-main in a page', () => {
  it('classifies every captured LeetCode shape: Runs without /v2/, the replay string, questionDetail, submit pairing', async () => {
    const pairs = Object.values(T) as Pair[];
    const { w, accepted, rejected } = loadMain(pairs);
    expect((w as Record<string, unknown>).ApertureLC).toBeUndefined(); // the libs never stay on the page
    const post = (p: Pair) => w.fetch(p.url, { method: 'POST', body: p.reqText ?? undefined });
    const xhr = (p: Pair) => {
      const x = new w.XMLHttpRequest();
      x.open(p.reqText ? 'POST' : 'GET', p.url);
      x.send(p.reqText);
    };
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
    await w.fetch('https://example.com/graphql/', { method: 'POST', body: T.updateSyncedCode.reqText });

    const kinds = await until(() => (accepted.length >= 9 ? accepted.map((m) => m.kind) : null));
    expect(rejected).toEqual([]);
    expect(new Set(kinds)).toEqual(new Set(['hint', 'snapshot', 'note', 'replay', 'problem', 'submit', 'submitDetails', 'run']));
    expect(accepted.find((m) => m.kind === 'run')).toMatchObject({ slug: 'two-sum', payload: { interpretId: 'runcode_1_2_x' } });
    expect(accepted.find((m) => m.kind === 'submit')).toMatchObject({ payload: { submissionId: '900001', result: { status_msg: 'Wrong Answer' } } });
    expect(accepted.filter((m) => m.kind === 'problem').map((m) => m.slug)).toEqual(['two-sum', 'add-two-numbers']);
    expect(accepted.map((m) => m.seq)).toEqual(accepted.map((_, i) => i + 1));
  });

  it('never changes what the page gets back', async () => {
    const { w } = loadMain([T.questionDetail as Pair]);
    const res = await w.fetch(T.questionDetail.url, { method: 'POST', body: T.questionDetail.reqText });
    expect(await res.json()).toEqual(JSON.parse(T.questionDetail.resText));
  });
});
