// Compose the loaded tables into what the report prints. Pure: the CLI loads files and passes them in.
import {
  fitKLambda,
  fitKOnly,
  holdout,
  uncertainty,
  type Fit,
  type Obs,
  type Uncertainty,
} from './fit.ts';
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
import type { PR } from './gh.ts';
import { agreement, PHASES, type Phase } from './phases.ts';
import {
  attribute,
  overhead,
  prTable,
  PR_TYPES,
  type Overhead,
  type PRRow,
  type PRType,
} from './prs.ts';
import { concurrency, reviewRounds, type Concurrency, type JobEvent } from './questions.ts';
import { maxOf, median, minOf, shrinkLog, spearman } from './stats.ts';
import type { Loaded } from './store.ts';

// QU between two instants from time-sorted calls, by prefix sums.
export function quIndex(calls: { ts: number; qu: number }[]) {
  const ts = calls.map((c) => c.ts);
  const pre = [0];
  for (const c of calls) pre.push(pre[pre.length - 1]! + c.qu);
  const upto = (t: number) => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return pre[lo]!;
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
// The weekly resets the log's resets_at values imply over the manual readings' span. The oldest steps back a week at
// a time; each later value marks its own window's start and the weeks from the previous value up to it, which covers
// a week the log skipped and a manual reset before or after the previous scheduled one. Values within an hour are one
// (seconds of jitter), and so are inferred resets.
export function scheduledResets(rows: MeterRow[], manual: Manual | null): string[] {
  const near = (a: number, b: number) => Math.abs(a - b) < 3_600_000;
  const known = (manual?.resets ?? []).map((r) => Date.parse(r));
  const firstReading = minOf((manual?.readings ?? []).map((r) => Date.parse(r.at)));
  const ats: number[] = [];
  for (const at of rows
    .flatMap((r) => (r.resetsAt ? [r.resetsAt * 1000] : []))
    .sort((a, b) => a - b))
    if (!ats.some((x) => near(x, at))) ats.push(at);
  const cands: number[] = [];
  // the oldest: every week back to the first manual reading
  if (ats[0] !== undefined)
    for (let t = ats[0] - WEEK_MS; t > firstReading; t -= WEEK_MS) cands.push(t);
  // each later one: its own window's start, plus the weeks from the previous value up to that start (a week the
  // log skipped, or the reset a manual reset cut short)
  for (let i = 1; i < ats.length; i++) {
    const [p, a] = [ats[i - 1]!, ats[i]!];
    cands.push(a - WEEK_MS);
    for (let t = p; t < a - WEEK_MS - 3_600_000; t += WEEK_MS) cands.push(t);
  }
  const out: number[] = [];
  for (const t of cands.sort((x, y) => x - y))
    if (t > firstReading && ![...known, ...out].some((k) => near(k, t))) out.push(t);
  return out.map((t) => new Date(t).toISOString());
}

// From the newest reading: the meter has moved on since it ticked, by up to one point (it would have ticked again).
export function hoursTo100(pct: number, at: number, perHour: number, now: number): number {
  const since = Math.min(Math.max(0, now - at) / 3_600_000, 1 / perHour);
  return Math.max(0, (100 - pct) / perHour - since);
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
    since: number | null; // the rate's ticks start here
    resetAt: number | null; // the window's resets_at has passed with no fresh reading since: the numbers are stale
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
  const hist = (manual ? manualWindows(manual) : [])
    .flatMap((w) => intervals(w))
    .filter(covered)
    .map(toObs);
  const fresh = freshReadings(o.rows);
  const { windows, stragglers } = ticks(fresh);
  const live = windows
    .flatMap((w) => intervals(w))
    .filter(covered)
    .map(toObs);
  const fitOf = (obs: Obs[]) =>
    obs.length
      ? { fit: fitKLambda(obs), unc: uncertainty(obs, (x) => fitKLambda(x)), kOnly: fitKOnly(obs) }
      : { fit: null, unc: null, kOnly: null };
  const h = fitOf(hist);
  const all = fitOf([...hist, ...live]);

  // the log's own ΔQU over the live ticks, as a cross-check of the calls table
  const deltas = costDeltas(o.rows);
  const span = live.length ? ([live[0]!.t0, live.at(-1)!.t1] as const) : null;
  const logQU = span
    ? deltas.filter((d) => d.ts > span[0] && d.ts <= span[1]).reduce((a, d) => a + d.d, 0)
    : 0;
  const callQU = span ? q.between(span[0], span[1]) : 0;

  const lastWindow = windows.at(-1) ?? [];
  // stale once the latest resets_at any fresh reading carried has passed (a new week's reading carries a later one)
  const latestReset = maxOf(fresh.flatMap((r) => (r.resetsAt ? [r.resetsAt * 1000] : [])));
  const resetAt = Number.isFinite(latestReset) && o.now > latestReset ? latestReset : null;
  const b = resetAt === null ? burn(lastWindow, o.now) : null;
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
      hoursTo100: b && pctPerHour ? hoursTo100(b.pct, b.at, pctPerHour, o.now) : null,
      since: b?.perHour != null ? b.since : null,
      resetAt,
    },
    coverage: { from: q.first, to: q.last },
  };
}

export interface TypeRow {
  type: PRType;
  n: number;
  min: number;
  median: number;
  max: number;
  p80: number;
  pctMedian: number | null;
  pctP80: number | null;
  rawMedian: number;
}
export interface ReportModel {
  fit: FitModel;
  rows: PRRow[];
  types: TypeRow[];
  shrinkage: boolean;
  logSd: number;
  phaseShare: { phase: Phase; median: number; mean: number }[];
  drivers: { what: string; rho: number }[];
  top: PRRow[];
  overhead: Overhead;
  flags: { flag: string; calls: number; quShare: number }[];
  additivity: { sessions: number; medianRatio: number | null; outside: number };
  agreement: { share: number | null; sessions: number };
  dupes: number;
  orphans: number;
  totalQU: number;
  unattributedShare: number | null; // of lane QU in PR windows
  rounds: ReturnType<typeof reviewRounds>;
  concurrency: Concurrency;
}

export function reportModel(o: {
  rows: MeterRow[];
  manual: Manual | null;
  loaded: Loaded;
  prs: PR[];
  reports: Map<string, string>;
  events: JobEvent[];
  since: number;
  hub: string;
  now: number;
}): ReportModel {
  const fit = fitModel({ rows: o.rows, manual: o.manual, calls: o.loaded.calls, now: o.now });
  const a = attribute(o.loaded, o.hub);
  const rows = prTable(a, o.prs, o.since);
  const covered = rows.filter((r) => r.qu > 0);
  const k = fit.all.fit?.k ?? null;
  const sdLnK = fit.all.unc?.sdLnK;
  const sh = shrinkLog(
    Object.fromEntries(
      PR_TYPES.map((t) => [t, covered.filter((r) => r.type === t).map((r) => r.qu)]),
    ),
  );
  const sdPct = Math.sqrt(sh.s ** 2 + (Number.isFinite(sdLnK) ? (sdLnK as number) ** 2 : 0));
  const types: TypeRow[] = sh.groups.map((g) => ({
    type: g.group as PRType,
    n: g.n,
    min: g.min,
    median: g.median,
    rawMedian: g.rawMedian,
    max: g.max,
    p80: g.p80,
    pctMedian: k !== null && g.n ? (g.n >= 9 ? g.median : g.rawMedian) * k : null,
    pctP80: k !== null && g.n ? Math.exp(Math.log(g.median * k) + 0.8416 * sdPct) : null,
  }));
  const phaseShare = PHASES.map((phase) => {
    const shares = covered.map((r) => (r.byPhase[phase] ?? 0) / r.qu);
    return {
      phase,
      median: median(shares),
      mean: shares.reduce((x, y) => x + y, 0) / (shares.length || 1),
    };
  });
  const qu = covered.map((r) => r.qu);
  const drivers = (
    [
      ['main-session turns', covered.map((r) => r.turns)],
      ['subagent runs', covered.map((r) => r.subagents)],
      ['review rounds', covered.map((r) => r.rounds)],
      ['files changed', covered.map((r) => r.files)],
      ['lines changed', covered.map((r) => r.lines)],
    ] as const
  ).map(([what, x]) => ({ what, rho: spearman([...x], qu) }));

  const flagAcc = new Map<string, { calls: number; qu: number }>();
  let totalQU = 0;
  for (const c of o.loaded.calls) {
    totalQU += c.qu;
    for (const f of c.flags) {
      const v = flagAcc.get(f) ?? { calls: 0, qu: 0 };
      v.calls++;
      v.qu += c.qu;
      flagAcc.set(f, v);
    }
  }

  // additivity: each session's calls (with its subagents) against its own status-line cost over the log window
  const bySid = new Map<string, MeterRow[]>();
  for (const r of o.rows) {
    if (r.cost === null) continue;
    const list = bySid.get(r.sid) ?? [];
    list.push(r);
    bySid.set(r.sid, list);
  }
  const ratios: number[] = [];
  for (const [sid, rs] of bySid) {
    if (rs.length < 2) continue;
    const logQU = costDeltas(rs).reduce((x, d) => x + d.d, 0);
    if (logQU < 1) continue;
    const callQU = a.calls
      .filter((c) => c.session.endsWith(`/${sid}`) && c.ts > rs[0]!.ts && c.ts <= rs.at(-1)!.ts)
      .reduce((x, c) => x + c.qu, 0);
    ratios.push(callQU / logQU);
  }

  let agree = 0;
  let total = 0;
  let agreeSessions = 0;
  const byTrack = new Map<string, { ts: number; qu: number }[]>();
  for (const c of a.calls) {
    if (c.role !== 'lane') continue;
    const list = byTrack.get(c.track) ?? [];
    list.push(c);
    byTrack.set(c.track, list);
  }
  for (const [s, ms] of a.markers) {
    const g = agreement(ms, byTrack.get(s) ?? []);
    if (!g || !g.total) continue;
    agree += g.agree;
    total += g.total;
    agreeSessions++;
  }
  const inPR = covered.reduce((x, r) => x + r.qu, 0);
  return {
    fit,
    rows,
    types,
    shrinkage: sh.shrinkage,
    logSd: sh.s,
    phaseShare,
    drivers,
    top: [...covered].sort((x, y) => y.qu - x.qu).slice(0, 5),
    overhead: overhead(a, rows, o.prs),
    flags: [...flagAcc].map(([flag, v]) => ({
      flag,
      calls: v.calls,
      quShare: totalQU ? v.qu / totalQU : 0,
    })),
    additivity: {
      sessions: ratios.length,
      medianRatio: ratios.length ? median(ratios) : null,
      outside: ratios.filter((r) => r < 0.85 || r > 1.1).length,
    },
    agreement: { share: total ? agree / total : null, sessions: agreeSessions },
    dupes: o.loaded.dupes,
    orphans: a.orphans,
    totalQU,
    unattributedShare: inPR
      ? covered.reduce((x, r) => x + (r.byPhase.unattributed ?? 0), 0) / inPR
      : null,
    rounds: reviewRounds(a, rows, o.reports),
    concurrency: concurrency(a, rows, o.events, o.since),
  };
}
