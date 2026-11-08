import { describe, expect, it } from 'vitest';
import { PrCache, parsePrs } from './prs.ts';

const json = JSON.stringify([
  { number: 41, title: 'Open one\n🚀', headRefName: 'a', state: 'OPEN', mergedAt: null },
  {
    number: 40,
    title: 'Merged one',
    headRefName: 'b',
    state: 'MERGED',
    mergedAt: '2026-11-08T03:00:00Z',
  },
  { title: 'no number' },
]);

describe('prs', () => {
  it('parses gh pr list', () => {
    expect(parsePrs(json)).toEqual([
      { number: 41, title: 'Open one?', branch: 'a', state: 'OPEN', mergedAt: null },
      {
        number: 40,
        title: 'Merged one',
        branch: 'b',
        state: 'MERGED',
        mergedAt: Date.parse('2026-11-08T03:00:00Z'),
      },
    ]);
    expect(() => parsePrs('{}')).toThrow(/not an array/);
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
