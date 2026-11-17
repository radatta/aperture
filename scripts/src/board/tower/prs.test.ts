import { describe, expect, it } from 'vitest';
import { GH_ARGS, PrCache, parsePrs } from './prs.ts';

const json = JSON.stringify([
  { number: 41, title: 'Open one\n🚀', headRefName: 'a', state: 'OPEN', mergedAt: null },
  {
    number: 40,
    title: 'Merged one',
    headRefName: 'b',
    state: 'MERGED',
    mergedAt: '2026-11-08T03:00:00Z',
    createdAt: '2026-11-07T20:00:00Z',
  },
  { title: 'no number' },
]);

describe('prs', () => {
  it('parses gh pr list', () => {
    expect(parsePrs(json)).toEqual([
      {
        number: 41,
        title: 'Open one?',
        branch: 'a',
        state: 'OPEN',
        mergedAt: null,
        createdAt: null,
        sha: null,
        mergeSha: null,
        url: null,
        draft: false,
      },
      {
        number: 40,
        title: 'Merged one',
        branch: 'b',
        state: 'MERGED',
        mergedAt: Date.parse('2026-11-08T03:00:00Z'),
        createdAt: Date.parse('2026-11-07T20:00:00Z'),
        sha: null,
        mergeSha: null,
        url: null,
        draft: false,
      },
    ]);
    expect(() => parsePrs('{}')).toThrow(/not an array/);
  });

  it("drops a fork's PR, so its head branch name can't stand for a lane", () => {
    const rows = JSON.stringify([
      { number: 7, title: 'from a fork', headRefName: 'a', state: 'OPEN', isCrossRepository: true },
      { number: 6, title: 'ours', headRefName: 'a', state: 'OPEN', isCrossRepository: false },
      { number: 5, title: 'field absent', headRefName: 'b', state: 'OPEN' },
    ]);
    expect(parsePrs(rows).map((p) => p.number)).toEqual([6, 5]);
    expect(GH_ARGS.at(-1)!.split(',')).toContain('isCrossRepository');
  });

  it('fetches at most once a minute and keeps the last list on a failure', async () => {
    let calls = 0;
    let fail = false;
    const cache = new PrCache(async () => {
      calls++;
      if (fail) throw new Error('HTTP 502\nmore');
      return json;
    });
    await cache.poll(0);
    await cache.poll(30000);
    expect(calls).toBe(1);
    expect(cache.list).toHaveLength(2);
    fail = true;
    await cache.poll(61000);
    expect(calls).toBe(2);
    expect(cache.list).toHaveLength(2);
    expect(cache.at).toBe(0);
    expect(cache.error).toBe('HTTP 502');
  });

  it('never runs two fetches at once', async () => {
    let calls = 0;
    let release = () => {};
    const cache = new PrCache(() => {
      calls++;
      return new Promise((r) => (release = () => r(json)));
    });
    const a = cache.poll(0);
    await cache.poll(120000);
    release();
    await a;
    expect(calls).toBe(1);
  });
});

describe('the fields the web tower reads', () => {
  it('head and merge shas, a GitHub url, draft', () => {
    const [p] = parsePrs(
      JSON.stringify([
        {
          number: 9,
          headRefName: 'x',
          state: 'MERGED',
          headRefOid: 'a'.repeat(40),
          mergeCommit: { oid: 'b'.repeat(40) },
          url: 'https://github.com/radatta/aperture/pull/9',
          isDraft: true,
        },
      ]),
    );
    expect(p).toMatchObject({
      sha: 'a'.repeat(40),
      mergeSha: 'b'.repeat(40),
      url: 'https://github.com/radatta/aperture/pull/9',
      draft: true,
    });
    const [q] = parsePrs(
      JSON.stringify([{ number: 9, headRefOid: 'zz', mergeCommit: null, url: 'javascript:x' }]),
    );
    expect(q).toMatchObject({ sha: null, mergeSha: null, url: null, draft: false });
  });
});
