import { PATTERNS } from '@aperture/shared';
import type { PatternId, PatternStat, Rate } from '@aperture/shared';

// The Patterns tab's pure helpers (PatternsSection.tsx). Every rate reads as counts; a percentage joins only from
// MIN_PCT tries, so a week of data stays honest.
export const MIN_PCT = 5;

export const fmtRate = (r: Rate) =>
  r.of === 0
    ? '—'
    : r.of < MIN_PCT
      ? `${r.hit} of ${r.of}`
      : `${r.hit} of ${r.of} · ${Math.round((r.hit / r.of) * 100)}%`;

// The ranking first (every pattern with something unseen left), then any pattern practised to the end of its
// list, then the rest in roadmap order — so all 18 show, and only a ranked one can take the focus.
export function patternRows(
  ranking: readonly PatternId[],
  stats: readonly PatternStat[],
): { pattern: PatternId; rank: number | null; stat: PatternStat | null }[] {
  const byPattern = new Map(stats.map((s) => [s.pattern, s]));
  const order = [
    ...ranking,
    ...stats.filter((s) => !ranking.includes(s.pattern)).map((s) => s.pattern),
  ];
  const all = [...order, ...[...PATTERNS].filter((p) => !order.includes(p))];
  return all.map((pattern) => {
    const i = ranking.indexOf(pattern);
    return { pattern, rank: i < 0 ? null : i + 1, stat: byPattern.get(pattern) ?? null };
  });
}
