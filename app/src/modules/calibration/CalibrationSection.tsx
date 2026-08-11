import { addDays, todayKey } from '@aperture/shared';
import { Card } from '../../components/Card';
import { DeltaBar } from '../../components/DeltaBar';
import { Text } from '../../components/Text';
import { fmtDuration } from '../../lib/format';
import { useCalibration } from '../../data/hooks/useCalibration';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { aggregate } from './calibration';

// Estimate-vs-actual, read as evidence not judgment. The per-task deltas are drawn, not listed:
// a column of "1h 18m · 1h est · +30%" makes you do the subtraction yourself, which is exactly the
// work the signature feature is supposed to do for you. Honestly sparse early — the aggregate only
// means something after weeks of data, and it says so.
export function CalibrationSection() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const from = addDays(today, -30);

  const { data: points = [] } = useCalibration(from, today);
  const { data: tasks = [] } = useAllTasks();
  const titleById = new Map(tasks.map((t) => [t.id, t.title]));

  const agg = aggregate(points);
  const recent = points.slice(-8).reverse();

  return (
    <div className="flex flex-col gap-5">
      <Card>
        {agg.count === 0 ? (
          <div className="flex flex-col gap-1">
            <Text tone="muted" size="sm">
              No finished tasks with an estimate yet.
            </Text>
            <Text tone="subtle" size="sm">
              Scope a task, work it, mark it done — the gap between what you thought it would take
              and what it took shows up here.
            </Text>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
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
            <Text size="xs" tone="subtle">
              {fmtDuration(agg.totalActualMin)} spent against {fmtDuration(agg.totalEstimateMin)}{' '}
              estimated · {agg.count} {agg.count === 1 ? 'task' : 'tasks'} · last 30 days
              {agg.count < 5 ? ' · still sparse, read it lightly' : ''}
            </Text>
          </div>
        )}
      </Card>

      {recent.length > 0 && (
        <div className="flex flex-col gap-3">
          <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
            Recent
          </Text>
          {/* One card, one row per task — eight separate cards for eight one-line facts was the
              densest possible way to say very little. */}
          <Card>
            <div className="flex flex-col divide-y divide-line">
              {recent.map((p, i) => (
                <div key={p.taskId} className={i === 0 ? 'pb-3' : 'py-3 last:pb-0'}>
                  <DeltaBar
                    label={titleById.get(p.taskId) ?? 'Task'}
                    estimateMin={p.estimateLockedMin}
                    actualMin={p.actualAccruedMin}
                  />
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
