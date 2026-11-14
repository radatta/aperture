// The real page-world script (page/tag.js + inject-main.js, as the manifest loads them) in a jsdom page,
// fed LeetCode's traffic over both transports. This test plays the isolated world's part exactly as
// content.js does: the handshake, the real relay's envelope check, the real wire parse, the relay's admit.
import { afterEach, describe, expect, it } from 'vitest';
import type { JSDOM } from 'jsdom';
import { FetchedResponse, MAIN_JS, fakeXHR, lib, page, run, until } from './load';
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
function loadMain(
  pairs: Pair[],
  respond?: (url: string) => Response | null,
  opts: {
    xhrType?: string; // what LeetCode sets responseType to on its XHRs
    blobOf?: (text: string, w: Window & typeof globalThis) => unknown; // the fake XHR's blob (load.ts)
    before?: (w: Window & typeof globalThis) => void; // the page as it is before our scripts load
  } = {},
) {
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
    const own = respond?.(url);
    if (own) return own;
    const body =
      init?.body != null
        ? String(init.body)
        : typeof input === 'string'
          ? null
          : await input.text();
    return new FetchedResponse(answer(url, body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      url: new URL(url, 'https://leetcode.com').href,
    });
  }) as unknown as typeof fetch;
  // … and XMLHttpRequest.
  w.XMLHttpRequest = fakeXHR(w, answer, {
    blobOf: opts.blobOf,
  }) as unknown as typeof XMLHttpRequest;
  opts.before?.(w);
  run(dom, MAIN_JS);
  const post = (p: Pair) => w.fetch(p.url, { method: 'POST', body: p.reqText ?? undefined });
  // `prep` runs between open and send, where a page sets responseType.
  const xhr = (p: Pair, prep?: (x: XMLHttpRequest) => void) => {
    const x = new w.XMLHttpRequest();
    x.open(p.reqText ? 'POST' : 'GET', p.url);
    if (opts.xhrType) x.responseType = opts.xhrType as XMLHttpRequestResponseType;
    prep?.(x);
    x.send(p.reqText);
    return x;
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

  it('ignores a Response the page built or one from another origin, and keeps then pinned', async () => {
    const check = T.submitCheck.url;
    const m = loadMain([T.submit as Pair], (url) =>
      url === check
        ? new Response(T.submitCheck.resText, { status: 200 }) // built by a page script: type 'default'
        : url.includes('interpret_solution')
          ? new FetchedResponse('{"interpret_id":"runcode_9"}', {
              status: 200,
              url: 'https://evil.example/problems/two-sum/interpret_solution/', // a <base href> elsewhere
            })
          : null,
    );
    await m.post(T.submit);
    await m.w.fetch(check);
    await m.post(T.run);
    await m.post(T.updateSyncedCode); // a real one still goes, so the relay is known to be listening
    await until(() => m.raws.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(m.raws.map((r) => r.url).sort()).toEqual([
      'https://leetcode.com/graphql/',
      'https://leetcode.com/problems/two-sum/submit/',
    ]);
    const proto = (m.w as unknown as { Response: { prototype: object } }).Response.prototype;
    expect(() =>
      Object.defineProperty(proto, 'then', { value: (ok: (v: unknown) => void) => ok(null) }),
    ).toThrow();
  });

  it('never changes what the page gets back', async () => {
    const { w } = loadMain([T.questionDetail as Pair]);
    const res = await w.fetch(T.questionDetail.url, {
      method: 'POST',
      body: T.questionDetail.reqText,
    });
    expect(await res.json()).toEqual(JSON.parse(T.questionDetail.resText));
  });

  it('says how it read each response, for the debug log’s probe — a few fixed words, no content', async () => {
    let first = true;
    // A Response whose body is already being read: its clone throws, as a failed one would in Safari.
    const used = () => {
      if (!first) return null;
      first = false;
      const r = new FetchedResponse(T.questionDetail.resText, {
        status: 200,
        url: 'https://leetcode.com/graphql/',
      });
      void r.text();
      return r;
    };
    const m = loadMain([T.questionDetail, T.questionDetail, T.unrelated] as Pair[], used);
    await m.post(T.questionDetail);
    await m.post(T.questionDetail);
    await m.post(T.unrelated);
    await until(() => m.raws.length >= 3);
    // Each with its body or without it, as its word says (the read one lands last).
    expect(Object.fromEntries(m.raws.map((r) => [r.how, r.resText !== null]))).toEqual({
      'fetch:no-clone': false,
      'fetch:ok': true,
      'fetch:skip': false,
    });
    dom!.window.close();

    // A type with no plain text to read (never seen from LeetCode) goes without its body, named.
    for (const xhrType of ['json', 'document', 'arraybuffer']) {
      const x = loadMain([T.questionDetail, T.updateNote] as Pair[], undefined, { xhrType });
      x.xhr(T.questionDetail);
      x.xhr(T.updateNote);
      expect(await until(() => (x.raws.length >= 2 ? x.raws.map((r) => r.how) : null))).toEqual([
        `xhr:type-${xhrType}`,
        'xhr:skip',
      ]);
      expect(x.raws[0]!.resText).toBeNull();
      dom!.window.close();
    }
  });
});

// Safari sends LeetCode's questionDetail and submissionDetails as XHRs with responseType 'blob' (debug log 9).
describe('inject-main over blob XHRs', () => {
  const RAW_MAX = relayLib.RAW_MAX as number;
  const settle = () => new Promise((r) => setTimeout(r, 100));
  const pairs = (m: ReturnType<typeof loadMain>) =>
    m.raws.map((r) => [r.reqText, r.resText, r.how]).sort();

  it('reads a blob XHR’s response as text, as Safari sends LeetCode’s GraphQL', async () => {
    const m = loadMain([T.questionDetail, T.submissionDetails] as Pair[], undefined, {
      xhrType: 'blob',
    });
    const x = m.xhr(T.questionDetail);
    m.xhr(T.submissionDetails);
    await until(() => m.admitted.length >= 2);
    expect(pairs(m)).toEqual(
      [
        [T.questionDetail.reqText, T.questionDetail.resText, 'xhr:blob-ok'],
        [T.submissionDetails.reqText, T.submissionDetails.resText, 'xhr:blob-ok'],
      ].sort(),
    );
    expect(shape(m.admitted).sort((a, b) => String(a.kind).localeCompare(String(b.kind)))).toEqual([
      {
        kind: 'problem',
        slug: 'two-sum',
        questionId: '1',
        payload: expect.objectContaining({ title: 'Two Sum' }),
      },
      {
        kind: 'submitDetails',
        slug: 'two-sum',
        questionId: null,
        payload: expect.objectContaining({ submissionId: '900001' }),
      },
    ]);
    expect(m.rejected).toEqual([]);
    // The page's own read: the one Blob, whole.
    expect(x.response).toBe(x.response);
    expect(await (x.response as Blob).text()).toBe(T.questionDetail.resText);
  });

  it('sends a blob XHR without its body when it is empty, too big or not a Blob, and says which', async () => {
    const reads: number[] = [];
    const at = (resText: string) => ({ ...T.questionDetail, resText }) as Pair;
    const cases = [
      '',
      'x'.repeat(RAW_MAX),
      'x'.repeat(RAW_MAX + 1),
      'NULL',
      'NOT-A-BLOB',
      'not json',
    ];
    const m = loadMain(cases.map(at), undefined, {
      xhrType: 'blob',
      // A null response (as after an error) and a look-alike that isn't a Blob.
      blobOf: (text, w) =>
        text === 'NULL'
          ? null
          : text === 'NOT-A-BLOB'
            ? { size: 10, text: async () => T.questionDetail.resText }
            : new w.Blob([text]),
      before: (w) => {
        const real = w.Blob.prototype.text;
        w.Blob.prototype.text = function (this: Blob) {
          reads.push(this.size);
          return real.call(this);
        };
      },
    });
    cases.forEach(() => m.xhr(T.questionDetail as Pair));
    await until(() => m.raws.length >= cases.length);
    await settle();
    expect(
      m.raws.map((r) => [r.how, r.resText === null ? null : String(r.resText).length]).sort(),
    ).toEqual(
      [
        ['xhr:blob-empty', null],
        ['xhr:blob-ok', RAW_MAX], // exactly at the cap: read and sent
        ['xhr:blob-big', null],
        ['xhr:blob-none', null],
        ['xhr:blob-none', null],
        ['xhr:blob-ok', 8], // not JSON: sent, and nothing in it
      ].sort(),
    );
    expect(reads.sort((a, b) => a - b)).toEqual([8, RAW_MAX]); // the big and empty ones are never read
    expect(m.admitted).toEqual([]);
    expect(m.rejected).toEqual([]);
  });

  it('says the read failed when a blob’s text never comes, and keeps relaying', async () => {
    const fails = new WeakMap<object, 'reject' | 'throw'>();
    const at = (resText: string) => ({ ...T.questionDetail, resText }) as Pair;
    const m = loadMain([at('REJECT'), at('THROW'), T.questionDetail as Pair], undefined, {
      xhrType: 'blob',
      blobOf: (text, w) => {
        const b = new w.Blob([text]);
        if (text === 'REJECT' || text === 'THROW')
          fails.set(b, text === 'REJECT' ? 'reject' : 'throw');
        return b;
      },
      // The browser's own text() failing: a read error, or one that throws outright.
      before: (w) => {
        const real = w.Blob.prototype.text;
        w.Blob.prototype.text = function (this: Blob) {
          const f = fails.get(this);
          if (f === 'throw') throw new w.DOMException('read', 'NotReadableError');
          if (f === 'reject')
            return w.Promise.reject(new w.DOMException('read', 'NotReadableError'));
          return real.call(this);
        };
      },
    });
    m.xhr(T.questionDetail as Pair);
    m.xhr(T.questionDetail as Pair);
    await until(() => m.raws.length >= 2);
    expect(m.raws.map((r) => [r.how, r.resText])).toEqual([
      ['xhr:blob-read-fail', null],
      ['xhr:blob-read-fail', null],
    ]);
    m.xhr(T.questionDetail as Pair);
    await until(() => m.admitted.length >= 1);
    expect(m.raws.map((r) => r.how)).toEqual([
      'xhr:blob-read-fail',
      'xhr:blob-read-fail',
      'xhr:blob-ok',
    ]);
    expect(shape(m.admitted)).toMatchObject([{ kind: 'problem', slug: 'two-sum' }]);
  });

  it('relays the real blob when a page script patches Blob, FileReader and XMLHttpRequest after load', async () => {
    const replayAll = async (
      m: ReturnType<typeof loadMain>,
      prep?: (x: XMLHttpRequest) => void,
    ) => {
      m.xhr(T.questionDetail as Pair, prep);
      m.xhr(T.submissionDetails as Pair, prep);
      await until(() => m.admitted.length >= 2);
      await settle();
      return { items: shape(m.admitted), raws: pairs(m) };
    };
    const list = [T.questionDetail, T.submissionDetails] as Pair[];
    const clean = await replayAll(loadMain(list, undefined, { xhrType: 'blob' }));
    dom!.window.close();

    const m = loadMain(list, undefined, { xhrType: 'blob' });
    const w = m.w as unknown as Window & typeof globalThis;
    const forged = JSON.stringify({
      data: { question: { title: 'Forged', titleSlug: 'two-sum', questionId: '999' } },
    });
    // What a hostile LeetCode script could do once our capture is in place.
    w.Blob.prototype.text = async () => forged;
    Object.defineProperty(w.Blob.prototype, 'size', { get: () => 0, configurable: true }); // "empty"
    w.FileReader = class {
      readAsText() {
        throw new Error('patched FileReader');
      }
    } as unknown as typeof FileReader;
    Object.defineProperty(w.XMLHttpRequest.prototype, 'response', {
      get: () => new w.Blob([forged]),
      configurable: true,
    });
    w.Promise.prototype.then = function () {
      throw new Error('patched then');
    };
    const patched = await replayAll(m, (x) =>
      Object.defineProperty(x, 'response', { value: new w.Blob([forged]) }),
    );
    expect(patched).toEqual(clean);
    expect(m.rejected).toEqual([]);
  });

  it('keeps each request with its own response when an XHR is sent again before the blob is read', async () => {
    // Text XHRs too: the same listener, and the same reuse.
    for (const xhrType of ['blob', '']) {
      const m = loadMain(
        [T.questionDetail, T.submissionDetails, T.questionDetail] as Pair[],
        undefined,
        { xhrType },
      );
      const again = (x: XMLHttpRequest, p: Pair) => {
        x.open('POST', p.url);
        if (xhrType) x.responseType = xhrType as XMLHttpRequestResponseType;
        x.send(p.reqText);
      };
      const x = m.xhr(T.questionDetail as Pair);
      // LeetCode's own listener, after ours: it sends the XHR again before our read of the first settles.
      x.addEventListener('loadend', () => again(x, T.submissionDetails as Pair), { once: true });
      await until(() => m.raws.length >= 2);
      await settle();
      again(x, T.questionDetail as Pair); // and once more, after both have landed
      await until(() => m.raws.length >= 3);
      await settle();
      const how = xhrType ? 'xhr:blob-ok' : 'xhr:ok';
      expect(pairs(m), xhrType || 'text').toEqual(
        [
          [T.questionDetail.reqText, T.questionDetail.resText, how],
          [T.questionDetail.reqText, T.questionDetail.resText, how],
          [T.submissionDetails.reqText, T.submissionDetails.resText, how],
        ].sort(),
      );
      dom!.window.close();
    }
  });
});
