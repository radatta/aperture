// Estimate a task's QU from what is known before the work: diff lines, whether it needs a browser or device check,
// the review lenses its paths call for, and the fan-out agents its plan names (docs/ops/USAGE-METER.md → Estimate).
//   turns  T = exp(a + b·ln lines + c·ui) · smear
//   main   = a + b·T + c·ctxSumM, with the average context ≈ g0 + g1·T, so ctxSumM = T·(g0 + g1·T) / 1e6
//   agents = Plan + rules lens + the other lenses + rechecks(lines, ui) · recheck price + fan-out · its price
// Every constant is fitted from this repo's own merged PRs in the lens regime; under the thin-data rules below it
// falls back to its prior (priors.json, else the placeholders below) and says so. The numbers don't transfer
// between repos, the structure does. Pure: the CLI passes the PR table and the priors in.
import { isReviewLens, type PRRow } from './prs.ts';
import { median, ols, quantile } from './stats.ts';
import { typePrices } from './units.ts';

export type Basis = 'fitted' | 'prior';
export interface Coef<T> {
  v: T;
  basis: Basis;
  n: number;
  r2?: number;
}

export interface Priors {
  turns: { a: number; bLines: number; cUi: number; smear: number };
  main: { a: number; bT: number; cCtx: number };
  ctx: { g0: number; g1: number };
  rechecks: { a: number; bLines: number; cUi: number };
  prices: Record<string, number>; // QU per PR, or per run for PER_RUN types
  band: number; // the range is QU ÷ band to × band until the backtest has MIN_FIT errors
  k: { k: number; lo: number; hi: number }; // meter % per QU, with its 80% interval
}

// Placeholders, every number invented, so a fresh checkout and CI run end to end. A real fit's values are usage
// numbers and costs, so they live only in the usage dir's gitignored priors.json, which overlays these
// (docs/ops/USAGE-METER.md → Estimate). The output says which it used.
export const DEFAULT_PRIORS: Priors = {
  turns: { a: 3, bLines: 0.4, cUi: 0.5, smear: 1 },
  main: { a: 1, bT: 0.02, cCtx: 0.25 },
  ctx: { g0: 150_000, g1: 300 },
  rechecks: { a: -2, bLines: 0.6, cUi: 0.5 },
  prices: {
    Plan: 1,
    'code-reviewer': 1,
    'review-correctness': 1,
    'review-tests': 1,
    'review-shell': 1,
    'review-infra': 1,
    'review-ui': 1,
    'review-extension': 1,
    'review-fixes': 1,
    'general-purpose': 1,
  },
  band: 2,
  k: { k: 0.1, lo: 0.05, hi: 0.2 },
};

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

// A priors.json's numbers over the defaults, key by key; anything else is named in bad, never applied. A price, the
// band, the smearing factor and k with its interval must be positive; a price only for a type the defaults know (a
// misspelt one would leave the real type on its placeholder). placeholders: every number the file didn't set.
export function mergePriors(raw: unknown): {
  priors: Priors;
  bad: string[];
  placeholders: string[];
} {
  const priors = structuredClone(DEFAULT_PRIORS);
  const bad: string[] = [];
  const set = new Set<string>();
  const all = (Object.keys(DEFAULT_PRIORS) as (keyof Priors)[]).flatMap((k) =>
    k === 'band' ? ['band'] : Object.keys(DEFAULT_PRIORS[k]).map((f) => `${k}.${f}`),
  );
  const done = () => ({ priors, bad, placeholders: all.filter((x) => !set.has(x)) });
  if (!isObj(raw)) {
    bad.push('not an object');
    return done();
  }
  const positive = new Set(['prices', 'band', 'k', 'turns.smear']);
  for (const [key, v] of Object.entries(raw)) {
    if (key.startsWith('_')) continue; // a comment
    if (!Object.hasOwn(DEFAULT_PRIORS, key)) {
      bad.push(key);
      continue;
    }
    if (key === 'band') {
      if (isNum(v) && v >= 1) {
        priors.band = v;
        set.add('band');
      } else bad.push(key);
      continue;
    }
    if (!isObj(v)) {
      bad.push(key);
      continue;
    }
    const into = priors[key as Exclude<keyof Priors, 'band'>] as Record<string, number>;
    for (const [f, x] of Object.entries(v)) {
      const name = `${key}.${f}`;
      const ok = isNum(x) && (!(positive.has(key) || positive.has(name)) || x > 0);
      if (Object.hasOwn(into, f) && ok) {
        into[f] = x as number;
        set.add(name);
      } else bad.push(name);
    }
  }
  if (!(priors.k.lo <= priors.k.k && priors.k.k <= priors.k.hi)) {
    bad.push('k (needs lo ≤ k ≤ hi)');
    priors.k = { ...DEFAULT_PRIORS.k };
    for (const f of ['k', 'lo', 'hi']) set.delete(`k.${f}`);
  }
  return done();
}

// --lenses names → agent types. Plan and the rules lens always run.
export const LENSES: Record<string, string> = {
  rules: 'code-reviewer',
  correctness: 'review-correctness',
  tests: 'review-tests',
  shell: 'review-shell',
  infra: 'review-infra',
  ui: 'review-ui',
  extension: 'review-extension',
};
// Priced per run, times a count: the recheck and the fan-out agent. The rest are priced per PR.
const PER_RUN = new Set(['review-fixes', 'general-purpose']);

export const MIN_FIT = 12; // regime PRs before any regression is fitted
export const MIN_CLASS = 3; // PRs in each ui class before the ui coefficient is
export const MIN_RUNS = 5; // runs before an agent type's price is

export interface Units {
  turns: Coef<Priors['turns']>;
  main: Coef<Priors['main']>;
  ctx: Coef<Priors['ctx']>;
  rechecks: Coef<Priors['rechecks']>;
  prices: Map<string, Coef<number>>;
  regime: number;
  priors: Priors;
}

export const regimeRows = (rows: PRRow[]) =>
  rows.filter((r) => r.lensRegime && r.qu > 0 && r.turns > 0 && r.lines > 0);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// y ~ a + b·ln lines + c·ui; with a thin ui class, c stays at its prior and only a, b are fitted.
function lineUiFit(
  rs: PRRow[],
  y: (r: PRRow) => number,
  prior: { a: number; bLines: number; cUi: number },
) {
  const ones = rs.filter((r) => r.ui).length;
  if (Math.min(ones, rs.length - ones) >= MIN_CLASS) {
    const f = ols(
      rs.map((r) => [1, Math.log(r.lines), r.ui ? 1 : 0]),
      rs.map(y),
    );
    return f && { a: f.coef[0]!, bLines: f.coef[1]!, cUi: f.coef[2]!, r2: f.r2, resid: f.resid };
  }
  const f = ols(
    rs.map((r) => [1, Math.log(r.lines)]),
    rs.map((r) => y(r) - prior.cUi * (r.ui ? 1 : 0)),
  );
  return f && { a: f.coef[0]!, bLines: f.coef[1]!, cUi: prior.cUi, r2: f.r2, resid: f.resid };
}

export function fitUnits(rows: PRRow[], P: Priors = DEFAULT_PRIORS): Units {
  const rs = regimeRows(rows);
  const n = rs.length;
  const prior = <T>(v: T): Coef<T> => ({ v, basis: 'prior', n });
  const enough = n >= MIN_FIT;

  let turns = prior(P.turns);
  const t = enough ? lineUiFit(rs, (r) => Math.log(r.turns), P.turns) : null;
  // smearing: the mean of exp(residual) undoes the log fit's bias toward the geometric mean
  if (t)
    turns = {
      v: { a: t.a, bLines: t.bLines, cUi: t.cUi, smear: mean(t.resid.map(Math.exp)) },
      basis: 'fitted',
      n,
      r2: t.r2,
    };

  let main = prior(P.main);
  const m = enough
    ? ols(
        rs.map((r) => [1, r.turns, r.ctxSumM]),
        rs.map((r) => r.mainQU),
      )
    : null;
  if (m)
    main = { v: { a: m.coef[0]!, bT: m.coef[1]!, cCtx: m.coef[2]! }, basis: 'fitted', n, r2: m.r2 };

  let ctx = prior(P.ctx);
  const c = enough
    ? ols(
        rs.map((r) => [1, r.turns]),
        rs.map((r) => (r.ctxSumM * 1e6) / r.turns),
      )
    : null;
  if (c) ctx = { v: { g0: c.coef[0]!, g1: c.coef[1]! }, basis: 'fitted', n, r2: c.r2 };

  let rechecks = prior(P.rechecks);
  const k = enough ? lineUiFit(rs, (r) => r.rechecks, P.rechecks) : null;
  if (k) rechecks = { v: { a: k.a, bLines: k.bLines, cUi: k.cUi }, basis: 'fitted', n, r2: k.r2 };

  const seen = typePrices(rs);
  const prices = new Map<string, Coef<number>>();
  for (const type of new Set([...Object.keys(P.prices), ...seen.keys()])) {
    const s = seen.get(type);
    // a per-PR price needs MIN_RUNS PRs, not MIN_RUNS runs that one or two PRs made
    if (s && (PER_RUN.has(type) ? s.runs : s.prs) >= MIN_RUNS)
      prices.set(type, { v: PER_RUN.has(type) ? s.perRun : s.perPR, basis: 'fitted', n: s.runs });
    else if (type in P.prices)
      prices.set(type, { v: P.prices[type]!, basis: 'prior', n: s?.runs ?? 0 });
  }
  return { turns, main, ctx, rechecks, prices, regime: n, priors: P };
}

export interface EstimateIn {
  lines: number;
  ui: boolean;
  lenses: string[]; // agent types beyond Plan and the rules lens
  fanout: number;
}
export interface Range {
  lo: number;
  hi: number;
  basis: Basis;
}
export interface Estimate {
  turns: number;
  main: number;
  agents: { what: string; qu: number; basis: Basis }[];
  rechecks: number;
  qu: number;
  quRange: { lo: number; hi: number };
  pct: number;
  pctRange: { lo: number; hi: number };
}

export const turnsOf = (u: Units, lines: number, ui: boolean) => {
  const t = u.turns.v;
  return Math.exp(t.a + t.bLines * Math.log(Math.max(lines, 1)) + t.cUi * (ui ? 1 : 0)) * t.smear;
};
// never below 0: a fit with a negative slope must not turn a long task into a credit
export const mainOf = (u: Units, T: number) => {
  const ctxSumM = Math.max(0, (T * (u.ctx.v.g0 + u.ctx.v.g1 * T)) / 1e6);
  return Math.max(0, u.main.v.a + u.main.v.bT * T + u.main.v.cCtx * ctxSumM);
};

// band: multipliers on the QU point (the backtest's error quantiles, else the prior); k: meter % per QU with its 80%.
export function predict(
  u: Units,
  inp: EstimateIn,
  band: Range = bandOf(null, u.priors),
  k: { k: number; lo: number; hi: number } = u.priors.k,
): Estimate {
  const T = turnsOf(u, inp.lines, inp.ui);
  const main = mainOf(u, T);
  const price = (t: string) =>
    u.prices.get(t) ?? { v: u.priors.prices[t] ?? 0, basis: 'prior' as const, n: 0 };
  const agents: Estimate['agents'] = [];
  const push = (what: string, type: string, times = 1) => {
    const p = price(type);
    agents.push({ what, qu: p.v * times, basis: p.basis });
  };
  push('Plan', 'Plan');
  for (const t of new Set(['code-reviewer', ...inp.lenses])) push(t, t);
  const r = u.rechecks.v;
  const rechecks = Math.max(
    0,
    r.a + r.bLines * Math.log(Math.max(inp.lines, 1)) + r.cUi * (inp.ui ? 1 : 0),
  );
  push(`review-fixes ×${rechecks.toFixed(1)}`, 'review-fixes', rechecks);
  if (inp.fanout > 0) push(`general-purpose ×${inp.fanout}`, 'general-purpose', inp.fanout);
  const qu = main + agents.reduce((s, a) => s + a.qu, 0);
  const lo = qu * Math.min(1, band.lo);
  const hi = qu * Math.max(1, band.hi);
  return {
    turns: T,
    main,
    agents,
    rechecks,
    qu,
    quRange: { lo, hi },
    pct: qu * k.k,
    pctRange: { lo: lo * k.lo, hi: hi * k.hi },
  };
}

// What the formula would have been given for a merged PR: its lines and paths, and the lenses and fan-out it ran.
export function inputsOf(r: PRRow): EstimateIn {
  const lenses = [
    ...new Set(
      r.runs.map((x) => x.agentType).filter((t) => isReviewLens(t) && t !== 'review-fixes'),
    ),
  ];
  return {
    lines: r.lines,
    ui: r.ui,
    lenses,
    fanout: r.runs.filter((x) => x.agentType === 'general-purpose').length,
  };
}

export interface BacktestRow {
  number: number;
  branch: string;
  lines: number;
  ui: boolean;
  turns: number;
  predTurns: number;
  qu: number;
  pred: number;
  typePred: number;
}
export interface ErrStat {
  n: number;
  rmsX: number; // exp(rms of ln(actual / predicted))
  medianX: number; // exp(median |ln ratio|)
  within15: number; // PRs within ×1.5
  actual: number;
  predicted: number;
}
export interface Backtest {
  rows: BacktestRow[];
  model: ErrStat;
  type: ErrStat;
  errors: number[]; // ln(actual / predicted), the model's
  dropped: number; // PRs with no usable prediction (≤ 0 or NaN), left out of both scores
}

function errStat(actual: number[], pred: number[]): ErrStat {
  const e = actual.map((a, i) => Math.log(a / pred[i]!));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    n: e.length,
    rmsX: e.length ? Math.exp(Math.sqrt(mean(e.map((x) => x * x)))) : NaN,
    medianX: Math.exp(median(e.map(Math.abs))),
    within15: e.filter((x) => Math.abs(x) <= Math.log(1.5)).length,
    actual: sum(actual),
    predicted: sum(pred),
  };
}

// Leave-one-out over the lens-regime PRs: each PR predicted from a refit on the others (regressions and prices),
// beside the PR-type median of the others, the model this replaces.
export function backtest(rows: PRRow[], P: Priors = DEFAULT_PRIORS): Backtest {
  const rs = regimeRows(rows);
  const out: BacktestRow[] = rs.map((r) => {
    const others = rs.filter((x) => x !== r);
    const u = fitUnits(others, P);
    const same = others.filter((x) => x.type === r.type).map((x) => x.qu);
    return {
      number: r.number,
      branch: r.branch,
      lines: r.lines,
      ui: r.ui,
      turns: r.turns,
      predTurns: turnsOf(u, r.lines, r.ui),
      qu: r.qu,
      pred: predict(u, inputsOf(r)).qu,
      typePred: same.length ? median(same) : others.length ? median(others.map((x) => x.qu)) : NaN,
    };
  });
  const scored = out.filter((r) => r.pred > 0 && r.typePred > 0);
  return {
    rows: out,
    model: errStat(
      scored.map((r) => r.qu),
      scored.map((r) => r.pred),
    ),
    type: errStat(
      scored.map((r) => r.qu),
      scored.map((r) => r.typePred),
    ),
    errors: scored.map((r) => Math.log(r.qu / r.pred)),
    dropped: out.length - scored.length,
  };
}

// The QU band: the backtest's 10th–90th percentile errors once every fold refit on MIN_FIT PRs (so more than
// MIN_FIT errors; at exactly MIN_FIT each fold sees one fewer and is all priors), else the prior.
export function bandOf(b: Backtest | null, P: Priors = DEFAULT_PRIORS): Range {
  if (!b || b.errors.length <= MIN_FIT) return { lo: 1 / P.band, hi: P.band, basis: 'prior' };
  return {
    lo: Math.exp(quantile(b.errors, 0.1)),
    hi: Math.exp(quantile(b.errors, 0.9)),
    basis: 'fitted',
  };
}
