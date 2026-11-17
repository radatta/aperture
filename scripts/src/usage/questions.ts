// The two measure-first questions (research panel 1, 11-17), answered from the same tables.
// (a) Do review rounds 3–4 still find real issues?  (b) Do more lanes give more merged PRs, or just more slowdown?
import type { Attribution, PRRow } from './prs.ts';
import { median, slope, spearman } from './stats.ts';

export interface RoundStat {
  round: number; // 4 = 4 and beyond
  lanes: number;
  medianQU: number;
  srcShare: number; // share of rounds whose window has a src edit (a fix was made)
  medianSrcEdits: number;
  reportReal: number; // rounds the lane's report says found a real bug
  reportClean: number; // rounds the report says were clean
}

// A report line → what it says one round found. Heuristic, so the report prints how many lines it could read.
export function roundVerdicts(report: string): Map<number, 'real' | 'clean'> {
  const out = new Map<number, 'real' | 'clean'>();
  for (const line of report.split('\n')) {
    const m = /\bround (\d)\b/i.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    const real =
      /\b[1-9]\d*\s+(sev\s*[12]\b|(real\s+)?bugs?\b)|found (real|more) bugs|still found real bugs|caught/i.test(
        line,
      );
    const clean =
      /\b(0|no|zero)\s+(real\s+|security\s+)?(bugs?|issues?)\b|\bwas clean\b|\bclean\b/i.test(line);
    if (real) out.set(n, 'real');
    else if (clean && !out.has(n)) out.set(n, 'clean');
  }
  return out;
}

export function reviewRounds(
  a: Attribution,
  rows: PRRow[],
  reports: Map<string, string>,
): { rounds: RoundStat[]; parsed: number } {
  const acc = new Map<number, { qu: number[]; src: number[]; real: number; clean: number }>();
  let parsed = 0;
  for (const r of rows) {
    if (!r.rounds) continue;
    const verdicts = roundVerdicts(reports.get(r.branch) ?? '');
    if (verdicts.size) parsed++;
    const ms = r.sessions.flatMap((s) => a.markers.get(s) ?? []);
    const calls = a.calls.filter((c) => c.lane === r.branch && c.ts <= r.mergedAt);
    r.roundStarts.forEach((t0, i) => {
      // a round runs to the next round, or to the first local/dev/pr marker after it, or the merge
      const next = r.roundStarts[i + 1];
      const leave = ms
        .filter((m) => m.ts > t0 && ['local', 'devcheck', 'dev', 'pr'].includes(m.kind))
        .map((m) => m.ts);
      const t1 = Math.min(next ?? Infinity, ...leave, r.mergedAt);
      const n = Math.min(i + 1, 4);
      const s = acc.get(n) ?? { qu: [], src: [], real: 0, clean: 0 };
      s.qu.push(calls.filter((c) => c.ts >= t0 && c.ts < t1).reduce((x, c) => x + c.qu, 0));
      s.src.push(
        ms.filter((m) => m.kind === 'edit' && m.cls === 'src' && m.ts >= t0 && m.ts < t1).length,
      );
      const v = verdicts.get(i + 1);
      if (v === 'real') s.real++;
      if (v === 'clean') s.clean++;
      acc.set(n, s);
    });
  }
  const rounds = [...acc]
    .sort((x, y) => x[0] - y[0])
    .map(([round, s]) => ({
      round,
      lanes: s.qu.length,
      medianQU: median(s.qu),
      srcShare: s.src.filter((x) => x > 0).length / s.src.length,
      medianSrcEdits: median(s.src),
      reportReal: s.real,
      reportClean: s.clean,
    }));
  return { rounds, parsed };
}

const ptDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

export interface DayStat {
  day: string;
  meanLanes: number; // over active hours
  maxLanes: number;
  laneHours: number;
  merged: number;
  perLaneHour: number;
  quPerPR: number | null;
}
export interface JobEvent {
  t: string;
  kind: string;
  class?: string;
  exit?: number;
  wallSec?: number;
  mix?: { working?: number; heavy?: number };
}
export interface Concurrency {
  days: DayStat[];
  rhoMerged: number; // daily mean lanes vs merged that day
  rhoPerLaneHour: number;
  slowdown: { cls: string; n: number; pctPerLane: number }[]; // % wall time per extra working session
}

export function concurrency(
  a: Attribution,
  rows: PRRow[],
  events: JobEvent[],
  since: number,
): Concurrency {
  const hours = new Map<number, Set<string>>();
  for (const c of a.calls) {
    if (c.role !== 'lane' || !c.lane || c.ts < since) continue;
    const h = Math.floor(c.ts / 3_600_000);
    const set = hours.get(h) ?? new Set<string>();
    set.add(c.lane);
    hours.set(h, set);
  }
  const days = new Map<string, number[]>();
  for (const [h, set] of hours) {
    const d = ptDay(h * 3_600_000);
    days.set(d, [...(days.get(d) ?? []), set.size]);
  }
  // a day with merges but no lane call (the work was the day before) still counts its merges
  for (const r of rows)
    if (r.mergedAt >= since && !days.has(ptDay(r.mergedAt))) days.set(ptDay(r.mergedAt), []);
  const stats: DayStat[] = [...days]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([day, ns]) => {
      const merged = rows.filter((r) => ptDay(r.mergedAt) === day);
      const laneHours = ns.reduce((x, y) => x + y, 0);
      const withQU = merged.filter((r) => r.qu > 0);
      return {
        day,
        meanLanes: ns.length ? laneHours / ns.length : 0,
        maxLanes: ns.length ? Math.max(...ns) : 0,
        laneHours,
        merged: merged.length,
        perLaneHour: laneHours ? merged.length / laneHours : NaN,
        quPerPR: withQU.length ? withQU.reduce((x, r) => x + r.qu, 0) / withQU.length : null,
      };
    });
  const slowdown = ['typecheck', 'lint', 'test'].flatMap((cls) => {
    const js = events.filter(
      (e) =>
        e.kind === 'job' &&
        e.class === cls &&
        e.exit === 0 &&
        (e.wallSec ?? 0) > 0 &&
        Date.parse(e.t) >= since,
    );
    if (js.length < 5) return [];
    const x = js.map((e) => e.mix?.working ?? 0);
    const y = js.map((e) => Math.log(e.wallSec!));
    return [{ cls, n: js.length, pctPerLane: (Math.exp(slope(x, y)) - 1) * 100 }];
  });
  const worked = stats.filter((d) => d.laneHours > 0);
  return {
    days: stats,
    rhoMerged: spearman(
      stats.map((d) => d.meanLanes),
      stats.map((d) => d.merged),
    ),
    rhoPerLaneHour: spearman(
      worked.map((d) => d.meanLanes),
      worked.map((d) => d.perLaneHour),
    ),
    slowdown,
  };
}
