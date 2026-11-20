import { addDays, todayKey } from '@aperture/shared';
import type { CalibrationPoint } from '@aperture/shared';
import { Card } from '../../components/Card';
import { DeltaBar } from '../../components/DeltaBar';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { fmtDuration } from '../../lib/format';
import { useCalibration } from '../../data/hooks/useCalibration';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import type { CalibrationAggregate } from './calibration';
import { aggregate, driftLabel, laneAggregates, recentPoints, rollupLabel } from './calibration';

// Estimate-vs-actual, read as evidence not judgment. The per-task deltas are drawn, not listed:
// a column of "1h 18m · 1h est · +30%" makes you do the subtraction yourself, which is exactly the
// work the signature feature is supposed to do for you. Honestly sparse early — the aggregate only
// means something after weeks of data, and it says so.
export function CalibrationSection() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const from = addDays(today, -30);

  const pointsQ = useCalibration(from, today);
  const tasksQ = useAllTasks();
  const { data: points = [] } = pointsQ;
  const { data: tasks = [] } = tasksQ;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // A done parent is the rollup of its parts (parts.ts), so its label says how many there were.
  const label = (p: CalibrationPoint) => rollupLabel(byId.get(p.taskId)?.title ?? 'Task', p.parts);

  const lanes = laneAggregates(points);
  const recent = recentPoints(points, (id) => byId.get(id)?.completedAt);

  // Never the "no finished tasks yet" copy for a read that failed (the Tasks page's error covers lists only).
  const failed =
    (pointsQ.isError && pointsQ.data === undefined) ||
    (tasksQ.isError && tasksQ.data === undefined);
  if (pointsQ.isPending || tasksQ.isPending || failed)
    return (
      <EmptyState
        pending={!failed}
        error={failed}
        onRetry={() => {
          if (pointsQ.isError) void pointsQ.refetch();
          if (tasksQ.isError) void tasksQ.refetch();
        }}
        title=""
      />
    );

  return (
    <div className="flex flex-col gap-5">
      {lanes ? (
        <>
          <GapCard agg={lanes.life} lane="Life" />
          <GapCard agg={lanes.aperture} lane="Aperture" />
        </>
      ) : (
        <GapCard agg={aggregate(points)} />
      )}

      {recent.length > 0 && (
        <div className="flex flex-col gap-3">
          <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
            Recent
          </Text>
          {/* One card, one row per task — eight separate cards for eight one-line facts was the
              densest possible way to say very little. */}
          <Card>
            <div className="flex flex-col divide-y divide-line">
              {recent.map((p, i) => {
                const drift = driftLabel(p);
                return (
                  <div key={p.taskId} className={i === 0 ? 'pb-3' : 'py-3 last:pb-0'}>
                    <DeltaBar
                      label={label(p)}
                      estimateMin={p.estimateLockedMin}
                      actualMin={p.actualAccruedMin}
                    />
                    {drift && (
                      <Text size="xs" tone="muted" tabular className="mt-1">
                        {drift}
                      </Text>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// One lane's headline. With no lane named it's the whole page's, worded as it always was. The Aperture lane is
// dev work, its minutes his attention (docs/areas/calibration/dev-lane.md); backfilled tickets are counted
// under it, never in its number.
function GapCard({ agg, lane }: { agg: CalibrationAggregate; lane?: string }) {
  return (
    <Card>
      <div className="flex flex-col gap-3" data-lane={lane?.toLowerCase()}>
        {lane && (
          <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
            {lane}
          </Text>
        )}
        {agg.count === 0 ? (
          <div className="flex flex-col gap-1">
            <Text tone="muted" size="sm">
              No finished tasks with an estimate yet.
            </Text>
            {!lane && (
              <Text tone="muted" size="sm">
                Scope a task, work it, mark it done — the gap between what you thought it would take
                and what it took shows up here.
              </Text>
            )}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Text size="3xl" weight="semibold" tone={agg.overPct! > 0 ? 'gold' : 'teal'} tabular>
                {agg.overPct! > 0 ? '+' : ''}
                {agg.overPct}%
              </Text>
              <Text tone="muted">
                {agg.overPct! > 0 ? 'over estimate on average' : 'vs estimate on average'}
              </Text>
            </div>
            {/* the aggregate as one bar, so the headline number has a shape */}
            <DeltaBar estimateMin={agg.totalEstimateMin} actualMin={agg.totalActualMin} />
            <Text size="xs" tone="muted">
              {fmtDuration(agg.totalActualMin)} spent against {fmtDuration(agg.totalEstimateMin)}{' '}
              estimated · {agg.count} {agg.count === 1 ? 'task' : 'tasks'} · last 30 days
              {agg.count < 5 ? ' · still sparse, read it lightly' : ''}
            </Text>
            {agg.retroCount > 0 && (
              <Text size="xs" tone="muted">
                {agg.retroCount} of {agg.count} estimated after the fact
              </Text>
            )}
          </>
        )}
        {agg.backfilledCount > 0 && (
          <Text size="xs" tone="muted">
            {agg.backfilledCount} backfilled · {fmtDuration(agg.backfilledActualMin)}, not scored
          </Text>
        )}
      </div>
    </Card>
  );
}
