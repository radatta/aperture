import { describe, expect, it } from 'vitest';
import { prsFile, readPrIndex, whatIs, type WiSources } from './lookup.ts';
import type { LaneFile } from './tower/lanes.ts';
import { parseQueue } from './tower/queue.ts';
import type { Pr } from './tower/prs.ts';

const NOW = Date.parse('2026-11-18T20:00:00Z');
const f = (t: number) => new Date(t).toISOString().slice(11, 16);
const queue = parseQueue(
  JSON.stringify({
    v: 1,
    updatedAt: '2026-11-18T19:00:00Z',
    devQueue: [{ branch: 'warm-caches', state: 'building', note: 'review round 2' }],
    autoStart: [
      {
        branch: 'gate-trims',
        order: 2,
        class: 'p0',
        after: ['warm-caches'],
        note: 'after warm-caches',
      },
    ],
    followups: [
      {
        id: 'F209',
        what: 'script the merge line',
        owner: 'lane',
        after: 'now',
        status: 'open',
        source: 'his 11-14',
        since: '2026-11-14',
      },
    ],
    asks: [
      {
        id: 'd3',
        asked: '2026-11-18T19:10:00Z',
        text: 'Cache key?',
        options: ['branch', 'lockfile'],
        pick: 'b',
        status: 'open',
      },
    ],
  }),
).data;
const lane = {
  branch: 'warm-caches',
  phase: 'review',
  step: 'round 1 fixes',
  needs: null,
  eta: { next: null, pr: { lo: NOW + 30 * 60e3, hi: NOW + 70 * 60e3 }, source: 'measured' },
} as unknown as LaneFile;
const prs = readPrIndex(
  prsFile(
    [
      {
        number: 206,
        title: 'Board: asks\u001b[2J',
        branch: 'warm-caches',
        state: 'OPEN',
        url: 'https://github.com/o/r/pull/206',
      },
      { number: 150, title: 'old one', branch: 'warm-caches', state: 'MERGED', url: null },
    ] as unknown as Pr[],
    NOW,
  ),
);
const src = (over: Partial<WiSources> = {}): WiSources => ({
  queue,
  lanes: [lane],
  prs,
  roadmap: 'line one\n- F300 the tower charts tab (queued)\n- F300 again\n- F300 a third',
  kickoff: (b) => (b === 'gate-trims' ? '\n[kickoff] gate-trims: trim the gate\nmore' : null),
  now: NOW,
  ...over,
});

describe('whatIs', () => {
  it("an F-number: its followups row, else the roadmap's first two lines naming it, else not found", () => {
    expect(whatIs('F209', src(), f)).toBe(
      'F209 · open · lane · after now · since 11-14 · script the merge line (his 11-14)',
    );
    expect(whatIs('f300', src(), f)).toBe(
      'F300 (roadmap, not in followups[]):\n  - F300 the tower charts tab (queued)\n  - F300 again',
    );
    expect(whatIs('F30', src(), f)).toBe('not found: F30 (not in followups[] or the roadmap)'); // F300 isn't F30
  });
  it("a PR: number, PR n or #n; its lane file when it has one; a title's control bytes gone", () => {
    const want =
      'PR 206 · OPEN · warm-caches · "Board: asks[2J" · https://github.com/o/r/pull/206\n  lane review · round 1 fixes · PR ~20:30–21:10';
    for (const id of ['206', 'PR 206', 'pr206', '#206']) expect(whatIs(id, src(), f)).toBe(want);
    expect(whatIs('999', src(), f)).toBe("PR 999: not in the tower's newest PRs (as of 20:00)");
    expect(whatIs('206', src({ prs: null }), f)).toMatch(/^PR 206: no pr-index.json yet/);
  });
  it('an ask: shown in full', () => {
    expect(whatIs('D3', src(), f)).toMatch(
      /^d3 · open · asked 19:10\nCache key\?\n {2}a\) branch\n {2}b\) lockfile {2}← pick$/,
    );
    expect(whatIs('d9', src(), f)).toBe('not found: d9 (no such ask in queue.json)');
  });
  it('a lane: its file, queue entries, newest PR and kickoff line', () => {
    expect(whatIs('warm-caches', src(), f)).toBe(
      [
        'warm-caches · lane file:',
        '  lane review · round 1 fixes · PR ~20:30–21:10',
        '  devQueue building · review round 2',
        '  PR 206 · OPEN · "Board: asks[2J"',
      ].join('\n'),
    );
    expect(whatIs('gate-trims', src(), f)).toBe(
      [
        'gate-trims:',
        '  autoStart 2 p0 · after warm-caches · after warm-caches',
        '  kickoff: [kickoff] gate-trims: trim the gate',
      ].join('\n'),
    );
    expect(whatIs('nobody', src(), f)).toBe(
      'not found: nobody (no lane file, queue entry, PR or kickoff)',
    );
    expect(whatIs('Not An Id!', src(), f)).toMatch(/^not found: Not An Id! \(an F-number/);
  });
});

describe('the PR index file', () => {
  it('round-trips the fields wi uses, and reads a bad file as none', () => {
    expect(prs!.at).toBe(NOW);
    expect(prs!.prs[0]).toEqual({
      number: 206,
      title: 'Board: asks[2J',
      branch: 'warm-caches',
      state: 'OPEN',
      url: 'https://github.com/o/r/pull/206',
    });
    for (const bad of [
      null,
      'nope',
      '{}',
      '{"at":"x","prs":[]}',
      '{"at":"2026-11-18T00:00:00Z","prs":{}}',
    ])
      expect(readPrIndex(bad)).toBeNull();
    expect(
      readPrIndex('{"at":"2026-11-18T00:00:00Z","prs":[{"number":"7"},null,{"number":8}]}')!.prs,
    ).toEqual([{ number: 8, title: '', branch: '', state: '', url: null }]);
  });
});
