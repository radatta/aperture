// k (meter % per QU) and λ (% per hour of drift, e.g. claude.ai chat sharing the meter) from intervals:
//   ΔP = k·ΔQU + λ·Δt + ε,  k, λ ≥ 0
// Weighted least squares, w = 1/(r + φ·ΔP): r is the readings' rounding variance, φ·ΔP lets a long interval
// count more without swamping the rest (a modelling choice: docs/ops/USAGE-METER.md → Fit). Hand-rolled: two
// parameters have a closed form, and the non-negative constraint is checked on the boundary.

export interface Obs {
  dP: number;
  dQU: number;
  dT: number; // hours
  r: number;
}
export interface Fit {
  k: number;
  lambda: number;
  lambdaFixed: boolean; // λ held at 0: too few intervals, or ΔQU and Δt move together
  n: number;
  sse: number;
}

export const PHI = 0.05;
const weight = (o: Obs) => 1 / (o.r + PHI * Math.max(o.dP, 0) + 1e-9);

function sse(obs: Obs[], k: number, l: number) {
  return obs.reduce((s, o) => s + weight(o) * (o.dP - k * o.dQU - l * o.dT) ** 2, 0);
}

// Weighted correlation of ΔQU and Δt (through the origin, as the model has no intercept).
function colinear(obs: Obs[]) {
  let xx = 0;
  let tt = 0;
  let xt = 0;
  for (const o of obs) {
    const w = weight(o);
    xx += w * o.dQU * o.dQU;
    tt += w * o.dT * o.dT;
    xt += w * o.dQU * o.dT;
  }
  return xx && tt ? xt / Math.sqrt(xx * tt) : 1;
}

export function fitKOnly(obs: Obs[]): Fit {
  let num = 0;
  let den = 0;
  for (const o of obs) {
    const w = weight(o);
    num += w * o.dQU * o.dP;
    den += w * o.dQU * o.dQU;
  }
  const k = den > 0 ? Math.max(0, num / den) : 0;
  return { k, lambda: 0, lambdaFixed: true, n: obs.length, sse: sse(obs, k, 0) };
}

export function fitKLambda(obs: Obs[], minN = 4, maxCorr = 0.98): Fit {
  if (obs.length < minN || colinear(obs) > maxCorr) return fitKOnly(obs);
  let xx = 0;
  let tt = 0;
  let xt = 0;
  let xy = 0;
  let ty = 0;
  for (const o of obs) {
    const w = weight(o);
    xx += w * o.dQU * o.dQU;
    tt += w * o.dT * o.dT;
    xt += w * o.dQU * o.dT;
    xy += w * o.dQU * o.dP;
    ty += w * o.dT * o.dP;
  }
  const det = xx * tt - xt * xt;
  const cands: [number, number][] = [
    [xx > 0 ? Math.max(0, xy / xx) : 0, 0],
    [0, tt > 0 ? Math.max(0, ty / tt) : 0],
    [0, 0],
  ];
  if (det > 0) {
    const k = (xy * tt - ty * xt) / det;
    const l = (ty * xx - xy * xt) / det;
    if (k >= 0 && l >= 0) cands.unshift([k, l]);
  }
  const [k, lambda] = cands.reduce((best, c) => (sse(obs, ...c) < sse(obs, ...best) ? c : best));
  return { k, lambda, lambdaFixed: false, n: obs.length, sse: sse(obs, k, lambda) };
}

// Small seeded PRNG (mulberry32): the bootstrap must give the same interval on every run.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.ceil(i)]! - s[lo]!) * (i - lo);
};

export interface Interval2 {
  lo: number;
  hi: number;
}
export interface Uncertainty {
  method: 'bootstrap' | 'leave-one-out' | 'none';
  k80?: Interval2;
  k95?: Interval2;
  lambda80?: Interval2;
  sdLnK: number; // for combining with a PR type's log-spread
}

// Resample intervals with replacement (B draws, fixed seed); with under 5 intervals the bootstrap is meaningless,
// so report the leave-one-out range instead.
export function uncertainty(obs: Obs[], fit: (o: Obs[]) => Fit, B = 2000, seed = 7): Uncertainty {
  if (obs.length < 2) return { method: 'none', sdLnK: NaN };
  const ks: number[] = [];
  const ls: number[] = [];
  if (obs.length < 5) {
    for (let i = 0; i < obs.length; i++) {
      const f = fit(obs.filter((_, j) => j !== i));
      ks.push(f.k);
      ls.push(f.lambda);
    }
    const r = { lo: Math.min(...ks), hi: Math.max(...ks) };
    return {
      method: 'leave-one-out',
      k80: r,
      k95: r,
      lambda80: { lo: Math.min(...ls), hi: Math.max(...ls) },
      sdLnK: sdLn(ks),
    };
  }
  const rand = rng(seed);
  for (let b = 0; b < B; b++) {
    const sample = obs.map(() => obs[Math.floor(rand() * obs.length)]!);
    const f = fit(sample);
    ks.push(f.k);
    ls.push(f.lambda);
  }
  return {
    method: 'bootstrap',
    k80: { lo: pct(ks, 0.1), hi: pct(ks, 0.9) },
    k95: { lo: pct(ks, 0.025), hi: pct(ks, 0.975) },
    lambda80: { lo: pct(ls, 0.1), hi: pct(ls, 0.9) },
    sdLnK: sdLn(ks),
  };
}

function sdLn(ks: number[]) {
  const l = ks.filter((k) => k > 0).map(Math.log);
  if (l.length < 2) return NaN;
  const m = l.reduce((a, b) => a + b, 0) / l.length;
  return Math.sqrt(l.reduce((a, b) => a + (b - m) ** 2, 0) / (l.length - 1));
}

// Score a fit on held-out intervals: mean absolute error in points, and the cumulative predicted vs actual ΔP.
export function holdout(f: Pick<Fit, 'k' | 'lambda'>, obs: Obs[]) {
  const pred = obs.map((o) => f.k * o.dQU + f.lambda * o.dT);
  const mae = obs.length
    ? obs.reduce((s, o, i) => s + Math.abs(o.dP - pred[i]!), 0) / obs.length
    : NaN;
  return {
    n: obs.length,
    mae,
    predicted: pred.reduce((a, b) => a + b, 0),
    actual: obs.reduce((a, o) => a + o.dP, 0),
  };
}
