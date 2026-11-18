import { describe, expect, it } from 'vitest';
import {
  isUlid,
  normalizeSittingEvents,
  normalizeSittingStart,
  payloadError,
  problemCompanies,
} from '@aperture/shared';
import { lib } from './load';
import { CODE, QID, SLUG, T } from './fixtures/traffic';

const wire = lib('wire');
const ulid = lib('ulid');
type Pair = { url: string; reqText: string | null; resText: string | null };
const seen = (capture: { observe(x: object): unknown[] }, p: Pair, at = 1000) =>
  capture.observe({
    url: p.url,
    reqText: p.reqText,
    resText: p.resText,
    reqAt: at,
    resAt: at + 50,
  });

describe('wire: what LeetCode traffic means', () => {
  it('reads only LeetCode paths, and only the requests it uses', () => {
    expect(wire.interesting('https://leetcode.com/graphql/')).toBe(true);
    expect(wire.interesting('/graphql/')).toBe(true);
    expect(wire.interesting(`https://leetcode.com/problems/${SLUG}/submit/`)).toBe(true);
    expect(wire.interesting('https://leetcode.com/submissions/detail/runcode_1/check/')).toBe(true);
    expect(wire.interesting('https://leetcode.com/submissions/detail/9/v2/check/')).toBe(true);
    expect(wire.interesting('https://evil.example/graphql/')).toBe(false);
    expect(wire.interesting('https://leetcode.com/problems/two-sum/description/')).toBe(false);
    expect(wire.wantsResponse(T.questionDetail.url, T.questionDetail.reqText)).toBe(true);
    expect(wire.wantsResponse(T.updateSyncedCode.url, T.updateSyncedCode.reqText)).toBe(false);
  });

  it('turns each GraphQL operation into its item, and ignores the rest', () => {
    const c = wire.createCapture();
    expect(seen(c, T.updateSyncedCode)).toEqual([
      {
        kind: 'snapshot',
        slug: null,
        questionId: QID,
        at: 1000,
        payload: { code: CODE, questionId: QID, lang: '11' },
        page: null,
      },
    ]);
    expect(seen(c, T.syncedCode)).toMatchObject([{ kind: 'hint', questionId: QID }]);
    expect(seen(c, T.updateNote)).toMatchObject([
      { kind: 'note', slug: SLUG, payload: { slug: SLUG, content: 'use a map' } },
    ]);
    const [replay] = seen(c, T.replay) as Array<Record<string, unknown>>;
    expect(replay).toMatchObject({ kind: 'replay', slug: SLUG, clientSessionId: 'practice-0000' });
    expect(typeof replay!.events).toBe('string');
    const [problem] = seen(c, T.questionDetail) as Array<Record<string, unknown>>;
    expect(problem).toMatchObject({ kind: 'problem', slug: SLUG, questionId: QID, at: 1050 });
    expect(problemCompanies({ raw: problem!.payload })).toEqual(['Acme']); // read as the server reads it
    expect(seen(c, T.submissionDetails)).toMatchObject([
      { kind: 'submitDetails', slug: SLUG, payload: { submissionId: '900001' } },
    ]);
    expect(seen(c, T.unrelated)).toEqual([]);
    expect(seen(c, { ...T.updateSyncedCode, reqText: '{not json' })).toEqual([]);
  });

  it('pairs a submit with its /v2/check/ SUCCESS once, at the submit’s time; the /submit/ itself says a submit was made', () => {
    const c = wire.createCapture();
    // Local only (the resubmit note): no payload, the request's time, the page it came from.
    expect(seen(c, T.submit, 1000)).toEqual([
      { kind: 'submitted', slug: SLUG, questionId: null, at: 1000, payload: null, page: null },
    ]);
    expect(seen(c, T.submitPending, 2000)).toEqual([]);
    const out = seen(c, T.submitCheck, 3000);
    expect(out).toMatchObject([
      {
        kind: 'submit',
        slug: SLUG,
        at: 1000,
        payload: {
          submissionId: '900001',
          request: { typed_code: CODE },
          result: { status_msg: 'Wrong Answer' },
        },
      },
    ]);
    expect(seen(c, T.submitCheck, 4000)).toEqual([]); // LeetCode polls again: still once
  });

  it('says nothing for a /submit/ with no id or an unreadable body, or for a Run', () => {
    const c = wire.createCapture();
    expect(seen(c, { ...T.submit, resText: '{}' })).toEqual([]);
    expect(seen(c, { ...T.submit, resText: '{not json' })).toEqual([]);
    expect(seen(c, { ...T.submit, resText: null })).toEqual([]);
    expect(seen(c, T.run)).toEqual([]);
  });

  it('a repeated /submit/ response for an id still pending, or already judged, says nothing twice', () => {
    const c = wire.createCapture();
    expect(seen(c, T.submit, 1000)).toHaveLength(1);
    expect(seen(c, T.submit, 1100)).toEqual([]); // pending
    expect(seen(c, T.submitCheck, 3000)).toMatchObject([{ kind: 'submit', at: 1100 }]);
    expect(seen(c, T.submit, 4000)).toEqual([]); // judged
  });

  it('a submitted item makes no event', () => {
    const [item] = seen(wire.createCapture(), T.submit);
    expect(wire.toEventInputs(item, ulid.ulid)).toEqual([]);
    expect(wire.SENDABLE).not.toContain('submitted');
    expect(wire.LOCAL).toEqual(['submitted']);
  });

  it('pairs a Run with its /check/ that has no /v2/', () => {
    const c = wire.createCapture();
    seen(c, T.run, 1000);
    expect(seen(c, T.runCheck, 1500)).toMatchObject([
      {
        kind: 'run',
        slug: SLUG,
        at: 1000,
        payload: { interpretId: 'runcode_1_2_x', result: { status_msg: 'Accepted' } },
      },
    ]);
  });

  it('sends a submit LeetCode never judged after two minutes, marked pending', () => {
    const c = wire.createCapture();
    seen(c, T.submit, 1000);
    expect(c.sweep(1000 + wire.PAIR_TIMEOUT_MS)).toEqual([]);
    expect(c.sweep(1001 + wire.PAIR_TIMEOUT_MS)).toMatchObject([
      { kind: 'submit', payload: { result: { pending: true } } },
    ]);
    expect(seen(c, T.submitCheck, 999_999)).toEqual([]);
  });

  it('makes events A1 accepts', () => {
    const c = wire.createCapture();
    const items = [
      ...seen(c, T.updateSyncedCode),
      ...seen(c, T.updateNote),
      ...seen(c, T.replay),
      ...seen(c, T.submissionDetails),
      ...(seen(c, T.submit), seen(c, T.submitCheck)),
    ];
    const events = items.flatMap((i) => wire.toEventInputs(i, ulid.ulid));
    expect(events.every((e: { id: string }) => isUlid(e.id))).toBe(true);
    const n = normalizeSittingEvents({ sittingId: ulid.ulid(), events });
    expect(n.events.map((e) => e.type)).toEqual([
      'snapshot',
      'note',
      'replay',
      'submitDetails',
      'submit',
    ]);
  });

  it('splits a replay over 60 KB along its array, and drops one that isn’t an array', () => {
    const big = JSON.stringify(
      Array.from({ length: 2000 }, (_, i) => ({ type: 7, ts: i, text: 'x'.repeat(40) })),
    );
    const parts = wire.splitReplay(big);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p: string) => wire.bytes(p) <= 60 * 1024)).toBe(true);
    expect(parts.flatMap((p: string) => JSON.parse(p))).toHaveLength(2000);
    expect(wire.splitReplay('x'.repeat(70 * 1024))).toEqual([]);
  });

  // __NEXT_DATA__ as a fresh load carries it (debug log 8, 2026-11-10; values synthetic).
  const nextData = (question: unknown, keySlug = SLUG) =>
    JSON.stringify({
      props: {
        pageProps: {
          dehydratedState: {
            queries: [
              { queryKey: ['globalData', {}], state: { data: { userStatus: {} } } },
              {
                queryKey: ['questionDetail', { titleSlug: keySlug }],
                state: { data: { question } },
              },
            ],
          },
        },
      },
    });
  const question = { title: 'Two Sum', titleSlug: SLUG, questionId: QID, content: '<p>x</p>' };

  it('finds the problem doc a page renders into __NEXT_DATA__, only when its key names it', () => {
    expect(wire.pageProblem(nextData(question))).toEqual(question);
    expect(wire.pageProblem(nextData(question, 'add-two-numbers'))).toBeNull();
    expect(wire.pageProblem(nextData({ ...question, titleSlug: 7 }))).toBeNull();
    for (const junk of [null, '', '{not json', '[]', '{"props":{}}', nextData(null), nextData([1])])
      expect(wire.pageProblem(junk)).toBeNull();
  });

  it('fits a doc to the cap: whole when it fits, else the fields A1 reads, else nothing', () => {
    const doc = {
      ...question,
      questionFrontendId: '1',
      difficulty: 'Easy',
      topicTags: [{ name: 'Array', slug: 'array' }],
      companyTagStatsV2: '{}',
      codeSnippets: [{ lang: 'Python3', code: 'x'.repeat(70 * 1024) }],
    };
    const small = { ...doc, codeSnippets: [] };
    expect(wire.fitProblem(small, 64 * 1024)).toEqual(small); // a cleaned copy
    const slim = wire.fitProblem(doc, 64 * 1024);
    expect(Object.keys(slim).sort()).toEqual(
      ['title', 'titleSlug', 'questionId', 'questionFrontendId', 'difficulty', 'topicTags']
        .concat(['content', 'companyTagStatsV2'])
        .sort(),
    );
    expect(wire.fitProblem({ ...doc, content: 'x'.repeat(70 * 1024) }, 64 * 1024)).toBeNull();
    expect(wire.fitProblem(null, 64 * 1024)).toBeNull();
    expect(wire.fitProblem([doc], 64 * 1024)).toBeNull();
  });

  it('names a request’s GraphQL operations for the debug log, and nothing else', () => {
    expect(wire.opNames(T.questionDetail.reqText)).toEqual(['questionDetail']);
    expect(wire.opNames(JSON.stringify([{ operationName: 'a' }, { operationName: 'b' }]))).toEqual([
      'a',
      'b',
    ]);
    // The page writes these: anything not shaped as a GraphQL name is left out.
    const named = (n: unknown) => JSON.stringify({ operationName: n });
    for (const bad of ['<img src=x>', 'a b', '9lives', 'x'.repeat(41), 7])
      expect(wire.opNames(named(bad))).toEqual([]);
    expect(wire.opNames(named('_ok_9'))).toEqual(['_ok_9']);
    expect(wire.opNames(T.submit.reqText)).toEqual([]);
    expect(wire.opNames(null)).toEqual([]);
  });

  describe('cleanProblem: a doc made storable by A1’s own rule (payloadError)', () => {
    // A leaf at `depth` from the doc (the doc itself is depth 0): { k: [[…['x']…]] }.
    const deep = (depth: number, leaf: unknown = 'x') => {
      let v: unknown = leaf;
      for (let i = 1; i < depth; i++) v = [v];
      return { k: v };
    };
    it('keeps a value at depth 20 and drops one at 21, from arrays and objects alike', () => {
      expect(wire.cleanProblem(deep(20))).toEqual({ doc: deep(20), dropped: 0 });
      expect(wire.cleanProblem(deep(21))).toEqual({ doc: deep(20, []), dropped: 1 });
      // An object at depth 20 keeps its place, emptied of what sits at 21.
      let o: Record<string, unknown> = { leaf: 1 };
      for (let i = 1; i < 20; i++) o = { o };
      const { doc } = wire.cleanProblem({ o });
      let at = doc as Record<string, unknown>;
      for (let i = 0; i < 20; i++) at = at.o as Record<string, unknown>;
      expect(at).toEqual({});
    });
    it('drops each kind of number A1 can’t store, and keeps zero and the rest', () => {
      const doc = {
        inf: 1e308 * 10,
        negInf: -1e308 * 10,
        nan: Number.NaN,
        big: 2 ** 53,
        tiny: 1e-200,
        negTiny: -1e-200,
        zero: 0,
        max: Number.MAX_SAFE_INTEGER,
        small: 1e-130,
        frac: 34.5,
        list: [1, 2 ** 53, 0, 1e-200, -3, { n: 1e-200, ok: 'y' }],
      };
      expect(wire.cleanProblem(doc)).toEqual({
        doc: {
          zero: 0,
          max: Number.MAX_SAFE_INTEGER,
          small: 1e-130,
          frac: 34.5,
          list: [1, 0, -3, { ok: 'y' }],
        },
        dropped: 9,
      });
    });
    it('passes a real-shaped doc through unchanged, every extra field kept', () => {
      const doc = {
        questionId: '15',
        questionFrontendId: '15',
        title: '3Sum',
        titleSlug: '3sum',
        content: '<p>Given an integer array…</p>',
        difficulty: 'Medium',
        likes: 33012,
        isPaidOnly: false,
        hints: ['So, we essentially need to find three numbers x, y, and z…'],
        similarQuestionList: [{ title: 'Two Sum', titleSlug: 'two-sum', difficulty: 'Easy' }],
        topicTags: [{ name: 'Array', slug: 'array' }],
        codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: 'class Solution:' }],
        exampleTestcaseList: ['[-1,0,1,2,-1,-4]', '[0,1,1]'],
        stats: '{"totalAccepted": "4.4M", "acRate": "37.1%"}',
        envInfo: '{"python3": ["Python3", "<p>Python 3.11</p>"]}',
        companyTagStatsV2: '{"three_months":[]}',
        status: null,
      };
      expect(wire.cleanProblem(doc)).toEqual({ doc, dropped: 0 });
      expect(wire.fitProblem(doc, 64 * 1024)).toEqual(doc);
    });
    it('drops an own __proto__ key rather than let it set the copy’s prototype', () => {
      const doc = JSON.parse('{"__proto__":{"title":"x"},"a":1,"b":{"__proto__":{"y":2}}}');
      const { doc: clean, dropped } = wire.cleanProblem(doc);
      expect(dropped).toBe(2);
      expect(JSON.stringify(clean)).toBe('{"a":1,"b":{}}');
      expect(clean.title).toBeUndefined();
      expect(clean.b.y).toBeUndefined();
      expect(Object.getPrototypeOf(clean)).toBe(Object.getPrototypeOf({}));
    });
    it('fitProblem cleans before it fits; junk is still no doc', () => {
      expect(wire.fitProblem({ title: 'x', likes: 2 ** 53 }, 64 * 1024)).toEqual({ title: 'x' });
      expect(wire.fitProblemDetail({ title: 'x', likes: 2 ** 53 }, 64 * 1024)).toMatchObject({
        fit: 'whole',
        cleaned: 1,
      });
      for (const junk of [null, 7, 'x', [1]]) expect(wire.cleanProblem(junk).doc).toBeNull();
    });

    // The key one: whatever comes in, the cleaned doc passes A1’s real payloadError and its Start
    // normalizer — so the extension’s copy of the rule can’t drift from the server’s.
    it('always yields what A1’s payloadError and normalizeSittingStart accept, however hostile the doc', () => {
      let seed = 42;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const BAD = [
        1e308 * 10,
        -1e308 * 10,
        Number.NaN,
        2 ** 53,
        -(2 ** 60),
        1e-200,
        -1e-200,
        5e-324,
      ];
      const OK = [
        ...[0, 1, -1, -7, 34.5, 1e-130, -1e-130, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER],
        ...['x', '', null, true, false],
      ];
      const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
      // A small random tree (at most ~40 nodes), set at a random depth from 1 to 30.
      let budget = 0;
      const gen = (): unknown => {
        const r = rnd();
        if (--budget <= 0 || r < 0.3) return rnd() < 0.5 ? pick(BAD) : pick(OK);
        const n = 1 + Math.floor(rnd() * 3);
        if (r < 0.65) return Array.from({ length: n }, gen);
        return Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, gen()]));
      };
      const fuzz = () => {
        budget = 40;
        return deep(1 + Math.floor(rnd() * 30), gen());
      };
      const hostile = [
        { ...deep(21), title: 'deep' },
        { ...deep(40, 1e-200), content: '<p>x</p>' },
        { stats: { n: [1, [2, [3, { v: 2 ** 53 }]]] }, likes: Number.NaN },
        { ...deep(20, 1e308 * 10), ok: [0, 0, 0] },
        ...Array.from({ length: 200 }, () => ({ titleSlug: 'two-sum', extra: fuzz() })),
      ];
      let wereBad = 0;
      // And the other way: a doc A1 already takes comes through untouched — its edges included.
      const edges = [
        deep(20),
        { ...deep(20, -1e-130), n: -Number.MAX_SAFE_INTEGER, m: -1 },
        { ...deep(19, [1e-130, -1e-130]), z: [0, -0] },
      ];
      let wereGood = 0;
      for (const doc of [...edges, ...hostile]) {
        if (payloadError(doc)) wereBad++;
        else {
          wereGood++;
          expect(wire.cleanProblem(doc)).toEqual({ doc, dropped: 0 });
        }
        const clean = wire.cleanProblem(doc).doc;
        expect(payloadError(clean)).toBeNull();
        const fit = wire.fitProblem(doc, 64 * 1024);
        expect(() =>
          normalizeSittingStart({
            clientSittingId: ulid.ulid(),
            problemSlug: 'two-sum',
            problemTitle: 'Two Sum',
            lang: 'python3',
            startedAt: Date.now(),
            tzOffsetMinutes: 480,
            problem: fit,
          }),
        ).not.toThrow();
      }
      expect(wereBad).toBeGreaterThan(100); // the fuzz really is hostile, not a pass by luck
      expect(wereGood).toBeGreaterThan(20); // … and the reverse check really ran
    });
  });
});
