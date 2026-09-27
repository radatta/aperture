import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Text } from '../../../components/Text';
import { fmtDuration } from '../../../lib/format';
import { useDeleteTask, useTransitionTask } from '../../../data/hooks/useTasks';

// Permanent delete — a real destructive action, so it asks first (alertdialog + autoFocus on the
// confirm, since it reveals below the row the trigger is in). The copy warns when there's logged
// time (calibration) and when a calendar event will go with it. No onDone: once the task leaves the
// list, TaskModalHost closes the modal.
export function DeleteConfirm({ task, onCancel }: { task: Task; onCancel: () => void }) {
  const del = useDeleteTask();
  return (
    <div
      role="alertdialog"
      aria-label={`Delete ${task.title}?`}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <Text size="sm" tone="danger">
        Delete “{task.title}”? It disappears from every list and can’t be undone.
        {task.actualAccruedMin > 0 &&
          ` The ${fmtDuration(task.actualAccruedMin)} logged won’t count toward calibration.`}
        {task.gcalEventId && ' Its calendar event will be removed too.'}
      </Text>
      <Button
        autoFocus
        variant="gold"
        size="sm"
        disabled={del.isPending || del.isSuccess}
        onClick={() => del.mutate(task.id)}
      >
        Delete
      </Button>
      <Button variant="quiet" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

// Drop = abandon (status → cancelled). Distinct from Delete: the row is kept as history, not erased.
// Cancelled is terminal and excludes the task from calibration, and dropping clears a linked calendar
// event — so it confirms too, though more lightly than Delete. Closes the modal on success.
export function DropConfirm({
  task,
  onCancel,
  onDone,
}: {
  task: Task;
  onCancel: () => void;
  onDone: () => void;
}) {
  const transition = useTransitionTask();
  return (
    <div
      role="alertdialog"
      aria-label={`Drop ${task.title}?`}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <Text size="sm" tone="danger">
        Drop “{task.title}”? It leaves your active lists (kept as history) and won’t count toward
        calibration.
        {task.gcalEventId && ' Its calendar event will be removed too.'}
      </Text>
      <Button
        autoFocus
        variant="gold"
        size="sm"
        disabled={transition.isPending}
        onClick={() => transition.mutate({ id: task.id, to: 'cancelled' }, { onSuccess: onDone })}
      >
        Drop
      </Button>
      <Button variant="quiet" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
