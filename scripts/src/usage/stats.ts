// Small-sample statistics for the PR table: quantiles, log-cost shrinkage by type, rank correlation, a slope.

export const median = (xs: number[]) => quantile(xs, 0.5);

// Min/max by reduce: `Math.max(...xs)` throws past ~120k elements (one call frame per argument), and the meter log
// and a long-lived session's calls grow past that.
export const minOf = (xs: number[]) => xs.reduce((m, x) => (x < m ? x : m), Infinity);
export const maxOf = (xs: number[]) => xs.reduce((m, x) => (x > m ? x : m), -Infinity);

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.ceil(i)]! - s[lo]!) * (i - lo);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface GroupStat {
  group: string;
  n: number;
  min: number;
  median: number; // shrunk, exp(θ)
  max: number;
  p80: number; // exp(θ + 0.84·s)
  budgetMean: number; // exp(θ + s²/2), for totals
  rawMedian: number;
  shrunk: boolean;
}
export interface Shrinkage {
  groups: GroupStat[];
  s: number; // pooled sd of ln cost
  tau2: number; // between-group variance
  shrinkage: boolean; // false with under 3 groups or a group of 1
}

const Z80 = 0.8416;

// Empirical-Bayes shrinkage of each group's mean ln cost toward the overall mean, with the variance pooled across
// groups (docs/ops/USAGE-METER.md → PR types). Groups with no values are listed with n = 0.
export function shrinkLog(values: Record<string, number[]>): Shrinkage {
  const groups = Object.entries(values).map(([g, xs]) => ({
    g,
    ys: xs.filter((x) => x > 0).map(Math.log),
    xs,
  }));
  const full = groups.filter((g) => g.ys.length);
  const N = full.reduce((a, g) => a + g.ys.length, 0);
  const all = full.flatMap((g) => g.ys);
  const grand = all.length ? mean(all) : NaN;
  const within = full.reduce((a, g) => a + g.ys.reduce((b, y) => b + (y - mean(g.ys)) ** 2, 0), 0);
  const s2 = N - full.length > 0 ? within / (N - full.length) : all.length > 1 ? variance(all) : 0;
  const shrinkage = full.length >= 3 && full.every((g) => g.ys.length >= 2);
  const means = full.map((g) => mean(g.ys));
  const tau2 = shrinkage
    ? Math.max(0, variance(means) - s2 * mean(full.map((g) => 1 / g.ys.length)))
    : 0;
  const s = Math.sqrt(s2);
  return {
    s,
    tau2,
    shrinkage,
    groups: groups.map(({ g, ys, xs }) => {
      if (!ys.length)
        return {
          group: g,
          n: 0,
          min: NaN,
          median: NaN,
          max: NaN,
          p80: NaN,
          budgetMean: NaN,
          rawMedian: NaN,
          shrunk: false,
        };
      const m = mean(ys);
      const B = shrinkage && tau2 + s2 / ys.length > 0 ? tau2 / (tau2 + s2 / ys.length) : 1;
      const theta = B * m + (1 - B) * grand;
      const pos = xs.filter((x) => x > 0);
      return {
        group: g,
        n: ys.length,
        min: Math.min(...pos),
        max: Math.max(...pos),
        median: Math.exp(theta),
        p80: Math.exp(theta + Z80 * s),
        budgetMean: Math.exp(theta + s2 / 2),
        rawMedian: median(pos),
        shrunk: shrinkage,
      };
    }),
  };
}

function variance(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

function ranks(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

export function pearson(x: number[], y: number[]): number {
  if (x.length < 3) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export const spearman = (x: number[], y: number[]) => pearson(ranks(x), ranks(y));

// Ordinary least-squares slope of y on x (with intercept).
export function slope(x: number[], y: number[]): number {
  if (x.length < 3) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  return sxx ? sxy / sxx : NaN;
}

// Ordinary least squares, y on the columns of X (put a 1 column in for an intercept), by the normal equations and
// Gauss-Jordan with partial pivoting. null when X'X is singular or there are no more rows than columns.
export function ols(
  X: number[][],
  y: number[],
): { coef: number[]; r2: number; resid: number[] } | null {
  const p = X[0]?.length ?? 0;
  if (!p || X.length <= p || X.length !== y.length) return null;
  const A = Array.from({ length: p }, (_, i) => {
    const row = Array.from({ length: p + 1 }, () => 0);
    for (let n = 0; n < X.length; n++) {
      for (let j = 0; j < p; j++) row[j]! += X[n]![i]! * X[n]![j]!;
      row[p]! += X[n]![i]! * y[n]!;
    }
    return row;
  });
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    if (Math.abs(A[piv]![c]!) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let j = c; j <= p; j++) A[r]![j]! -= f * A[c]![j]!;
    }
  }
  const coef = A.map((row, i) => row[p]! / row[i]!);
  const fitted = X.map((row) => row.reduce((s, x, j) => s + x * coef[j]!, 0));
  const resid = y.map((v, i) => v - fitted[i]!);
  const my = mean(y);
  const ssTot = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const ssRes = resid.reduce((s, r) => s + r * r, 0);
  return { coef, r2: ssTot ? 1 - ssRes / ssTot : NaN, resid };
}
