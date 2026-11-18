import { isoWeekKey, PATTERNS } from '@aperture/shared';
import type { Mock, PatternId, PatternStat, Rate } from '@aperture/shared';

// The Patterns tab's pure helpers (PatternsSection.tsx). Every rate reads as counts; a percentage joins only from
// MIN_PCT tries, so a week of data stays honest.
export const MIN_PCT = 5;

export const fmtRate = (r: Rate) =>
  r.of === 0
    ? '—'
    : r.of < MIN_PCT
      ? `${r.hit} of ${r.of}`
      : `${r.hit} of ${r.of} (${Math.round((r.hit / r.of) * 100)}%)`;

// The ranking first (every roadmap pattern with something unseen left), then any practised to the end of its list,
// then the rest in roadmap order — so all 18 show, and only a ranked one can take the focus. `other` (problems
// outside the roadmap) comes last, only once something lands there: it has no list to rank or finish.
export function patternRows(
  ranking: readonly PatternId[],
  stats: readonly PatternStat[],
): { pattern: PatternId; rank: number | null; stat: PatternStat | null }[] {
  const byPattern = new Map(stats.map((s) => [s.pattern, s]));
  const roadmap = [
    ...ranking,
    ...stats.map((s) => s.pattern).filter((p) => p !== 'other' && !ranking.includes(p)),
  ];
  const all = [
    ...roadmap,
    ...PATTERNS.filter((p) => !roadmap.includes(p)),
    ...(byPattern.has('other') ? (['other'] as const) : []),
  ];
  return all.map((pattern) => {
    const i = ranking.indexOf(pattern);
    return { pattern, rank: i < 0 ? null : i + 1, stat: byPattern.get(pattern) ?? null };
  });
}

// The Patterns tab's mock rows: each done mock, newest first, with the first-try rate of its ISO week beside it (null
// when that week had no first try), so the outcome metric reads next to the practice one.
export function mockRows(
  mocks: readonly Mock[],
  weeks: readonly { week: string; firstTry: Rate }[],
): { mock: Mock; firstTry: Rate | null }[] {
  const byWeek = new Map(weeks.map((w) => [w.week, w.firstTry]));
  return mocks
    .filter((m) => m.status === 'done' && m.scores)
    .map((mock) => ({ mock, firstTry: byWeek.get(isoWeekKey(mock.day)) ?? null }));
}
