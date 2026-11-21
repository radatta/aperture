// The estimate ledger: rows, cycles, the live score and the fixed step's gaps. Every number is invented.
import { describe, expect, it } from 'vitest';
import { PHASES, STEP_PHASES, type LaneFile } from '../board/tower/lanes.ts';
import { fitUnits } from './estimate.ts';
import type { PR } from './gh.ts';
import { prRow } from './fixtures.ts';
import {
  current,
  cycleOf,
  formatRow,
  gaps,
  laneCycle,
  liveScore,
  parseLedger,
  scoreRows,
  scoreStat,
  unestimated,
  type EstRow,
  type LedgerRow,
} from './ledger.ts';
import { POST_MS, type Attributed } from './prs.ts';

const T = (h: number) => Date.parse('2026-01-05T00:00:00Z') + h * 3_600_000;
const est = (lane: string, h: number, o: Partial<EstRow> = {}): EstRow => ({
  v: 1,
  lane,
  at: T(h),
  phase: 'plan',
  inp: { lines: 400, ui: false, lenses: ['review-tests'], fanout: 0 },
  qu: 10,
  lo: 5,
  hi: 20,
  pct: 1,
  pctLo: 0.5,
  pctHi: 2,
  basis: { regime: 3, band: 'prior', k: 'prior', priors: 'placeholders' },
  ...o,
});
const voided = (lane: string, h: number): LedgerRow => ({ v: 1, lane, at: T(h), void: 'dropped' });
const pr = (number: number, branch: string, h: number): PR => ({
  number,
  title: 't',
  branch,
  mergedAt: T(h),
  changedFiles: 3,
  additions: 300,
  deletions: 20,
  files: ['scripts/x.ts'],
});
const call = (lane: string, h: number, qu: number) =>
  ({ ts: T(h), qu, lane, role: 'lane', kind: 'main' }) as Attributed;
const lane = (
  branch: string,
  phase: LaneFile['phase'],
  plan: LaneFile['plan'] = null,
): LaneFile => ({
  branch,
  session: branch,
  phase,
  step: null,
  phaseSince: T(0),
  sha: null,
  pr: null,
  slot: null,
  needs: null,
  updatedAt: T(0),
  files: null,
  plan,
  eta: null,
});
const units = fitUnits([]);

describe('parseLedger and formatRow', () => {
  it('round-trips rows, sorted by time, with at as ISO on disk', () => {
    const a = est('lane-a', 2);
    const b = voided('lane-b', 1);
    const text = `${formatRow(a)}\n${formatRow(b)}\n`;
    expect(text).toContain('"at":"2026-01-05T02:00:00.000Z"');
    expect(parseLedger(text)).toEqual({ rows: [b, a], bad: [] });
    expect(parseLedger('')).toEqual({ rows: [], bad: [] });
  });

  it('counts torn and foreign lines as bad and keeps the rest', () => {
    const good = formatRow(est('lane-a', 1));
    const bad = [
      '{"v":1,"lane":"lane-a","at":"2026-01-05T0', // torn
      '[1]',
      formatRow(est('lane-a', 1)).replace('"v":1', '"v":2'),
      formatRow(est('Lane A', 1)),
      formatRow(est('lane-a', 1, { lo: 30 })), // lo > qu
      formatRow(
        est('lane-a', 1, { inp: { lines: 1, ui: false, lenses: [3 as never], fanout: 0 } }),
      ),
      JSON.stringify({ v: 1, lane: 'lane-a', at: '2026-01-05T00:00:00Z', void: '' }),
    ];
    expect(parseLedger([good, ...bad].join('\n'))).toMatchObject({
      rows: [{ lane: 'lane-a' }],
      bad: [2, 3, 4, 5, 6, 7, 8], // line numbers, 1-based
    });
  });
});

describe('cycles', () => {
  const prs = [pr(1, 'lane-a', 10), pr(2, 'lane-a', 30)];

  it('puts a row in the first PR merged after it on its branch', () => {
    expect(cycleOf('lane-b', T(1), prs)).toEqual({ prev: null, pr: null });
    expect(cycleOf('lane-a', T(1), prs)).toMatchObject({ prev: null, pr: { number: 1 } });
    // a reused name: the row between the two PRs is the second's
    expect(cycleOf('lane-a', T(20), prs)).toMatchObject({ prev: { number: 1 }, pr: { number: 2 } });
    // inside PR 1's post window, still the next cycle's, never PR 1's
    expect(cycleOf('lane-a', T(11), prs).pr?.number).toBe(2);
    expect(cycleOf('lane-a', T(40), prs)).toMatchObject({ prev: { number: 2 }, pr: null });
  });

  it('keeps the newest estimate per cycle; a newer void closes it and a later estimate reopens it', () => {
    const rows = [est('lane-a', 1, { qu: 8 }), est('lane-a', 2, { qu: 12, lo: 6 })];
    expect(current(rows, prs)).toMatchObject([{ lane: 'lane-a', reestimates: 1, row: { qu: 12 } }]);
    expect(current([...rows, voided('lane-a', 3)], prs)[0]?.voided).toBe('dropped');
    expect(current([...rows, voided('lane-a', 3), est('lane-a', 4)], prs)[0]).toMatchObject({
      voided: null,
      reestimates: 2,
    });
    // two cycles on one branch are two entries
    expect(current([est('lane-a', 1), est('lane-a', 20)], prs).map((e) => e.pr?.number)).toEqual([
      1, 2,
    ]);
  });
});

describe('scoreRows', () => {
  const prs = [pr(1, 'lane-a', 10)];
  const rows = [prRow({ number: 1, branch: 'lane-a', mergedAt: T(10), qu: 15, lines: 320 })];

  it('is so far before the merge: the lane calls after the previous PR on its branch', () => {
    const calls = [call('lane-a', 5, 3), call('lane-a', 12, 4), call('lane-b', 12, 50)];
    const [s] = scoreRows({
      entries: current([est('lane-a', 11)], prs),
      rows,
      prs,
      calls,
      units,
      lastCall: T(12),
    });
    expect(s).toMatchObject({ state: 'so-far', actual: 4, ratio: 0.4, pr: null, inRange: null });
    // no PR on the branch yet: every lane call counts
    const [first] = scoreRows({
      entries: current([est('lane-b', 1)], prs),
      rows,
      prs,
      calls,
      units,
      lastCall: T(12),
    });
    expect(first).toMatchObject({ state: 'so-far', actual: 50 });
  });

  it('is provisional until the post window has passed and been scanned, then final', () => {
    const at = (lastCall: number | null) =>
      scoreRows({
        entries: current([est('lane-a', 1)], prs),
        rows,
        prs,
        calls: [],
        units,
        lastCall,
      })[0];
    expect(at(T(10) + POST_MS - 1)).toMatchObject({
      state: 'provisional',
      actual: 15,
      inRange: null,
    });
    expect(at(null)?.state).toBe('provisional');
    expect(at(T(10) + POST_MS)).toMatchObject({
      state: 'final',
      actual: 15,
      ratio: 1.5,
      inRange: true,
      actualLines: 320,
      pr: 1,
    });
    // a later PR on its branch ends the window at the merge: final once the scan reaches the merge
    const two = [...prs, pr(2, 'lane-a', 11)];
    const later = (lastCall: number | null) =>
      scoreRows({
        entries: current([est('lane-a', 1)], two),
        rows,
        prs: two,
        calls: [],
        units,
        lastCall,
      })[0]?.state;
    expect(later(T(10))).toBe('final');
    expect(later(T(10) - 1)).toBe('provisional');
    expect(later(null)).toBe('provisional');
  });

  it('marks range edges, no calls, void and late', () => {
    const run = (r: EstRow[], extra: LedgerRow[] = [], qu = 20) =>
      scoreRows({
        entries: current([...r, ...extra], prs),
        rows: [{ ...rows[0]!, qu }],
        prs,
        calls: [],
        units,
        lastCall: T(100),
      })[0];
    expect(run([est('lane-a', 1)], [], 20)?.inRange).toBe(true); // hi itself
    expect(run([est('lane-a', 1)], [], 5)?.inRange).toBe(true); // lo itself
    expect(run([est('lane-a', 1)], [], 20.01)?.inRange).toBe(false);
    expect(run([est('lane-a', 1)], [], 0)).toMatchObject({ state: 'no-calls', actual: null });
    expect(run([est('lane-a', 1)], [voided('lane-a', 2)])).toMatchObject({
      state: 'void',
      actual: null,
    });
    expect(run([est('lane-a', 1, { phase: 'review' })])?.late).toBe(true);
    expect(run([est('lane-a', 1, { phase: null })])?.late).toBe(false);
  });

  it("prices 'at actual' from the merged PR's own inputs, not the estimate's", () => {
    const big = [{ ...rows[0]!, lines: 5000, runs: [] }];
    const small = [{ ...rows[0]!, lines: 50, runs: [] }];
    const at = (r: typeof rows) =>
      scoreRows({
        entries: current([est('lane-a', 1)], prs),
        rows: r,
        prs,
        calls: [],
        units,
        lastCall: T(100),
      })[0]!.atActual!;
    expect(at(big)).toBeGreaterThan(at(small));
  });
});

describe('the live score', () => {
  it('scores final rows only, and says nothing is in with none', () => {
    expect(scoreStat([])).toMatchObject({ n: 0, inRange: 0, open: 0 });
    const prs = [pr(1, 'lane-a', 10), pr(2, 'lane-b', 10), pr(3, 'lane-c', 10)];
    const rows = [
      prRow({ number: 1, branch: 'lane-a', mergedAt: T(10), qu: 20 }), // ×2
      prRow({ number: 2, branch: 'lane-b', mergedAt: T(10), qu: 5 }), // ×0.5
      prRow({ number: 3, branch: 'lane-c', mergedAt: T(10), qu: 10 }), // ×1
    ];
    const ledger = {
      rows: ['lane-a', 'lane-b', 'lane-c', 'lane-d'].map((l) =>
        est(l, 1, l === 'lane-c' ? { phase: 'review' } : {}),
      ),
      bad: [],
    };
    const s = liveScore({ ledger, prs, rows, calls: [], units, lastCall: T(100) });
    expect(s.stat).toMatchObject({
      n: 3,
      inRange: 3,
      within15: 1,
      actual: 35,
      predicted: 30,
      open: 1,
      late: 1,
    });
    expect(s.stat.medianX).toBeCloseTo(2, 6);
    expect(s.recorded).toBe(4);
    expect(s.left).toBe(0);
  });

  it('cuts by merge time: a PR merged on or after from keeps its estimate, however early it was recorded', () => {
    const prs = [pr(1, 'lane-a', 10), pr(2, 'lane-b', 1.5)];
    const rows = prs.map((p) =>
      prRow({ number: p.number, branch: p.branch, mergedAt: p.mergedAt, qu: 8 }),
    );
    const ledger = {
      rows: [
        est('lane-a', 1),
        est('lane-a', 1.2),
        est('lane-b', 1),
        est('lane-c', 1),
        est('lane-d', 2),
        voided('lane-e', 3),
      ],
      bad: [],
    };
    const s = liveScore({ ledger, prs, rows, calls: [], units, lastCall: T(100), from: T(2) });
    // lane-a: kept (merged at 10, re-estimated: 2 rows); lane-b: merged before from; lane-c: open, recorded before;
    // lane-d: open, recorded at from (kept); lane-e: a void with no estimate (no row to score)
    expect(s.rows.map((r) => [r.lane, r.reestimates])).toEqual([
      ['lane-a', 1],
      ['lane-d', 0],
    ]);
    expect(s).toMatchObject({ recorded: 3, left: 2, unestimated: [] });
  });

  it('counts merged PRs with no estimate only after the first one, per cycle', () => {
    const prs = [pr(1, 'lane-a', 1), pr(2, 'lane-a', 20), pr(3, 'lane-b', 30)];
    const rows = prs.map((p) =>
      prRow({ number: p.number, branch: p.branch, mergedAt: p.mergedAt }),
    );
    const ledger = [est('lane-a', 5)]; // PR 1 came before any estimate; PR 2's cycle has one
    expect(unestimated(current(ledger, prs), ledger, rows)).toEqual([3]);
    expect(unestimated([], [], rows)).toEqual([]);
    // a PR no lane session worked on isn't counted
    expect(
      unestimated(
        current(ledger, prs),
        ledger,
        rows.map((r) => ({ ...r, turns: 0 })),
      ),
    ).toEqual([]);
  });
});

describe('laneCycle', () => {
  const two = [pr(1, 'lane-a', 10), pr(2, 'lane-a', 20), pr(7, 'lane-z', 15)];
  const at = (o: Partial<LaneFile>, prs = two) =>
    laneCycle({ ...lane('lane-a', 'build'), ...o }, prs)?.number ?? null;
  it('prefers the PR the lane file names, else the newest merged since its phase began', () => {
    expect(at({ pr: 1, phaseSince: T(5) })).toBe(1);
    expect(at({ pr: 2, phaseSince: T(5) })).toBe(2);
    expect(at({ pr: null, phaseSince: T(5) })).toBe(2);
    expect(at({ pr: null, phaseSince: T(20) })).toBe(2); // merged the instant the phase began
    expect(at({ pr: 1, phaseSince: null })).toBe(1);
    // known: a lane back in build for a follow-up PR, its file still naming the merged one, reads as merged
    expect(at({ pr: 2, phaseSince: T(21) })).toBe(2);
  });
  it('in merged or cleanup, a phase begun after the merge, takes the newest merged on the branch', () => {
    expect(at({ phase: 'merged', pr: null, phaseSince: T(21) })).toBe(2);
    expect(at({ phase: 'cleanup', pr: null, phaseSince: T(30) })).toBe(2);
    expect(at({ phase: 'merged', pr: null, phaseSince: T(21) }, [])).toBe(null);
  });
  it('is open after the newest merge otherwise, and always open in plan', () => {
    expect(at({ pr: null, phaseSince: T(21) })).toBe(null);
    expect(at({ pr: null, phaseSince: null })).toBe(null);
    expect(at({ pr: 7, phaseSince: T(21) })).toBe(null); // another branch's PR
    expect(at({ pr: 9, phaseSince: null })).toBe(null); // unmerged or unknown
    expect(at({ phase: 'plan', pr: 1, phaseSince: T(5) })).toBe(null);
    expect(at({}, [])).toBe(null);
  });
});

describe('gaps (the check)', () => {
  const steps = [
    { phase: 'build' as const, lo: 10, hi: 20, source: 'measured' as const, spentMs: 0 },
  ];
  const none = { rows: [], bad: [], lanes: [], problems: [], prs: { prs: [], fetchedAt: T(0) } };

  it('is quiet with nothing to say', () => expect(gaps(none)).toEqual([]));

  it('flags a lane past plan, or in plan with its step plan written, that has no estimate', () => {
    const g = gaps({ ...none, lanes: [lane('lane-a', 'build'), lane('lane-b', 'plan', steps)] });
    expect(g).toEqual([
      'lane-a: no usage estimate (phase build) → pnpm usage estimate --lane lane-a --lines <n> [--ui] --lenses <…>',
      'lane-b: no usage estimate (phase plan) → pnpm usage estimate --lane lane-b --lines <n> [--ui] --lenses <…>',
    ]);
    expect(gaps({ ...none, rows: [est('lane-a', 1)], lanes: [lane('lane-a', 'review')] })).toEqual(
      [],
    );
  });

  it('asks every step phase past plan, and says nothing for plan, parked, blocked, merged or cleanup', () => {
    const due = STEP_PHASES.filter((p) => p !== 'plan');
    const quiet = PHASES.filter((p) => !due.includes(p as never));
    expect(quiet).toEqual(['plan', 'merged', 'cleanup', 'parked', 'blocked']);
    expect(gaps({ ...none, lanes: quiet.map((p, i) => lane(`lane-${i}`, p)) })).toEqual([]);
    expect(gaps({ ...none, lanes: due.map((p, i) => lane(`lane-${i}`, p)) })).toHaveLength(
      due.length,
    );
  });

  it('asks again after a void while the lane is still live', () => {
    const g = gaps({
      ...none,
      rows: [est('lane-a', 1), voided('lane-a', 2)],
      lanes: [lane('lane-a', 'build')],
    });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatch(/^lane-a: no usage estimate \(phase build\)/);
  });

  it("stays quiet when the lane file trails its own PR's merge and the table has caught up", () => {
    const prs = { prs: [pr(1, 'lane-a', 10)], fetchedAt: T(11) };
    const rows = [est('lane-a', 1)]; // now in PR 1's cycle, not the open one
    // phaseSince before the merge, or the lane file naming the PR
    expect(
      gaps({ ...none, rows, prs, lanes: [{ ...lane('lane-a', 'pr'), phaseSince: T(5) }] }),
    ).toEqual([]);
    expect(
      gaps({ ...none, rows, prs, lanes: [{ ...lane('lane-a', 'dev'), phaseSince: T(12), pr: 1 }] }),
    ).toEqual([]);
    // past the point: the score's merged-with-none count has it, and estimate --lane refuses
    expect(gaps({ ...none, prs, lanes: [{ ...lane('lane-a', 'pr'), phaseSince: T(5) }] })).toEqual(
      [],
    );
    // an open row recorded after the merge (a stale table at the time) stays quiet while the lane file exists
    expect(
      gaps({
        ...none,
        rows: [est('lane-a', 12)],
        prs,
        lanes: [{ ...lane('lane-a', 'pr'), pr: 1 }],
      }),
    ).toEqual([]);
  });

  it('asks a plan lane with a step plan even when its file still names a merged PR', () => {
    const prs = { prs: [pr(1, 'lane-a', 10)], fetchedAt: T(11) };
    const l = { ...lane('lane-a', 'plan', steps), pr: 1, phaseSince: T(5) };
    expect(gaps({ ...none, prs, lanes: [l] })).toHaveLength(1);
    expect(gaps({ ...none, prs, lanes: [l], rows: [est('lane-a', 11)] })).toEqual([]);
  });

  it("never lets a reused name's earlier estimate count", () => {
    const g = gaps({
      ...none,
      rows: [est('lane-a', 1)],
      lanes: [{ ...lane('lane-a', 'build'), phaseSince: T(11) }], // the new lane started after PR 1 merged
      prs: { prs: [pr(1, 'lane-a', 10)], fetchedAt: T(12) },
    });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatch(/^lane-a: no usage estimate/);
  });

  it('flags an estimate with no lane file and no PR after it, naming the table, unless voided', () => {
    const prs = { prs: [pr(7, 'lane-z', 1)], fetchedAt: Date.parse('2026-01-05T18:30:00Z') };
    const g = gaps({ ...none, rows: [est('lane-a', 2)], prs });
    expect(g).toHaveLength(1);
    expect(g[0]).toContain(
      'lane-a: estimated 01/04, 18:00 PT, no lane file and no merged PR after it',
    );
    expect(g[0]).toContain('newest PR 7, fetched 01/05, 10:30 PT');
    expect(g[0]).toContain('pnpm usage score --lane lane-a --void "<why>"');
    expect(gaps({ ...none, rows: [est('lane-a', 2), voided('lane-a', 3)], prs })).toEqual([]);
    expect(gaps({ ...none, rows: [est('lane-a', 2)], prs: null })[0]).toContain(
      'no PR table (cache/prs.json missing or unreadable)',
    );
    const stale = { newest: 7, fetchedAt: T(0), why: 'HTTP 502' };
    expect(gaps({ ...none, rows: [est('lane-a', 2)], prs: { ...prs, stale } })[0]).toContain(
      'the PR table is stale (STALE: newest PR 7, fetched 01/04, 16:00 PT (gh: HTTP 502))',
    );
    // merged: the actual is the PR's, nothing to flag
    expect(
      gaps({ ...none, rows: [est('lane-a', 2)], prs: { ...prs, prs: [pr(8, 'lane-a', 5)] } }),
    ).toEqual([]);
  });

  it('names a torn lane file and never reads it as a missing one; names unreadable ledger rows', () => {
    const g = gaps({
      ...none,
      bad: [3, 9],
      rows: [est('lane-a', 1)],
      problems: [{ file: 'lane-a.json', problem: 'not JSON' }],
    });
    expect(g).toEqual([
      'estimates.jsonl: unreadable rows at line 3, 9 → delete them by hand (a torn append; the rest is read)',
      'lanes/lane-a.json: unreadable (not JSON), not checked',
    ]);
  });
});
