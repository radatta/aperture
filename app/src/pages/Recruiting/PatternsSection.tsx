import { CAUSE_NAMES, PATTERN_NAMES } from '@aperture/shared';
import type { CauseTag, CoachFocusState, PatternId, PatternStat } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { LoadError } from '../../components/LoadError';
import { Text } from '../../components/Text';
import { useCoachFocus, useCoachStats, useSetFocusPattern } from '../../data/hooks/useCoachStats';
import { cx } from '../../lib/cx';
import { fmtRate, MIN_PCT, patternRows } from './patternsHelpers';

// The Patterns tab (docs/areas/recruiting/coach.md → The Patterns tab): how practice is going per pattern, in the
// order the coach ranks them for the focus (weakest first tries first), with the focus marked and "Set as focus" on
// the rest.
const MAX_WEEKS = 8;

export function PatternsSection() {
  const stats = useCoachStats();
  const focus = useCoachFocus();
  const set = useSetFocusPattern();

  if (!stats.data)
    return (
      <div className="py-8">
        {stats.isError ? (
          <LoadError onRetry={() => void stats.refetch()}>Couldn’t load the patterns.</LoadError>
        ) : (
          <Text tone="muted" size="sm">
            Loading…
          </Text>
        )}
      </div>
    );
  const s = stats.data;
  const rows = patternRows(s.ranking, s.patterns);
  const current = focus.data ?? null;
  const pick = (p: PatternId | null) => set.mutate(p);

  return (
    <div className="flex flex-col gap-4">
      <FocusLine
        focus={current}
        error={focus.isError}
        onRetry={() => void focus.refetch()}
        onClear={() => pick(null)}
        pending={set.isPending}
      />
      {set.isError && (
        <div role="alert">
          <Text as="p" tone="danger" size="sm">
            {set.error instanceof Error ? set.error.message : 'Couldn’t set the focus.'} Nothing
            changed.
          </Text>
        </div>
      )}
      {s.attempts === 0 ? (
        <EmptyState title="Nothing to rank yet.">
          Patterns fill in as you practise: each sitting or logged attempt counts toward its
          pattern. Until then the coach takes them in roadmap order.
        </EmptyState>
      ) : (
        <Text as="p" size="sm" tone="muted">
          {s.problems} {s.problems === 1 ? 'problem' : 'problems'} · {s.attempts}{' '}
          {s.attempts === 1 ? 'attempt' : 'attempts'} · first try {fmtRate(s.firstTry)} · re-solve{' '}
          {fmtRate(s.resolve)}
        </Text>
      )}
      <ol aria-label="Patterns, weakest first" className="flex flex-col divide-y divide-line">
        {rows.map((r) => (
          <PatternRow
            key={r.pattern}
            {...r}
            isFocus={current?.pattern === r.pattern}
            pending={set.isPending && set.variables === r.pattern}
            disabled={set.isPending || !current}
            onFocus={() => pick(r.pattern)}
          />
        ))}
      </ol>
    </div>
  );
}

function FocusLine({
  focus,
  error,
  onRetry,
  onClear,
  pending,
}: {
  focus: CoachFocusState | null;
  error: boolean;
  onRetry: () => void;
  onClear: () => void;
  pending: boolean;
}) {
  if (error) return <LoadError onRetry={onRetry}>Couldn’t load the focus.</LoadError>;
  if (!focus) return null;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Text size="sm" weight="medium">
          Focus · {PATTERN_NAMES[focus.pattern]} · day {focus.day} of {focus.of}
        </Text>
        <Text size="xs" tone="muted">
          {focus.why}
        </Text>
      </div>
      {focus.source === 'override' && (
        <Button variant="quiet" size="sm" onClick={onClear} disabled={pending}>
          Back to the coach’s pick
        </Button>
      )}
    </Card>
  );
}

function PatternRow({
  pattern,
  rank,
  stat,
  isFocus,
  pending,
  disabled,
  onFocus,
}: {
  pattern: PatternId;
  rank: number | null;
  stat: PatternStat | null;
  isFocus: boolean;
  pending: boolean;
  disabled: boolean;
  onFocus: () => void;
}) {
  const name = PATTERN_NAMES[pattern];
  return (
    <li
      aria-current={isFocus ? 'true' : undefined}
      aria-label={name}
      data-pattern={pattern}
      className={cx('flex flex-col gap-1 py-3', isFocus && 'rounded-xl bg-teal-soft px-3')}
    >
      <div className="flex items-center gap-2">
        <Text size="xs" tone="subtle" className="w-6 shrink-0 tabular-nums">
          {rank ?? '·'}
        </Text>
        <Text size="sm" weight="medium" className="min-w-0 flex-1 truncate">
          {name}
        </Text>
        {isFocus ? (
          <Text size="xs" tone="teal" weight="medium">
            Focus
          </Text>
        ) : rank !== null ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={onFocus}
            disabled={disabled}
            aria-label={`Set ${name} as focus`}
          >
            {pending ? 'Setting…' : 'Set as focus'}
          </Button>
        ) : stat ? (
          <Text size="xs" tone="muted">
            All seen
          </Text>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 pl-8">
        {stat ? (
          <PatternStats stat={stat} />
        ) : (
          <Text size="xs" tone="subtle">
            Not started
          </Text>
        )}
      </div>
    </li>
  );
}

function PatternStats({ stat }: { stat: PatternStat }) {
  const causes = (Object.entries(stat.causes) as [CauseTag, number][]).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Text
          size="sm"
          tone={stat.firstTry.of && stat.firstTry.hit === stat.firstTry.of ? 'teal' : 'ink'}
        >
          First try {fmtRate(stat.firstTry)}
        </Text>
        <WeekBars weeks={stat.weeks} />
      </div>
      <Text size="xs" tone="muted">
        {[
          `${stat.problems} ${stat.problems === 1 ? 'problem' : 'problems'}`,
          `re-solve ${fmtRate(stat.resolve)}`,
          stat.submitsPerProblem !== null && `${stat.submitsPerProblem} submits a problem`,
          stat.runBeforeSubmit.of > 0 && `ran first ${fmtRate(stat.runBeforeSubmit)}`,
          stat.traced.of > 0 && `traced ${fmtRate(stat.traced)}`,
          stat.peeked > 0 && `peeked ${stat.peeked}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {causes.length > 0 && (
        <Text size="xs" tone="gold">
          {causes.map(([c, n]) => `${CAUSE_NAMES[c]} ${n}`).join(' · ')}
        </Text>
      )}
    </>
  );
}

// First tries per ISO week, the last MAX_WEEKS with any: one bar each, its height the clean share; a week with
// fewer than MIN_PCT tries is drawn hollow, so a 1-of-1 week doesn't read like a full one.
function WeekBars({ weeks }: { weeks: PatternStat['weeks'] }) {
  const shown = weeks.slice(-MAX_WEEKS);
  if (shown.length < 2) return null;
  const w = 6;
  const gap = 3;
  const h = 16;
  const label = `First tries by week: ${shown
    .map((x) => `${x.week.slice(5)} ${x.firstTry.hit} of ${x.firstTry.of}`)
    .join(', ')}`;
  return (
    <svg
      role="img"
      aria-label={label}
      width={shown.length * (w + gap) - gap}
      height={h}
      className="shrink-0"
    >
      {shown.map((x, i) => {
        const frac = x.firstTry.of ? x.firstTry.hit / x.firstTry.of : 0;
        const bh = Math.max(2, Math.round(frac * h));
        const thin = x.firstTry.of < MIN_PCT;
        return (
          <rect
            key={x.week}
            x={i * (w + gap) + (thin ? 0.5 : 0)}
            y={h - bh + (thin ? 0.5 : 0)}
            width={thin ? w - 1 : w}
            height={thin ? bh - 1 : bh}
            rx={1.5}
            className={thin ? 'fill-none stroke-teal' : 'fill-teal'}
          />
        );
      })}
    </svg>
  );
}
