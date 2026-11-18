import { useRef } from 'react';
import type { Ref } from 'react';
import { CAUSE_NAMES, PATTERN_NAMES } from '@aperture/shared';
import type { CauseTag, CoachFocusState, PatternId, PatternStat } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { LoadError } from '../../components/LoadError';
import { Text } from '../../components/Text';
import { useCoachFocus, useCoachStats, useSetFocusPattern } from '../../data/hooks/useCoachStats';
import { isTransientRead } from '../../data/retry';
import { cx } from '../../lib/cx';
import { fmtRate, MIN_PCT, patternRows } from './patternsHelpers';
import { PatternsMocks } from './PatternsMocks';

// The Patterns tab (docs/areas/recruiting/coach.md → The Patterns tab): how practice is going per pattern, in the
// order the coach ranks them for the focus (weakest first tries first), with the focus marked and "Set as focus" on
// the rest. The button a focus write came from goes away, so keyboard focus moves to the row that now holds the
// focus (Set) or to the Focus card (Back) — never the top of the page.
const MAX_WEEKS = 8;

export function PatternsSection() {
  const stats = useCoachStats();
  const focus = useCoachFocus();
  const set = useSetFocusPattern();
  const focusCard = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);

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
  const pick = (p: PatternId | null) =>
    set.mutate(p, {
      onSuccess: () =>
        (p
          ? list.current?.querySelector<HTMLElement>(`li[data-pattern="${p}"]`)
          : focusCard.current
        )?.focus(),
    });

  return (
    <div className="flex flex-col gap-4">
      <FocusLine
        ref={focusCard}
        focus={current}
        error={focus.isError}
        onRetry={() => void focus.refetch()}
        onClear={() => pick(null)}
        pending={set.isPending}
      />
      {set.isError && set.variables === null && <WriteError error={set.error} />}
      {s.attempts === 0 ? (
        <EmptyState title="Nothing to rank yet.">
          Patterns fill in as you practise: each sitting or logged attempt counts toward its
          pattern. Until then the coach takes them in roadmap order.
        </EmptyState>
      ) : (
        <Text as="p" size="sm" tone="muted">
          <Metrics
            parts={[
              `${s.problems} ${s.problems === 1 ? 'problem' : 'problems'}`,
              `${s.attempts} ${s.attempts === 1 ? 'attempt' : 'attempts'}`,
              `first try ${fmtRate(s.firstTry)}`,
              `re-solve ${fmtRate(s.resolve)}`,
            ]}
          />
        </Text>
      )}
      <div className="flex flex-col gap-1">
        <Text as="h2" id="patterns-ranking" size="sm" weight="semibold" tone="muted">
          Weakest first tries first
        </Text>
        <Text as="p" size="xs" tone="muted">
          The ranking as of now; an untried pattern counts as a coin flip. The focus holds a pattern
          for 3 active days, then takes the top one.
        </Text>
      </div>
      <ol ref={list} aria-labelledby="patterns-ranking" className="-mx-2 flex flex-col gap-1">
        {rows.map((r) => (
          <PatternRow
            key={r.pattern}
            {...r}
            isFocus={current?.pattern === r.pattern}
            pending={set.isPending && set.variables === r.pattern}
            disabled={set.isPending || !current}
            onPick={() => pick(r.pattern)}
            error={set.isError && set.variables === r.pattern ? set.error : null}
          />
        ))}
      </ol>
      <PatternsMocks weeks={s.weeks} />
    </div>
  );
}

function FocusLine({
  ref,
  focus,
  error,
  onRetry,
  onClear,
  pending,
}: {
  ref: Ref<HTMLDivElement>;
  focus: CoachFocusState | null;
  error: boolean;
  onRetry: () => void;
  onClear: () => void;
  pending: boolean;
}) {
  if (error) return <LoadError onRetry={onRetry}>Couldn’t load the focus.</LoadError>;
  if (!focus) return null;
  return (
    <Card ref={ref} tabIndex={-1} className="flex flex-col gap-0.5 outline-offset-2">
      <Text size="sm" weight="medium">
        Focus · {PATTERN_NAMES[focus.pattern]} · day {focus.day} of {focus.of}
      </Text>
      <Text size="xs" tone="muted">
        {focus.why}
      </Text>
      {focus.source === 'override' && (
        <Button
          variant="quiet"
          size="sm"
          onClick={onClear}
          disabled={pending}
          className="-ml-3 mt-1 self-start"
        >
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
  onPick,
  error,
}: {
  pattern: PatternId;
  rank: number | null;
  stat: PatternStat | null;
  isFocus: boolean;
  pending: boolean;
  disabled: boolean;
  onPick: () => void;
  error: unknown;
}) {
  const name = PATTERN_NAMES[pattern];
  const nameId = `pattern-${pattern}`;
  return (
    <li
      aria-current={isFocus ? 'true' : undefined}
      aria-labelledby={nameId}
      data-pattern={pattern}
      tabIndex={-1}
      className={cx('flex flex-col gap-1 rounded-xl px-2 py-2.5', isFocus && 'bg-teal-soft')}
    >
      <div className="flex min-h-8 items-center gap-2">
        <Text size="xs" tone="muted" tabular className="w-6 shrink-0">
          {rank ?? '·'}
        </Text>
        <Text id={nameId} size="sm" weight="medium" className="min-w-0 flex-1 truncate">
          {name}
        </Text>
        {isFocus ? (
          <Text size="xs" weight="semibold" className="px-3">
            Focus
          </Text>
        ) : rank !== null ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={onPick}
            disabled={disabled}
            aria-label={pending ? `Setting ${name} as focus` : `Set as focus, ${name}`}
          >
            {pending ? 'Setting…' : 'Set as focus'}
          </Button>
        ) : stat ? (
          <Text size="xs" tone="muted" className="px-3">
            {pattern === 'other' ? 'Outside the roadmap' : 'All seen'}
          </Text>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 pl-8">
        {error !== null && <WriteError error={error} />}
        {stat ? (
          <PatternStats stat={stat} onTeal={isFocus} />
        ) : (
          <Text size="xs" tone="muted">
            Not started
          </Text>
        )}
      </div>
    </li>
  );
}

// A " · "-joined line whose parts never break inside ("3 of 8" stays together); the line wraps between them, and a
// separator travels with the part after it, so none is left hanging at a line's end.
function Metrics({ parts }: { parts: (string | false)[] }) {
  return parts
    .filter((p): p is string => Boolean(p))
    .map((p, i) => (
      <span key={i} className="whitespace-nowrap">
        {i > 0 && '· '}
        {p}
      </span>
    ))
    .flatMap((el, i) => (i > 0 ? [' ', el] : [el]));
}
// A server reason as a sentence: the refusal's text carries no closing stop.
const sentence = (msg: string) => (/[.!?]$/.test(msg.trim()) ? msg.trim() : `${msg.trim()}.`);

// A focus write that failed, shown where it was asked for (the row, or above for Back) so it's on screen. A
// refusal (a 400, or the stub's throw) wrote nothing; a 5xx or a dropped connection may have landed, so it says
// so and the focus line, read again, shows what stands.
function WriteError({ error }: { error: unknown }) {
  return (
    <div role="alert">
      <Text as="p" tone="danger" size="sm">
        {isTransientRead(error)
          ? 'Couldn’t confirm the focus change — it may have saved; the focus line shows what stands.'
          : `${sentence(error instanceof Error ? error.message : 'Couldn’t set the focus')} Nothing changed.`}
      </Text>
    </div>
  );
}

// On the focus row's teal fill, teal text falls under 4.5:1, so a clean run reads in ink there.
function PatternStats({ stat, onTeal }: { stat: PatternStat; onTeal: boolean }) {
  const causes = (Object.entries(stat.causes) as [CauseTag, number][]).sort((a, b) => b[1] - a[1]);
  const spt = stat.submitsPerTry;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Text
          size="sm"
          tone={
            !onTeal && stat.firstTry.of && stat.firstTry.hit === stat.firstTry.of ? 'teal' : 'ink'
          }
        >
          <span className="whitespace-nowrap">First try {fmtRate(stat.firstTry)}</span>
        </Text>
        <WeekBars weeks={stat.weeks} />
      </div>
      <Text size="xs" tone="muted">
        <Metrics
          parts={[
            `${stat.problems} ${stat.problems === 1 ? 'problem' : 'problems'}`,
            stat.resolve.of > 0 && `re-solve ${fmtRate(stat.resolve)}`,
            spt !== null && `${spt} ${spt === 1 ? 'submit' : 'submits'} a try`,
            stat.runBeforeSubmit.of > 0 && `ran first ${fmtRate(stat.runBeforeSubmit)}`,
            stat.traced.of > 0 && `traced ${fmtRate(stat.traced)}`,
            stat.peeked > 0 && `peeked ${stat.peeked}`,
          ]}
        />
      </Text>
      {causes.length > 0 && (
        <Text size="xs" tone="muted">
          <Metrics parts={causes.map(([c, n]) => `${CAUSE_NAMES[c]} ${n}`)} />
        </Text>
      )}
    </>
  );
}

// First tries per ISO week, the last MAX_WEEKS with any: one bar each, its height the clean share (a floor of 4px
// so a 0-of-n week still reads as a bar, not a dot); a week with fewer than MIN_PCT tries is drawn hollow, so a 1-of-1 week
// doesn't read like a full one.
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
        const bh = Math.max(4, Math.round(frac * h));
        const thin = x.firstTry.of < MIN_PCT;
        return (
          <rect
            key={x.week}
            x={i * (w + gap) + (thin ? 0.5 : 0)}
            y={h - bh + (thin ? 0.5 : 0)}
            width={thin ? w - 1 : w}
            height={thin ? bh - 1 : bh}
            rx={1}
            className={thin ? 'fill-none stroke-teal' : 'fill-teal'}
          />
        );
      })}
    </svg>
  );
}
