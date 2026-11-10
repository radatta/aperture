import { describe, expect, it } from 'vitest';
import { isUlid, normalizeSittingEvents, problemCompanies } from '@aperture/shared';
import { lib } from './load';
import { CODE, QID, SLUG, T } from './fixtures/traffic';

const wire = lib('wire');
const ulid = lib('ulid');
type Pair = { url: string; reqText: string | null; resText: string };
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

  it('pairs a submit with its /v2/check/ SUCCESS once, at the submit’s time', () => {
    const c = wire.createCapture();
    expect(seen(c, T.submit, 1000)).toEqual([]);
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
    expect(wire.fitProblem(small, 64 * 1024)).toBe(small);
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
});
