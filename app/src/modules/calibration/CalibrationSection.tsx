import { addDays, todayKey } from '@aperture/shared';
import { Card } from '../../components/Card';
import { StatPair } from '../../components/StatPair';
import { Text } from '../../components/Text';
import { useCalibration } from '../../data/hooks/useCalibration';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { aggregate } from './calibration';

// Estimate-vs-actual, read as evidence not judgment: an aggregate over-ratio plus the most recent
// per-task deltas. Honestly sparse early — the aggregate only means something after weeks of data.
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
    <div className="flex flex-col gap-4">
      <Card>
        {agg.count === 0 ? (
          <Text tone="subtle" size="sm">
            No finished tasks with an estimate yet. Scope a task, work it, mark it done — the
            estimate-vs-actual shows up here.
          </Text>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <Text size="2xl" weight="semibold" tone={agg.overPct! > 0 ? 'gold' : 'teal'} tabular>
                {agg.overPct! > 0 ? '+' : ''}
                {agg.overPct}%
              </Text>
              <Text tone="muted">
                {agg.overPct! > 0 ? 'over estimate on average' : 'vs estimate on average'}
              </Text>
            </div>
            <Text size="sm" tone="subtle">
              across {agg.count} {agg.count === 1 ? 'task' : 'tasks'} · last 30 days
              {agg.count < 5 ? ' · still sparse — read it lightly' : ''}
            </Text>
          </div>
        )}
      </Card>

      {recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
            Recent
          </Text>
          {recent.map((p) => (
            <Card key={p.taskId}>
              <div className="flex flex-col gap-1">
                <Text size="sm" tone="muted" className="truncate">
                  {titleById.get(p.taskId) ?? 'Task'}
                </Text>
                <StatPair estimateMin={p.estimateLockedMin} actualMin={p.actualAccruedMin} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
