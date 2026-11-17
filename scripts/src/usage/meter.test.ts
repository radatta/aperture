import { describe, expect, it } from 'vitest';
import { meterRow } from './fixtures.ts';
import { holdout, fitKLambda, fitKOnly, rng, uncertainty, type Obs } from './fit.ts';
import {
  burn,
  costDeltas,
  freshReadings,
  intervals,
  manualWindows,
  parseMeter,
  ticks,
  type Point,
} from './meter.ts';
import { quantile, shrinkLog, slope, spearman } from './stats.ts';

const at = (min: number) => new Date(Date.UTC(2026, 0, 5, 10, min)).toISOString();
const log = (rows: Parameters<typeof meterRow>[0][]) =>
  parseMeter(rows.map(meterRow).join('\n')).rows;

describe('meter series', () => {
  it("skips torn and null-rl rows, and a session's first row never counts", () => {
    const { rows, bad } = parseMeter(`${meterRow({ ts: at(0), pct: 5 })}\n{"ts":"x"\n`);
    expect(bad).toBe(1);
    expect(freshReadings(rows)).toEqual([]);
    expect(
      freshReadings(
        log([
          { ts: at(0), pct: null, cost: 0 },
          { ts: at(1), pct: 5 },
        ]),
      ),
    ).toEqual([]);
  });

  it('ignores stale sessions: only rows whose % or cost moved count, and the envelope never falls', () => {
    const rows = log([
      { ts: at(0), sid: 'a', pct: 87, cost: 1 },
      { ts: at(0), sid: 'b', pct: 91, cost: 1 },
      { ts: at(1), sid: 'a', pct: 87, cost: 1 }, // idle and stale: not fresh
      { ts: at(1), sid: 'b', pct: 92, cost: 2 },
      { ts: at(2), sid: 'a', pct: 91, cost: 1.5 }, // fresh again but behind: a straggler
      { ts: at(3), sid: 'b', pct: 93, cost: 3 },
      { ts: at(4), sid: 'b', pct: 94, cost: 4 },
    ]);
    const { windows, stragglers } = ticks(freshReadings(rows));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.map((p) => [p.p, p.src])).toEqual([
      [92, 'manual'],
      [93, 'tick'],
      [94, 'tick'],
    ]);
    expect(stragglers).toBe(1);
  });

  it("splits windows at a resets_at change or a big drop, and drops the old window's stragglers", () => {
    const R1 = 1_800_000_000;
    const R2 = R1 + 7 * 86400;
    const rows = log([
      { ts: at(0), sid: 'a', pct: 98, cost: 1, resetsAt: R1 },
      { ts: at(1), sid: 'a', pct: 99, cost: 2, resetsAt: R1 },
      { ts: at(2), sid: 'a', pct: 1, cost: 3, resetsAt: R2 },
      { ts: at(2), sid: 'b', pct: 50, cost: 1, resetsAt: R1 },
      { ts: at(3), sid: 'b', pct: 99, cost: 2, resetsAt: R1 }, // old window, stale session
      { ts: at(4), sid: 'a', pct: 2, cost: 4, resetsAt: R2 },
    ]);
    const w = ticks(freshReadings(rows)).windows;
    expect(w.map((x) => x.map((p) => p.p))).toEqual([[99], [1, 2]]);
    // a straggler whose resets_at drifted by seconds is still the old window's
    const drift = log([
      { ts: at(0), sid: 'a', pct: 98, cost: 1, resetsAt: R1 },
      { ts: at(1), sid: 'a', pct: 99, cost: 2, resetsAt: R1 },
      { ts: at(2), sid: 'a', pct: 1, cost: 3, resetsAt: R2 },
      { ts: at(2), sid: 'b', pct: 50, cost: 1, resetsAt: R1 + 5 },
      { ts: at(3), sid: 'b', pct: 99, cost: 2, resetsAt: R1 + 5 },
      { ts: at(4), sid: 'a', pct: 2, cost: 4, resetsAt: R2 },
    ]);
    expect(ticks(freshReadings(drift)).windows.map((x) => x.map((p) => p.p))).toEqual([
      [99],
      [1, 2],
    ]);
    // a drop (manual reset) whose resets_at jittered by seconds keeps reading the new window
    const jitter = log([
      { ts: at(0), pct: 99, cost: 1, resetsAt: R1 },
      { ts: at(1), pct: 100, cost: 2, resetsAt: R1 },
      { ts: at(2), pct: 0, cost: 3, resetsAt: R1 + 2 },
      { ts: at(3), pct: 1, cost: 4, resetsAt: R1 },
      { ts: at(4), pct: 2, cost: 5, resetsAt: R1 + 2 },
    ]);
    const jw = ticks(freshReadings(jitter)).windows;
    expect(jw.map((x) => x.map((p) => p.p))).toEqual([[100], [0, 1, 2]]);
    // a manual reset that leaves resets_at alone shows as a drop of 10+
    const drop = log([
      { ts: at(0), pct: 99, cost: 1 },
      { ts: at(1), pct: 100, cost: 2 },
      { ts: at(2), pct: 0, cost: 3 },
      { ts: at(3), pct: 1, cost: 4 },
    ]);
    expect(ticks(freshReadings(drop)).windows.map((x) => x.map((p) => p.p))).toEqual([
      [100],
      [0, 1],
    ]);
  });

  it('turns manual readings into windows split at resets, a reset being an exact zero', () => {
    const w = manualWindows({
      readings: [
        { at: '2026-01-01T10:00:00-08:00', pct: 10 },
        { at: '2026-01-03T10:00:00-08:00', pct: 50, approx: true },
        { at: '2026-01-06T10:00:00-08:00', pct: 30 },
      ],
      resets: ['2026-01-05T01:00:00-08:00'],
    });
    expect(w.map((x) => x.map((p) => [p.p, p.src]))).toEqual([
      [
        [10, 'manual'],
        [50, 'manual'],
      ],
      [
        [0, 'reset'],
        [30, 'manual'],
      ],
    ]);
    expect(w[0]![1]!.r).toBeCloseTo(1 / 3);
  });

  it('builds intervals of at least 3 points and 10 minutes, never across windows', () => {
    const pts: Point[] = [0, 1, 2, 3, 4, 8, 9].map((p, i) => ({
      ts: i * 600_000,
      p,
      r: 0,
      src: 'tick',
    }));
    expect(intervals(pts).map((i) => [i.dP, i.src])).toEqual([
      [3, 'tick→tick'],
      [5, 'tick→tick'],
    ]);
    expect(intervals([pts[0]!])).toEqual([]);
    expect(intervals([])).toEqual([]);
  });

  it('sums positive cost deltas per session and re-baselines a restarted session', () => {
    const rows = log([
      { ts: at(0), sid: 'a', cost: 1 },
      { ts: at(1), sid: 'a', cost: 3 },
      { ts: at(2), sid: 'a', cost: 0.5 },
      { ts: at(3), sid: 'a', cost: 1 },
      { ts: at(3), sid: 'b', cost: null },
    ]);
    expect(costDeltas(rows).map((d) => d.d)).toEqual([2, 0.5]);
  });

  it('measures burn over the trailing hour of ticks', () => {
    const pts: Point[] = [
      { ts: 0, p: 90, r: 1 / 12, src: 'manual' },
      ...[91, 92, 93].map((p, i) => ({ ts: (i + 1) * 1_200_000, p, r: 0, src: 'tick' as const })),
    ];
    expect(burn(pts, 3_600_000)).toMatchObject({ pct: 93, perHour: 2 / (40 / 60) });
    expect(burn(pts.slice(0, 2), 3_600_000)).toMatchObject({ perHour: null });
    expect(burn([], 0)).toBeNull();
  });
});

describe('fit', () => {
  // Synthetic truth: k = 0.04 %/QU, λ = 0.5 %/h, with ΔQU and Δt varied independently.
  const truth = (dQU: number, dT: number): Obs => ({ dP: 0.04 * dQU + 0.5 * dT, dQU, dT, r: 0.02 });
  const obs = [
    truth(100, 1),
    truth(300, 0.5),
    truth(50, 4),
    truth(200, 2),
    truth(120, 0.2),
    truth(400, 3),
  ];

  it('recovers k and λ from noiseless data', () => {
    const f = fitKLambda(obs);
    expect(f.k).toBeCloseTo(0.04, 6);
    expect(f.lambda).toBeCloseTo(0.5, 6);
    expect(f.lambdaFixed).toBe(false);
  });

  it('clips a negative λ to 0 and refits k', () => {
    const neg = [100, 200, 300, 400, 500].map((q, i) => ({
      dP: 0.05 * q - 0.3 * (i + 1),
      dQU: q,
      dT: i + 1,
      r: 0.02,
    }));
    const f = fitKLambda(neg);
    expect(f.lambda).toBe(0);
    expect(f.k).toBeGreaterThan(0);
  });

  it('holds λ at 0 with under 4 intervals or when ΔQU and Δt move together', () => {
    expect(fitKLambda(obs.slice(0, 3)).lambdaFixed).toBe(true);
    const lock = [1, 2, 3, 4, 5].map((n) => ({ dP: n * 4, dQU: n * 100, dT: n, r: 0.02 }));
    expect(fitKLambda(lock)).toMatchObject({ lambdaFixed: true, lambda: 0 });
    expect(fitKOnly(lock).k).toBeCloseTo(0.04);
  });

  it('bootstraps deterministically by seed, and falls back to leave-one-out under 5 intervals', () => {
    const noisy = obs.map((o, i) => ({ ...o, dP: o.dP * (1 + (i % 2 ? 0.1 : -0.1)) }));
    const a = uncertainty(noisy, (o) => fitKLambda(o), 300, 3);
    expect(a).toEqual(uncertainty(noisy, (o) => fitKLambda(o), 300, 3));
    expect(a.method).toBe('bootstrap');
    expect(a.k80!.lo).toBeLessThanOrEqual(a.k80!.hi);
    expect(uncertainty(noisy.slice(0, 4), fitKOnly).method).toBe('leave-one-out');
    expect(uncertainty([], fitKOnly).method).toBe('none');
    expect(rng(1)()).toBe(rng(1)());
  });

  it('scores a fit on held-out intervals', () => {
    expect(holdout({ k: 0.04, lambda: 0.5 }, obs)).toMatchObject({
      n: 6,
      mae: expect.closeTo(0, 9),
    });
  });
});

describe('stats', () => {
  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it('shrinks group log-means toward the grand mean and pools the spread', () => {
    const s = shrinkLog({ a: [10, 12, 8], b: [100, 120, 80], c: [30, 40, 35], d: [] });
    expect(s.shrinkage).toBe(true);
    const a = s.groups.find((g) => g.group === 'a')!;
    expect(a.median).toBeGreaterThanOrEqual(a.rawMedian * 0.9);
    expect(a.p80).toBeGreaterThan(a.median);
    expect(s.groups.find((g) => g.group === 'd')).toMatchObject({ n: 0 });
  });

  it('skips shrinkage with under 3 groups or a group of one', () => {
    expect(shrinkLog({ a: [1, 2], b: [3, 4] }).shrinkage).toBe(false);
    expect(shrinkLog({ a: [1, 2], b: [3, 4], c: [5] }).shrinkage).toBe(false);
    expect(shrinkLog({ a: [1, 2], b: [3, 4] }).groups[0]!.median).toBeCloseTo(Math.sqrt(2));
  });

  it('ranks with ties and fits a slope', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 20, 40])).toBeGreaterThan(0.9);
    expect(spearman([1, 2], [1, 2])).toBeNaN();
    expect(slope([1, 2, 3], [2, 4, 6])).toBe(2);
  });
});
