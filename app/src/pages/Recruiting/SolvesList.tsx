import { Link, useLocation } from 'react-router';
import { CAUSE_NAMES, PATTERN_NAMES, PATTERNS } from '@aperture/shared';
import type { PatternId, ProblemRecord } from '@aperture/shared';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import {
  DIFFICULTIES,
  firstTryText,
  fmtPastDay,
  matchesSolve,
  reSolveText,
  SOLVE_STATUSES,
  solveRows,
  solveTag,
  stateTone,
  triesText,
} from './progressHelpers';
import type { SolveFilters } from './progressHelpers';

// Your solves (docs/areas/recruiting/coach.md → The Progress tab): every problem tried, the newest try first, with
// three filters kept in the URL. A row opens the problem's page. Untried problems are the map's.
const ROW =
  'xl:grid xl:grid-cols-[minmax(0,1fr)_8rem_4.5rem_7rem_4.5rem_4rem_6rem_7.5rem_minmax(0,10rem)] xl:items-baseline xl:gap-3';
const TAG: Record<'teal' | 'gold' | 'muted', string> = {
  teal: 'bg-teal-soft text-teal',
  gold: 'bg-gold-soft text-gold',
  muted: 'border border-line bg-panel-2 text-ink-muted',
};

export function SolvesList({
  records,
  today,
  filters,
  onFilters,
}: {
  records: readonly ProblemRecord[];
  today: string;
  filters: SolveFilters;
  onFilters: (f: SolveFilters) => void;
}) {
  const back = useLocation().search;
  const all = solveRows(records, today);
  const rows = all.filter((r) => matchesSolve(r, filters));
  const any = !!(filters.pattern || filters.status || filters.difficulty);
  const patterns: (PatternId | 'other')[] = [
    ...PATTERNS,
    ...(records.some((r) => r.pattern === 'other') ? (['other'] as const) : []),
  ];
  if (!all.length)
    return (
      <EmptyState title="No solves yet.">
        A sitting started on LeetCode, or an attempt logged in the thread, lands here.
      </EmptyState>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Select
          aria-label="Pattern"
          value={filters.pattern ?? ''}
          onChange={(e) =>
            onFilters({ ...filters, pattern: (e.target.value || null) as PatternId | null })
          }
          placeholder="All patterns"
          options={patterns.map((p) => ({ value: p, label: PATTERN_NAMES[p] }))}
        />
        <Select
          aria-label="Status"
          value={filters.status ?? ''}
          onChange={(e) =>
            onFilters({ ...filters, status: (e.target.value || null) as SolveFilters['status'] })
          }
          placeholder="Any status"
          options={SOLVE_STATUSES}
        />
        <Select
          aria-label="Difficulty"
          value={filters.difficulty ?? ''}
          onChange={(e) =>
            onFilters({
              ...filters,
              difficulty: (e.target.value || null) as SolveFilters['difficulty'],
            })
          }
          placeholder="Any difficulty"
          options={DIFFICULTIES.map((d) => ({ value: d, label: d }))}
        />
        <Text size="xs" tone="muted" className="ml-auto self-center">
          {any ? `${rows.length} of ${all.length}` : `${all.length}`}{' '}
          {all.length === 1 ? 'problem' : 'problems'} · newest first
        </Text>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title="Nothing matches these filters."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onFilters({ pattern: null, status: null, difficulty: null })}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div
          role="table"
          aria-label="Your solves"
          className="flex flex-col rounded-2xl border border-line bg-panel"
        >
          <div role="row" className={cx('hidden border-b border-line px-3 py-2', ROW)}>
            {[
              'Problem',
              'Pattern',
              'Difficulty',
              'Status',
              'First try',
              'Tries',
              'Last cause',
              'Last tried',
              'Re-solve',
            ].map((h) => (
              <span key={h} role="columnheader" className="text-xs text-ink-muted">
                {h}
              </span>
            ))}
          </div>
          {rows.map(({ record: r, status: st }) => {
            const reSolve = reSolveText(st, today) ?? '–';
            const cause = r.cause ? CAUSE_NAMES[r.cause] : '–';
            return (
              <div
                key={r.slug}
                role="row"
                className={cx(
                  'flex flex-col gap-0.5 border-b border-line px-3 py-2.5 last:border-b-0',
                  ROW,
                )}
              >
                <span role="cell" className="flex min-w-0 items-baseline justify-between gap-2">
                  <Link
                    to={`/recruiting/progress/${r.slug}`}
                    state={{ back }}
                    className="min-w-0 text-sm font-medium text-ink underline decoration-line-strong underline-offset-[3px] hover:decoration-ink"
                  >
                    {r.title}
                  </Link>
                  <span
                    className={cx(
                      'shrink-0 whitespace-nowrap rounded-full px-2 text-xs font-semibold xl:hidden',
                      TAG[st.graduated ? 'muted' : stateTone(st.state)],
                    )}
                  >
                    {solveTag(st)}
                  </span>
                </span>
                <span role="cell" className="text-xs text-ink-muted xl:hidden">
                  {[
                    PATTERN_NAMES[r.pattern],
                    r.difficulty,
                    `first try: ${firstTryText(r)}`,
                    triesText(r),
                    r.cause && CAUSE_NAMES[r.cause],
                    `last ${fmtPastDay(r.lastDay, today)}`,
                    reSolveText(st, today),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span role="cell" className="hidden text-sm xl:block">
                  {PATTERN_NAMES[r.pattern]}
                </span>
                <span role="cell" className="hidden text-sm xl:block">
                  {r.difficulty ?? '–'}
                </span>
                <span role="cell" className="hidden xl:block">
                  <span
                    className={cx(
                      'whitespace-nowrap rounded-full px-2 text-xs font-semibold',
                      TAG[st.graduated ? 'muted' : stateTone(st.state)],
                    )}
                  >
                    {solveTag(st)}
                  </span>
                </span>
                <span role="cell" className="hidden text-sm xl:block">
                  {firstTryText(r)}
                </span>
                <span role="cell" className="hidden text-sm tabular-nums xl:block">
                  {triesText(r)}
                </span>
                <span role="cell" className="hidden text-sm xl:block">
                  {cause}
                </span>
                <span role="cell" className="hidden text-sm xl:block">
                  {fmtPastDay(r.lastDay, today)}
                </span>
                <span role="cell" className="hidden text-sm xl:block">
                  {reSolve}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
