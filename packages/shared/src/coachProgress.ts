// The Progress tab's folds (docs/areas/recruiting/coach.md → The Progress tab): pure, over problem records
// (listProblemRecords) and a problem list (catalogs.ts), so the app derives the map, the solves and the trends with
// no RPC of its own. "Done" is a clean or solved try, live or history-only; the status shows the newest live try.

import { CATALOGS } from './catalogs';
import type { CatalogId } from './catalogs';
import { COACH_PARAMS } from './coach';
import type { ProblemRecord, Rate } from './coach';
import { addDays, isoWeekKey, weekdayOf } from './dates';
import { PATTERNS } from './neetcode150';
import type { CatalogProblem, PatternId } from './neetcode150';

// --- One problem's status ---
// untried; earlier = only history-only solves, one accepted; else the newest live try's: clean, solved, peeked (the
// solution read), not-yet (not accepted, no peek). A history-only problem accepted only with the solution read reads
// peeked; never accepted, not-yet. Done is a
// clean or solved try (a peek never counts), so a failed re-solve shows in the square (gold) but never takes a solved
// problem off the count.
export type ProblemState = 'untried' | 'earlier' | 'clean' | 'solved' | 'peeked' | 'not-yet';
export interface ProblemStatus {
  state: ProblemState;
  done: boolean;
  dueSince: string | null; // a re-solve due today or earlier: the day it came due
  nextDue: string | null; // a re-solve still ahead
  graduated: boolean;
}
const UNTRIED: ProblemStatus = {
  state: 'untried',
  done: false,
  dueSince: null,
  nextDue: null,
  graduated: false,
};
export function problemStatus(r: ProblemRecord | null, today: string): ProblemStatus {
  if (!r) return UNTRIED;
  const live = r.tries.filter((t) => !t.historical);
  const last = live[live.length - 1];
  const state: ProblemState = !last
    ? r.tries.some((t) => t.outcome !== 'failed')
      ? 'earlier'
      : r.tries.some((t) => t.accepted && t.help === 'solution')
        ? 'peeked'
        : 'not-yet'
    : last.outcome === 'failed'
      ? last.help === 'solution'
        ? 'peeked'
        : 'not-yet'
      : last.outcome;
  const s = r.schedule;
  const open = s && !s.graduated ? s.dueDay : null;
  return {
    state,
    done: r.tries.some((t) => t.outcome !== 'failed'),
    dueSince: open && open <= today ? open : null,
    nextDue: open && open > today ? open : null,
    graduated: !!s?.graduated,
  };
}

// --- Coverage: a list against the records ---
export interface ProblemCell {
  problem: CatalogProblem;
  record: ProblemRecord | null;
  status: ProblemStatus;
}
export interface PatternCoverage {
  pattern: PatternId;
  total: number;
  done: number;
  tried: number; // touched, not done
  untried: number;
  due: number; // re-solves due today or earlier
  problems: ProblemCell[]; // in list order
}
export interface Coverage {
  catalog: CatalogId;
  label: string;
  total: number;
  done: number;
  tried: number;
  untried: number;
  premium: number; // the list's Premium problems, untried (shown only while Premium can't be picked)
  due: number;
  patterns: PatternCoverage[]; // every roadmap pattern in roadmap order
  offList: ProblemRecord[]; // touched problems on no list here, newest first
}
export function coverage(
  records: readonly ProblemRecord[],
  catalog: CatalogId,
  today: string,
): Coverage {
  const bySlug = new Map(records.map((r) => [r.slug, r]));
  const list = CATALOGS[catalog];
  const patterns = PATTERNS.map((pattern): PatternCoverage => {
    const problems = list.problems
      .filter((p) => p.pattern === pattern)
      .map((problem) => {
        const record = bySlug.get(problem.slug) ?? null;
        return { problem, record, status: problemStatus(record, today) };
      });
    const done = problems.filter((c) => c.status.done).length;
    const untried = problems.filter((c) => c.status.state === 'untried').length;
    return {
      pattern,
      total: problems.length,
      done,
      tried: problems.length - done - untried,
      untried,
      due: problems.filter((c) => c.status.dueSince).length,
      problems,
    };
  });
  const sum = (k: 'total' | 'done' | 'tried' | 'untried' | 'due') =>
    patterns.reduce((n, p) => n + p[k], 0);
  const onList = new Set(list.problems.map((p) => p.slug));
  return {
    catalog,
    label: list.label,
    total: sum('total'),
    done: sum('done'),
    tried: sum('tried'),
    untried: sum('untried'),
    premium: patterns
      .flatMap((p) => p.problems)
      .filter((c) => c.problem.premium && c.status.state === 'untried').length,
    due: sum('due'),
    patterns,
    offList: records
      .filter((r) => !onList.has(r.slug))
      .sort((a, b) => b.lastDay.localeCompare(a.lastDay) || a.slug.localeCompare(b.slug)),
  };
}

// --- The map's stages: our own five groups of the roadmap, in its order (A2b) ---
export interface ProgressStage {
  id: string;
  label: string;
  patterns: readonly PatternId[];
}
export const PROGRESS_STAGES: readonly ProgressStage[] = [
  {
    id: 'foundations',
    label: 'Foundations',
    patterns: ['arrays-hashing', 'two-pointers', 'sliding-window', 'stack', 'binary-search'],
  },
  { id: 'linked', label: 'Linked structures', patterns: ['linked-list', 'trees', 'tries', 'heap'] },
  { id: 'search', label: 'Search', patterns: ['backtracking', 'graphs', 'advanced-graphs'] },
  { id: 'dp', label: 'Dynamic programming', patterns: ['dp-1d', 'dp-2d'] },
  {
    id: 'toolkit',
    label: 'Toolkit',
    patterns: ['greedy', 'intervals', 'math-geometry', 'bit-manipulation'],
  },
];

// --- Trends: live tries only, per ISO week ---
export interface ProgressWeek {
  week: string; // ISO week key
  start: string; // its Monday
  clean: number;
  solved: number;
  failed: number;
  firstTry: Rate; // first tries ever that week, clean
  resolve: Rate; // later-day tries that week, clean
}
const mondayOf = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));
// The `weeks` ISO weeks up to today's, oldest first, empty ones included. A first try is a problem's first live
// try with no history-only solve dated before it (coachStats' rule); a live try after one is a re-solve.
export function progressWeeks(
  records: readonly ProblemRecord[],
  today: string,
  weeks = 12,
): ProgressWeek[] {
  const start = mondayOf(today);
  const out = Array.from({ length: weeks }, (_, i): ProgressWeek => {
    const monday = addDays(start, -7 * (weeks - 1 - i));
    return {
      week: isoWeekKey(monday),
      start: monday,
      clean: 0,
      solved: 0,
      failed: 0,
      firstTry: { hit: 0, of: 0 },
      resolve: { hit: 0, of: 0 },
    };
  });
  const byWeek = new Map(out.map((w) => [w.week, w]));
  for (const r of records) {
    const live = r.tries.filter((t) => !t.historical);
    live.forEach((t, i) => {
      const w = byWeek.get(isoWeekKey(t.day));
      if (!w || t.day > today) return;
      w[t.outcome] += 1;
      const after = !!r.historical && r.historical.firstDay < t.day; // a history-only solve came first
      const rate = i === 0 && !after ? w.firstTry : w.resolve;
      rate.of += 1;
      if (t.outcome === 'clean') rate.hit += 1;
    });
  }
  return out;
}

// --- Time against the cap: live tries with minutes, the same `weeks` ISO weeks as progressWeeks. Each try against
// the cap it ran under (ProblemTry.capMin), so the bins are shares of the cap. One place to swap the read (coach.md →
// Caps): the card renders whatever bins this gives. ---
export interface CapBin {
  label: string;
  n: number;
  over: boolean; // past the cap
}
export interface CapTimes {
  timed: number;
  inside: number; // at or under its own cap
  medianMin: number | null;
  bins: CapBin[];
}
// Edges in sixths of the cap, so a try on an edge compares whole numbers (6·minutes against sixths·cap).
const CAP_SHARES: [string, number, number, boolean][] = [
  ['≤ ⅓', 0, 2, false],
  ['⅓–⅔', 2, 4, false],
  ['⅔–1×', 4, 6, false],
  ['1–1.5×', 6, 9, true],
  ['1.5–2×', 9, 12, true],
  ['2×+', 12, Infinity, true],
];
export function capTimes(records: readonly ProblemRecord[], today: string, weeks = 12): CapTimes {
  const from = addDays(mondayOf(today), -7 * (weeks - 1));
  const timed = records.flatMap((r) =>
    r.tries.filter((t) => !t.historical && t.minutes !== null && t.day >= from && t.day <= today),
  );
  const mins = timed.map((t) => t.minutes!).sort((a, b) => a - b);
  // `??`: a Lambda from before the caps (a revert's window) sends no capMin; read it as the old 30, never NaN.
  const at = timed.map((t) => ({ m: 6 * t.minutes!, cap: t.capMin ?? COACH_PARAMS.capLegacyMin }));
  const mid = mins.length >> 1;
  return {
    timed: mins.length,
    inside: at.filter((x) => x.m <= 6 * x.cap).length,
    medianMin: mins.length
      ? mins.length % 2
        ? mins[mid]!
        : Math.round((mins[mid - 1]! + mins[mid]!) / 2)
      : null,
    bins: CAP_SHARES.map(([label, lo, hi, over]) => ({
      label,
      n: at.filter((x) => (lo === 0 || x.m > lo * x.cap) && x.m <= hi * x.cap).length,
      over,
    })),
  };
}
