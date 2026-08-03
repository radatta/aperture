import { Text } from '../../components/Text';
import { useAllTasks } from '../../data/hooks/useTasks';
import { TaskCard } from './TaskCard';

// The backlog deep view: everything in flight. In-progress work up top (finish or split), then the
// unscoped/scoped backlog (scope, start, cancel, split). Planned-for-today lives in the Plan tab.
export function BacklogSection() {
  const { data: tasks = [] } = useAllTasks();
  const inProgress = tasks.filter((t) => t.status === 'in_progress');
  const backlog = tasks.filter((t) => t.status === 'backlog');

  return (
    <div className="flex flex-col gap-4">
      {inProgress.length > 0 && (
        <div className="flex flex-col gap-2">
          <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
            In progress
          </Text>
          {inProgress.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
          Backlog
        </Text>
        {backlog.length === 0 ? (
          <Text tone="subtle" size="sm">
            Backlog is clear. Capture a task from the bar below to add one.
          </Text>
        ) : (
          backlog.map((t) => <TaskCard key={t.id} task={t} />)
        )}
      </div>
    </div>
  );
}
