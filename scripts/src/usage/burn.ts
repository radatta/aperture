// `pnpm usage burn [--at HH:MM]` (the hub's /burn): usage now, and where it lands at the weekly reset and at a named
// time, low–high. The range is k's 80% interval × the last hour's QU (+ λ), widened to hold the meter's own tick
// rate; it assumes the last hour's pace holds. Pure.
import { hoursTo100, type FitModel } from './model.ts';

type Fmt = (t: number) => string;
// the process's own zone, the one `--at HH:MM` is read in (away.ts stopAt), so the echoed time is the asked one
export const hm: Fmt = (t) =>
  new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const day: Fmt = (t) => `${new Date(t).toLocaleDateString('en-US', { weekday: 'short' })} ${hm(t)}`;
const f1 = (x: number) => x.toFixed(1);
const pct = (x: number) => `${Math.round(Math.min(100, Math.max(0, x)))}%`;
const hours = (ms: number) => `${f1(ms / 3_600_000)} h`;

export type Rates = { point: number; lo: number; hi: number } | null;

// %/h: the point (the tick rate, else k × QU/h) and a low–high from k's 80% interval, widened to hold the point. A
// point from the fit (no ticks) carries no λ (model.ts), so its range doesn't either: one formula for both ends.
export function rates(m: FitModel): { point: number | null; range: Rates } {
  const b = m.burn;
  const point = b.pctPerHour;
  const k80 = m.all.unc?.k80;
  const lambda = b.since === null ? 0 : (m.all.fit?.lambda ?? 0);
  if (point === null || !k80 || b.quPerHour === null) return { point, range: null };
  const lo = Math.min(point, k80.lo * b.quPerHour + lambda);
  const hi = Math.max(point, k80.hi * b.quPerHour + lambda);
  return { point, range: { point, lo: Math.max(0, lo), hi } };
}

// Where a % at `at` lands by `t` at `rate` %/h; at 100 first, when it gets there — from model.ts hoursTo100, the
// status line's own clock, so /burn and `usage line` name one time.
function land(
  p: number,
  at: number,
  rate: number,
  t: number,
  now: number,
): { pct: number; full: number | null } {
  if (rate <= 0) return { pct: p, full: null };
  const full = now + hoursTo100(p, at, rate, now) * 3_600_000;
  if (t < full) return { pct: Math.min(99, p + (rate * (t - at)) / 3_600_000), full: null };
  return { pct: 100, full };
}

// One projection row. Past 100% at the point rate: when it gets there, fastest to slowest; else the % with its range,
// and when the fast end would hit 100.
function row(
  label: string,
  p: number,
  at: number,
  r: { point: number; range: Rates },
  t: number,
  now: number,
  f: Fmt,
) {
  const mid = land(p, at, r.point, t, now);
  const lo = r.range ? land(p, at, r.range.lo, t, now) : null;
  const hi = r.range ? land(p, at, r.range.hi, t, now) : null;
  const pad = label.padEnd(10);
  if (mid.full !== null) {
    const span =
      lo && hi
        ? ` (${f(hi.full!)}–${lo.full !== null ? f(lo.full) : `not by then, ${pct(lo.pct)}`})`
        : '';
    return `  ${pad} 100% from ~${f(mid.full)}${span}`;
  }
  if (!lo || !hi) return `  ${pad} ${pct(mid.pct)}`;
  return `  ${pad} ${pct(mid.pct)} (${pct(lo.pct).slice(0, -1)}–${pct(hi.pct)}${hi.full !== null ? `, 100% possible from ${f(hi.full)}` : ''})`;
}

export function burnLines(
  m: FitModel,
  at: number | null,
  now: number,
  f: Fmt = hm,
  fd: Fmt = day,
): string[] {
  const b = m.burn;
  if (b.resetAt !== null) return [`BURN reset ${fd(b.resetAt)} · no reading since`];
  if (b.pct === null || b.at === null)
    return ['BURN unknown (no meter reading: pnpm usage doctor)'];
  const r = rates(m);
  const head = [
    `BURN ${b.pct}% (${f(b.at)})`,
    r.point === null
      ? 'rate unknown'
      : `${f1(r.point)}%/h${b.since !== null ? ` (ticks since ${f(b.since)})` : ' (k × the last hour)'}`,
    b.nextReset !== null
      ? `resets ${fd(b.nextReset)} (in ${hours(b.nextReset - now)})`
      : 'reset unknown',
  ].join(' · ');
  if (r.point === null) return [head];
  const out = [head];
  const pr = { point: r.point, range: r.range };
  if (b.nextReset !== null) out.push(row('at reset', b.pct, b.at, pr, b.nextReset, now, f));
  // past the reset the meter starts again near 0: no projection runs through it
  if (at !== null)
    out.push(
      b.nextReset !== null && at > b.nextReset
        ? `  ${`at ${f(at)}`.padEnd(10)} after the reset (${fd(b.nextReset)}): the meter starts again near 0`
        : row(`at ${f(at)}`, b.pct, b.at, pr, at, now, f),
    );
  out.push(
    r.range
      ? "  range: k's 80% interval × the last hour's QU (+ λ), widened to hold the tick rate; assumes the last hour's pace holds"
      : "  no range: too few intervals for k's interval (pnpm usage fit)",
  );
  return out;
}
