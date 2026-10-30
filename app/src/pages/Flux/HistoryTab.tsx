import { useEffect, useRef, useState } from 'react';
import { addDays, fmtDayHeading, fmtMonthShortDay, todayKey, type FluxSet } from '@aperture/shared';
import {
  getExercise,
  groupByDay,
  isExerciseId,
  setMetric,
  SHORT_NAMES,
  type ExerciseDefinition,
  type SetMetric,
} from '@aperture/shared/flux';
import { Button, ButtonLink } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useFluxSets } from '../../data/hooks/useFluxSets';
import { useSettings } from '../../data/hooks/useSettings';
import { cx } from '../../lib/cx';
import { Chips } from '../../modules/flux/ExerciseLibrary';
import { SetRow } from '../../modules/flux/SetRow';
import { Sparkline } from '../../modules/flux/Sparkline';
import { UnsavedSetsStrip } from '../../modules/flux/UnsavedSetsStrip';
import { FluxTabs } from './FluxTabs';

// /flux/history (D50): every saved set, by day, newest first — the last 90 days unless "Show all". Pick an
// exercise and its trend shows above the list: one number per set (setMetric), relative to each session's
// own neutral, so it's a trend to watch, not a clinical angle.
const WINDOW_DAYS = 90;
const MIN_TREND_POINTS = 3;

export function FluxHistoryTab() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const q = useFluxSets(all ? {} : { from: addDays(today, -(WINDOW_DAYS - 1)), to: today }, {
    keepPrevious: true, // the toggle below changes the window; the list stays up meanwhile
  });
  const loading = q.isPending || q.isPlaceholderData;
  const sets = q.data ?? [];
  const ids = [...new Set(sets.map((s) => s.exerciseId))].filter(isExerciseId);
  // A chip whose last set was just deleted is gone — so is its filter.
  const exerciseId = picked && ids.includes(picked as (typeof ids)[number]) ? picked : null;
  // …and stays gone once a loaded window lacks it (a delete, or a window it has no sets in): a set of it
  // coming back later (a refetch, another device) mustn't switch it on again. A failed fetch isn't one.
  useEffect(() => {
    if (picked && !exerciseId && q.isSuccess && !q.isPlaceholderData) setPicked(null);
  }, [picked, exerciseId, q.isSuccess, q.isPlaceholderData]);
  const shown = exerciseId ? sets.filter((s) => s.exerciseId === exerciseId) : sets;
  const def = exerciseId && isExerciseId(exerciseId) ? getExercise(exerciseId) : null;
  const chipsRef = useRef<HTMLDivElement>(null);
  // A chip filter's last set going takes the chip with it: land on All (the first chip) instead.
  const allChip = () =>
    exerciseId ? (chipsRef.current?.querySelector<HTMLElement>('button') ?? null) : null;

  return (
    <div className="flex flex-col gap-5">
      <FluxTabs />
      <UnsavedSetsStrip />
      {sets.length === 0 ? (
        <EmptyState
          pending={loading}
          error={q.isError}
          title={all ? 'No saved sets yet.' : `No sets in the last ${WINDOW_DAYS} days.`}
          action={
            <ButtonLink to="/flux" size="sm">
              Pick an exercise
            </ButtonLink>
          }
        >
          Every set you finish is saved here, with its count and range.
        </EmptyState>
      ) : (
        <div
          className={cx('flex flex-col gap-4', q.isPlaceholderData && 'opacity-60')}
          aria-busy={loading}
        >
          <div ref={chipsRef}>
            <Chips
              label="Exercise"
              options={[
                { value: null, label: 'All' },
                ...ids.map((id) => ({ value: id, label: SHORT_NAMES[id] })),
              ]}
              value={exerciseId}
              onChange={setPicked}
            />
          </div>
          {def && <Trend def={def} sets={shown} />}
          {groupByDay(shown).map((g) => (
            <section key={g.day} aria-labelledby={`flux-day-${g.day}`} className="flex flex-col">
              <Text as="h2" id={`flux-day-${g.day}`} size="sm" weight="semibold" tone="muted">
                {g.day === today ? 'Today' : fmtDayHeading(g.day)}
              </Text>
              <ul className="flex flex-col">
                {g.sets.map((s) => (
                  <SetRow key={s.id} set={s} fallbackFocus={allChip} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {!q.isPending && (
        // One button that flips, so focus stays put when the list grows or shrinks under it.
        <div className="flex flex-wrap items-center gap-2">
          <Text size="xs" tone="muted">
            {/* Says what's on screen: the old window's rows while the new one loads. */}
            {all && !q.isPlaceholderData
              ? 'Showing every saved set.'
              : `Showing the last ${WINDOW_DAYS} days.`}
          </Text>
          <Button variant="quiet" size="sm" onClick={() => setAll(!all)}>
            {all ? `Last ${WINDOW_DAYS} days` : 'Show all'}
          </Button>
        </div>
      )}
    </div>
  );
}

const fmtValue = (m: SetMetric) => `${m.value.toFixed(m.betterWhen === 'lower' ? 1 : 0)}°`;

// One exercise's trend as a stat tile: the latest number, the change since the first set shown, and the
// line. Fewer than three sets is no trend — the list says enough. Only an angle trends: a hold or rep
// count is the prescription met (a flat line on its own target), so those exercises keep the list alone.
function Trend({ def, sets }: { def: ExerciseDefinition; sets: readonly FluxSet[] }) {
  const points = [...sets]
    .sort((a, b) => a.completedAt - b.completedAt)
    .flatMap((s) => {
      const m = setMetric(def, s);
      return m?.unit === '°' ? [{ s, m }] : [];
    });
  if (points.length < MIN_TREND_POINTS) return null;
  const first = points[0]!;
  const last = points.at(-1)!;
  const delta = last.m.value - first.m.value;
  const better = last.m.betterWhen === 'higher' ? delta > 0 : delta < 0;
  const deltaText = `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${fmtValue({ ...last.m, value: Math.abs(delta) })} since ${fmtMonthShortDay(first.s.day)}`;
  const label = `${SHORT_NAMES[def.id as keyof typeof SHORT_NAMES] ?? def.name} · ${last.m.label}`;

  return (
    <Card className="flex flex-col gap-2 p-4">
      <Text size="xs" tone="muted">
        {label}
        {last.m.target !== undefined && ` · target ${last.m.target}°`}
      </Text>
      <div className="flex items-baseline gap-3">
        <Text size="2xl" weight="semibold">
          {fmtValue(last.m)}
        </Text>
        <Text size="sm" tone={delta !== 0 && better ? 'teal' : 'muted'}>
          {deltaText}
        </Text>
      </div>
      <Sparkline
        points={points.map((p) => ({
          value: p.m.value,
          label: `${fmtMonthShortDay(p.s.day)} · ${fmtValue(p.m)}${p.s.stoppedEarly ? ' · stopped early' : ''}`,
        }))}
        target={last.m.target}
        label={`${label}, ${points.length} sets: ${deltaText}`}
      />
      <Text size="xs" tone="muted">
        Measured from each session’s own neutral — a trend to watch, not a clinical angle.
      </Text>
    </Card>
  );
}
