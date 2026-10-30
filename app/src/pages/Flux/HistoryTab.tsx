import { useState } from 'react';
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
  const [exerciseId, setExerciseId] = useState<string | null>(null);
  const q = useFluxSets(all ? {} : { from: addDays(today, -(WINDOW_DAYS - 1)), to: today });
  const sets = q.data ?? [];
  const ids = [...new Set(sets.map((s) => s.exerciseId))].filter(isExerciseId);
  const shown = exerciseId ? sets.filter((s) => s.exerciseId === exerciseId) : sets;
  const def = exerciseId && isExerciseId(exerciseId) ? getExercise(exerciseId) : null;

  return (
    <div className="flex flex-col gap-4">
      <FluxTabs />
      <UnsavedSetsStrip />
      {sets.length === 0 ? (
        <EmptyState
          pending={q.isPending}
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
        <>
          <Chips
            label="Exercise"
            options={[
              { value: null, label: 'All' },
              ...ids.map((id) => ({ value: id, label: SHORT_NAMES[id] })),
            ]}
            value={exerciseId}
            onChange={setExerciseId}
          />
          {def && <Trend def={def} sets={shown} />}
          {groupByDay(shown).map((g) => (
            <section key={g.day} aria-label={fmtDayHeading(g.day)} className="flex flex-col">
              <Text as="h2" size="sm" weight="semibold" tone="muted">
                {g.day === today ? 'Today' : fmtDayHeading(g.day)}
              </Text>
              <ul className="flex flex-col">
                {g.sets.map((s) => (
                  <SetRow key={s.id} set={s} />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
      {!all && !q.isPending && (
        <div className="flex flex-wrap items-center gap-2">
          <Text size="xs" tone="muted">
            Showing the last {WINDOW_DAYS} days.
          </Text>
          <Button variant="quiet" size="sm" onClick={() => setAll(true)}>
            Show all
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
          label: `${fmtMonthShortDay(p.s.day)} · ${fmtValue(p.m)}`,
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
