// Compose the loaded tables into what the report prints. Pure: the CLI loads files and passes them in.
import { fitKLambda, fitKOnly, holdout, uncertainty, type Fit, type Obs, type Uncertainty } from './fit.ts';
import {
  burn,
  costDeltas,
  freshReadings,
  intervals,
  manualWindows,
  ticks,
  type Interval,
  type Manual,
  type MeterRow,
} from './meter.ts';

// QU between two instants from time-sorted calls, by prefix sums.
export function quIndex(calls: { ts: number; qu: number }[]) {
  const ts = calls.map((c) => c.ts);
  const pre = [0];
  for (const c of calls) pre.push(pre.at(-1)! + c.qu);
  const upto = (t: number) => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return pre[lo];
  };
  return {
    between: (t0: number, t1: number) => upto(t1) - upto(t0),
    first: ts[0] ?? null,
    last: ts.at(-1) ?? null,
  };
}

const WEEK_MS = 7 * 86_400_000;

// Weekly resets the log's resets_at implies, back over the manual readings' span: an interval across one would
// difference across a reset. Added to the manual resets unless one is listed within an hour.
export function scheduledResets(rows: MeterRow[], manual: Manual | null): string[] {
  const known = (manual?.resets ?? []).map((r) => Date.parse(r));
  const firstReading = Math.min(...(manual?.readings ?? []).map((r) => Date.parse(r.at)));
  const out: string[] = [];
  for (const at of new Set(rows.flatMap((r) => (r.resetsAt ? [r.resetsAt * 1000] : [])))) {
    for (let t = at - WEEK_MS; t > firstReading; t -= WEEK_MS)
      if (!known.some((k) => Math.abs(k - t) < 3_600_000) && !out.includes(new Date(t).toISOString()))
        out.push(new Date(t).toISOString());
  }
  return out.sort();
}

export interface FitModel {
  inferredResets: string[];
  history: { obs: (Obs & Interval)[]; fit: Fit | null; unc: Uncertainty | null; kOnly: Fit | null };
  live: {
    obs: (Obs & Interval)[];
    holdout: ReturnType<typeof holdout> | null;
    logRatio: number | null; // calls-table QU / the log's summed cost deltas over the live ticks
    windows: number;
    stragglers: number;
  };
  all: { fit: Fit | null; unc: Uncertainty | null; kOnly: Fit | null };
  burn: {
    pct: number | null;
    pctPerHour: number | null;
    quPerHour: number | null;
    hoursTo100: number | null;
    since: number | null;
  };
  coverage: { from: number | null; to: number | null }; // the calls table's span; intervals outside it are dropped
}

export function fitModel(o: {
  rows: MeterRow[];
  manual: Manual | null;
  calls: { ts: number; qu: number }[];
  now: number;
}): FitModel {
  const q = quIndex(o.calls);
  const covered = (i: Interval) => q.first !== null && i.t0 >= q.first && i.t1 <= (q.last ?? 0);
  const toObs = (i: Interval): Obs & Interval => ({
    ...i,
    dQU: q.between(i.t0, i.t1),
    dT: (i.t1 - i.t0) / 3_600_000,
  });
  const inferred = scheduledResets(o.rows, o.manual);
  const manual = o.manual && { ...o.manual, resets: [...o.manual.resets, ...inferred] };
  const hist = (manual ? manualWindows(manual) : []).flatMap((w) => intervals(w)).filter(covered).map(toObs);
  const { windows, stragglers } = ticks(freshReadings(o.rows));
  const live = windows.flatMap((w) => intervals(w)).filter(covered).map(toObs);
  const fitOf = (obs: Obs[]) =>
    obs.length
      ? { fit: fitKLambda(obs), unc: uncertainty(obs, (x) => fitKLambda(x)), kOnly: fitKOnly(obs) }
      : { fit: null, unc: null, kOnly: null };
  const h = fitOf(hist);
  const all = fitOf([...hist, ...live]);

  // the log's own ΔQU over the live ticks, as a cross-check of the calls table
  const deltas = costDeltas(o.rows);
  const span = live.length ? [live[0].t0, live.at(-1)!.t1] : null;
  const logQU = span ? deltas.filter((d) => d.ts > span[0] && d.ts <= span[1]).reduce((a, d) => a + d.d, 0) : 0;
  const callQU = span ? q.between(span[0], span[1]) : 0;

  const lastWindow = windows.at(-1) ?? [];
  const b = burn(lastWindow, o.now);
  const k = all.fit?.k ?? null;
  const quPerHour = q.last !== null ? q.between(o.now - 3_600_000, o.now) : null;
  const pctPerHour = b?.perHour ?? (k !== null && quPerHour !== null ? k * quPerHour : null);
  return {
    inferredResets: inferred,
    history: { obs: hist, ...h },
    live: {
      obs: live,
      holdout: h.fit && live.length ? holdout(h.fit, live) : null,
      logRatio: logQU > 0 ? callQU / logQU : null,
      windows: windows.length,
      stragglers,
    },
    all,
    burn: {
      pct: b?.pct ?? null,
      pctPerHour,
      quPerHour,
      hoursTo100: b && pctPerHour ? Math.max(0, 100 - b.pct) / pctPerHour : null,
      since: b?.since ?? null,
    },
    coverage: { from: q.first, to: q.last },
  };
}
