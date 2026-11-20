import { describe, expect, it } from 'vitest';
import {
  backtest,
  bandOf,
  fitUnits,
  inputsOf,
  mainOf,
  MIN_FIT,
  mergePriors,
  predict,
  DEFAULT_PRIORS,
  regimeRows,
  turnsOf,
} from './estimate.ts';
import { prRow } from './fixtures.ts';
import { estimateBasis } from './model.ts';
import type { PRRow } from './prs.ts';
import { ols } from './stats.ts';

// A planted world, every number invented: turns, main QU, context, rechecks and agent prices follow known laws, so
// the fit has a right answer to recover. jitter() is deterministic, never random.
const jitter = (i: number, size: number) => size * Math.sin(i * 2.399);
const LAW = { a: 3, b: 0.4, c: 0.5, ma: 1, mT: 0.02, mC: 0.25, g0: 150_000, g1: 300 };
function planted(n: number, uiAt = (i: number) => i % 2 === 1): PRRow[] {
  return Array.from({ length: n }, (_, i) => {
    const lines = 50 * 2 ** (i % 7) + 13 * i;
    const ui = uiAt(i);
    const turns = Math.exp(
      LAW.a + LAW.b * Math.log(lines) + LAW.c * (ui ? 1 : 0) + jitter(i, 0.05),
    );
    const avg = LAW.g0 + LAW.g1 * turns + jitter(i + 3, 20_000);
    const ctxSumM = (turns * avg) / 1e6;
    const mainQU = LAW.ma + LAW.mT * turns + LAW.mC * ctxSumM;
    const rechecks = Math.max(
      0,
      -2 + 0.6 * Math.log(lines) + 0.5 * (ui ? 1 : 0) + jitter(i + 5, 0.1),
    );
    const runs = [
      { agentType: 'Plan', model: 'claude-fable-5-2', qu: 2.5 + jitter(i, 0.2) },
      { agentType: 'review-correctness', model: 'claude-opus-5-5', qu: 1.5 + jitter(i + 1, 0.2) },
      { agentType: 'review-fixes', model: 'claude-opus-5-5', qu: 1.2 },
      { agentType: 'review-fixes', model: 'claude-opus-5-5', qu: 1.2 },
    ];
    return prRow({
      number: 100 + i,
      branch: `lane-${i}`,
      lines,
      ui,
      turns,
      ctxSumM,
      mainQU,
      rechecks,
      runs,
      qu: mainQU + runs.reduce((s, r) => s + r.qu, 0),
    });
  });
}

describe('ols', () => {
  it('recovers planted coefficients and refuses a singular or too-short design', () => {
    const X = [1, 2, 3, 4, 5].map((x) => [1, x, x * x]);
    const f = ols(
      X,
      X.map(([, x]) => 2 - 3 * x! + 0.5 * x! * x!),
    )!;
    expect(f.coef.map((c) => +c.toFixed(9))).toEqual([2, -3, 0.5]);
    expect(f.r2).toBeCloseTo(1);
    expect(
      ols(
        [1, 2, 3, 4].map((x) => [1, x, 2 * x]),
        [1, 2, 3, 4],
      ),
    ).toBeNull();
    expect(ols([[1, 1]], [1])).toBeNull();
  });
});

describe('priors', () => {
  it('overlays a priors file key by key, ignoring what does not fit, never touching the defaults', () => {
    const { priors, bad } = mergePriors({
      _note: 'skipped',
      turns: { a: 9, extra: 1 },
      prices: { Plan: 5, 'review-new': 2, 'review-shell': -1 },
      band: 0.5,
      k: { k: 0.3 }, // above hi: the pair is kept at the default
      ctx: 'x',
      other: 1,
    });
    expect(priors.turns).toEqual({ ...DEFAULT_PRIORS.turns, a: 9 });
    expect(priors.prices).toMatchObject({ Plan: 5, 'review-new': 2, 'review-shell': 1 });
    expect(priors.band).toBe(DEFAULT_PRIORS.band);
    expect(priors.k).toEqual(DEFAULT_PRIORS.k);
    expect(bad).toEqual([
      'turns.extra',
      'prices.review-shell',
      'band',
      'ctx',
      'other',
      'k (needs lo ≤ k ≤ hi)',
    ]);
    expect(DEFAULT_PRIORS.turns.a).not.toBe(9);
    expect(mergePriors([1]).bad).toEqual(['not an object']);
  });

  it('the fit and its fallbacks use the priors it is given', () => {
    const P = mergePriors({ turns: { a: 1 }, prices: { 'review-infra': 7 }, band: 4 }).priors;
    const u = fitUnits(planted(MIN_FIT - 1), P);
    expect(u.turns.v.a).toBe(1);
    expect(u.prices.get('review-infra')!.v).toBe(7);
    expect(predict(u, { lines: 500, ui: false, lenses: [], fanout: 0 }).quRange.hi).toBeCloseTo(
      predict(u, { lines: 500, ui: false, lenses: [], fanout: 0 }).qu * 4,
    );
    expect(bandOf(null, P)).toEqual({ lo: 0.25, hi: 4, basis: 'prior' });
  });
});

describe('fitting the units', () => {
  it('recovers the planted laws from enough lens-regime PRs', () => {
    const u = fitUnits(planted(20));
    expect(u.regime).toBe(20);
    expect(u.turns.basis).toBe('fitted');
    expect(u.turns.v.a).toBeCloseTo(LAW.a, 1);
    expect(u.turns.v.bLines).toBeCloseTo(LAW.b, 1);
    expect(u.turns.v.cUi).toBeCloseTo(LAW.c, 1);
    expect(u.main.v.bT).toBeCloseTo(LAW.mT, 4);
    expect(u.main.v.cCtx).toBeCloseTo(LAW.mC, 4);
    expect(u.ctx.v.g1).toBeCloseTo(LAW.g1, -2);
    expect(u.ctx.v.g0).toBeCloseTo(LAW.g0, -4);
    expect(u.rechecks.basis).toBe('fitted');
    expect(u.rechecks.v.a).toBeCloseTo(-2, 0);
    expect(u.rechecks.v.bLines).toBeCloseTo(0.6, 1);
    expect(u.rechecks.v.cUi).toBeCloseTo(0.5, 1);
    expect(u.turns.v.smear).toBeCloseTo(1, 2);
    expect(u.prices.get('review-correctness')).toMatchObject({ basis: 'fitted', n: 20 });
    expect(u.prices.get('review-correctness')!.v).toBeCloseTo(1.5, 0);
    // a recheck is priced per run, the lens per PR
    expect(u.prices.get('review-fixes')!.v).toBeCloseTo(1.2);
    // a type no PR ran keeps its prior
    expect(u.prices.get('review-infra')).toMatchObject({
      basis: 'prior',
      v: DEFAULT_PRIORS.prices['review-infra'],
    });
  });

  it('falls back to every prior under MIN_FIT regime PRs, saying so', () => {
    const u = fitUnits(planted(MIN_FIT - 1));
    for (const c of [u.turns, u.main, u.ctx, u.rechecks]) expect(c.basis).toBe('prior');
    expect(u.turns.v).toEqual(DEFAULT_PRIORS.turns);
    // non-regime PRs don't count toward the fit set
    const mixed = [
      ...planted(MIN_FIT - 1),
      ...planted(5).map((r) => ({ ...r, lensRegime: false })),
    ];
    expect(regimeRows(mixed)).toHaveLength(MIN_FIT - 1);
    expect(fitUnits(mixed).turns.basis).toBe('prior');
  });

  it('keeps the prior ui coefficient when a ui class is thin, fitting the rest', () => {
    const u = fitUnits(planted(20, (i) => i < 2));
    expect(u.turns.basis).toBe('fitted');
    expect(u.turns.v.cUi).toBe(DEFAULT_PRIORS.turns.cUi);
    expect(u.rechecks.v.cUi).toBe(DEFAULT_PRIORS.rechecks.cUi);
  });

  it('prices a lens per PR: two runs in one PR sum, and it needs MIN_RUNS PRs, not runs', () => {
    const twice = planted(20).map((r) => ({
      ...r,
      runs: [...r.runs, { agentType: 'review-correctness', model: 'claude-opus-5-5', qu: 1.5 }],
    }));
    expect(fitUnits(twice).prices.get('review-correctness')!.v).toBeCloseTo(3, 0);
    const few = planted(20).map((r, i) =>
      i < 2
        ? {
            ...r,
            runs: [
              ...r.runs,
              ...Array.from({ length: 3 }, () => ({
                agentType: 'review-ui',
                model: 'claude-opus-5-5',
                qu: 9,
              })),
            ],
          }
        : r,
    );
    expect(fitUnits(few).prices.get('review-ui')).toMatchObject({ basis: 'prior', n: 6 });
  });

  it('keeps a prior when a fit is singular, and with nearly every PR ui', () => {
    const flat = planted(20).map((r) => ({ ...r, lines: 500, turns: 100 }));
    const u = fitUnits(flat);
    expect(u.turns.basis).toBe('prior'); // ln lines is constant beside the intercept
    expect(u.ctx.basis).toBe('prior');
    const ui = fitUnits(planted(20, (i) => i >= 2));
    expect(ui.turns.basis).toBe('fitted');
    expect(ui.turns.v.cUi).toBe(DEFAULT_PRIORS.turns.cUi);
  });

  it('never prices a task below zero', () => {
    const u = fitUnits(planted(20));
    const neg = { ...u, main: { ...u.main, v: { a: -5, bT: -1, cCtx: 0 } } };
    expect(mainOf(neg, 50)).toBe(0);
    const negCtx = { ...u, ctx: { ...u.ctx, v: { g0: -1e6, g1: 0 } } };
    expect(mainOf(negCtx, 10)).toBeCloseTo(Math.max(0, u.main.v.a + u.main.v.bT * 10));
  });

  it('prices a type under MIN_RUNS runs at its prior', () => {
    const rows = planted(20).map((r, i) =>
      i < 4
        ? {
            ...r,
            runs: [...r.runs, { agentType: 'review-shell', model: 'claude-opus-5-5', qu: 9 }],
          }
        : r,
    );
    expect(fitUnits(rows).prices.get('review-shell')).toMatchObject({ basis: 'prior', n: 4 });
  });
});

describe('predicting a task', () => {
  const u = fitUnits(planted(20));
  const base = { lines: 1000, ui: false, lenses: ['review-correctness'], fanout: 0 };

  it('composes turns, main and agents; grows with lines, ui, lenses and fan-out', () => {
    const e = predict(u, base);
    expect(e.turns).toBeCloseTo(turnsOf(u, 1000, false));
    expect(e.main).toBeCloseTo(mainOf(u, e.turns));
    expect(e.qu).toBeCloseTo(e.main + e.agents.reduce((s, a) => s + a.qu, 0));
    expect(e.agents.map((a) => a.what.split(' ')[0])).toEqual([
      'Plan',
      'code-reviewer',
      'review-correctness',
      'review-fixes',
    ]);
    expect(predict(u, { ...base, lines: 3000 }).qu).toBeGreaterThan(e.qu);
    expect(predict(u, { ...base, ui: true }).turns).toBeGreaterThan(e.turns);
    expect(predict(u, { ...base, lenses: [...base.lenses, 'review-infra'] }).qu).toBeCloseTo(
      e.qu + DEFAULT_PRIORS.prices['review-infra']!,
    );
    expect(predict(u, { ...base, fanout: 2 }).qu).toBeCloseTo(
      e.qu + 2 * DEFAULT_PRIORS.prices['general-purpose']!,
    );
    // rules is always in; naming it again doesn't price it twice
    expect(predict(u, { ...base, lenses: ['code-reviewer', ...base.lenses] }).qu).toBeCloseTo(e.qu);
  });

  it('brackets the point with the band and turns QU into % through k', () => {
    const e = predict(
      u,
      base,
      { lo: 1.1, hi: 1.4, basis: 'fitted' },
      { k: 0.05, lo: 0.04, hi: 0.06 },
    );
    expect(e.quRange.lo).toBeCloseTo(e.qu); // a band above 1 still starts at the point
    expect(e.quRange.hi).toBeCloseTo(e.qu * 1.4);
    expect(e.pct).toBeCloseTo(e.qu * 0.05);
    expect(e.pctRange).toEqual({ lo: e.quRange.lo * 0.04, hi: e.quRange.hi * 0.06 });
    const p = predict(u, base);
    expect(p.quRange.lo).toBeCloseTo(p.qu / DEFAULT_PRIORS.band);
    expect(p.pct).toBeCloseTo(p.qu * DEFAULT_PRIORS.k.k);
  });

  it('reads a merged PR back into the inputs it would have been estimated from', () => {
    const r = prRow({
      lines: 700,
      ui: true,
      runs: [
        { agentType: 'code-reviewer', model: 'claude-opus-5-5', qu: 1 },
        { agentType: 'review-shell', model: 'claude-opus-5-5', qu: 1 },
        { agentType: 'review-shell', model: 'claude-opus-5-5', qu: 1 },
        { agentType: 'review-fixes', model: 'claude-opus-5-5', qu: 1 },
        { agentType: 'general-purpose', model: 'claude-opus-5-5', qu: 1 },
        { agentType: 'general-purpose', model: 'claude-opus-5-5', qu: 1 },
        { agentType: 'Explore', model: 'claude-haiku-5-5', qu: 1 },
      ],
    });
    expect(inputsOf(r)).toEqual({
      lines: 700,
      ui: true,
      lenses: ['code-reviewer', 'review-shell'],
      fanout: 2,
    });
  });
});

describe('the backtest', () => {
  it('predicts each PR from the others only', () => {
    const rows = planted(16);
    const before = backtest(rows).rows.find((r) => r.number === 105)!;
    const spiked = rows.map((r) =>
      r.number === 105 ? { ...r, qu: r.qu * 10, turns: r.turns * 3 } : r,
    );
    const after = backtest(spiked).rows.find((r) => r.number === 105)!;
    expect(after.pred).toBe(before.pred); // its own outlier never moves its own prediction
    expect(after.qu).toBeCloseTo(before.qu * 10);
    expect(backtest(spiked).rows.find((r) => r.number === 104)!.pred).not.toBe(
      backtest(rows).rows.find((r) => r.number === 104)!.pred,
    );
  });

  it('scores the model against the type median, and the planted world fits closely', () => {
    const b = backtest(planted(20));
    expect(b.model.n).toBe(20);
    expect(b.model.rmsX).toBeLessThan(1.1);
    expect(b.model.within15).toBe(20);
    expect(b.model.actual).toBeCloseTo(planted(20).reduce((s, r) => s + r.qu, 0));
    expect(b.type.n).toBe(20);
    expect(b.type.rmsX).toBeGreaterThan(b.model.rmsX); // one median can't follow lines
    expect(b.errors).toHaveLength(20);
    expect(b.dropped).toBe(0);
  });

  it('counts a PR it could not score instead of hiding it', () => {
    const P = mergePriors({}).priors;
    const zero = {
      ...P,
      main: { a: -100, bT: 0, cCtx: 0 },
      prices: Object.fromEntries(Object.keys(P.prices).map((k) => [k, 0])),
    };
    const b = backtest(
      planted(MIN_FIT - 1).map((r) => ({ ...r, runs: [] })),
      zero,
    );
    expect(b.dropped).toBe(MIN_FIT - 1);
    expect(b.model.n).toBe(0);
  });

  it('gives the band from its error quantiles once every fold refit on MIN_FIT PRs, else the prior', () => {
    expect(bandOf(null)).toEqual({
      lo: 1 / DEFAULT_PRIORS.band,
      hi: DEFAULT_PRIORS.band,
      basis: 'prior',
    });
    expect(bandOf(backtest(planted(MIN_FIT - 1))).basis).toBe('prior');
    // at exactly MIN_FIT each fold sees MIN_FIT - 1: all priors, so not a fitted band
    expect(bandOf(backtest(planted(MIN_FIT))).basis).toBe('prior');
    expect(bandOf(backtest(planted(MIN_FIT + 1))).basis).toBe('fitted');
    const b = bandOf(backtest(planted(20)));
    expect(b.basis).toBe('fitted');
    expect(b.lo).toBeLessThan(1);
    expect(b.hi).toBeGreaterThan(1);
  });
});

describe('what an estimate stands on', () => {
  type Fit = Parameters<typeof estimateBasis>[1];
  const fit = (k: number | null, k80: { lo: number; hi: number } | null) =>
    ({ all: { fit: k === null ? null : { k }, unc: k80 ? { k80 } : null } }) as unknown as Fit;

  it('fits units, band and k from enough PRs and a meter fit, else says prior for each', () => {
    const b = estimateBasis(planted(20), fit(0.07, { lo: 0.06, hi: 0.08 }), DEFAULT_PRIORS);
    expect(b.units.turns.basis).toBe('fitted');
    expect(b.band.basis).toBe('fitted');
    expect(b.k).toEqual({ k: 0.07, lo: 0.06, hi: 0.08, basis: 'fitted' });
    // a meter fit without its interval, or with k ≤ 0, is no fitted k
    expect(estimateBasis(planted(20), fit(0.07, null), DEFAULT_PRIORS).k.basis).toBe('prior');
    expect(estimateBasis(planted(20), fit(0, { lo: 0, hi: 0 }), DEFAULT_PRIORS).k.basis).toBe(
      'prior',
    );
    const none = estimateBasis([], fit(null, null), DEFAULT_PRIORS);
    expect(none.units.turns.basis).toBe('prior');
    expect(none.band).toEqual(bandOf(null));
    expect(none.k).toEqual({ ...DEFAULT_PRIORS.k, basis: 'prior' });
  });
});
