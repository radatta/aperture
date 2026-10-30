import { useState } from 'react';
import type { PartsSummary, Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Text } from '../../../components/Text';
import { fmtDuration } from '../../../lib/format';
import { useDeleteTask, useTransitionTask } from '../../../data/hooks/useTasks';

// Permanent delete — a real destructive action, so it asks first (alertdialog + autoFocus on the
// confirm, since it reveals below the row the trigger is in). The copy warns when there's logged
// time (calibration) and when a calendar event will go with it. No onDone: once the task leaves the
// list, TaskModalHost closes the modal. A parent goes with every part, so it names the count.
export function DeleteConfirm({
  task,
  parts,
  onCancel,
}: {
  task: Task;
  parts?: PartsSummary; // set when it's a parent
  onCancel: () => void;
}) {
  const del = useDeleteTask();
  const n = parts?.parts.length ?? 0;
  const logged = parts
    ? parts.parts.reduce((s, p) => s + p.actualAccruedMin, 0)
    : task.actualAccruedMin;
  return (
    <div
      role="alertdialog"
      aria-label={`Delete ${task.title}?`}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <Text size="sm" tone="danger">
        {n > 0
          ? `Delete “${task.title}” and its ${n} ${n === 1 ? 'part' : 'parts'}? They disappear from every list and can’t be undone.`
          : `Delete “${task.title}”? It disappears from every list and can’t be undone.`}
        {logged > 0 && ` The ${fmtDuration(logged)} logged won’t count toward calibration.`}
        {(task.gcalEventId || parts?.parts.some((p) => p.gcalEventId)) &&
          ` ${n > 0 ? 'Their' : 'Its'} calendar ${n > 0 ? 'events' : 'event'} will be removed too.`}
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
      {del.isError && (
        <div role="alert" className="w-full">
          <Text size="sm" tone="danger">
            Couldn’t delete it — try again.
          </Text>
        </div>
      )}
    </div>
  );
}

// Drop = abandon (status → cancelled). Distinct from Delete: the row is kept as history, not erased.
// Cancelled is terminal and excludes the task from calibration, and dropping clears a linked calendar
// event — so it confirms too, though more lightly than Delete. Closes the modal on success.
export function DropConfirm({
  task,
  parts,
  onCancel,
  onDone,
}: {
  task: Task;
  parts?: PartsSummary; // set when it's a parent: its open parts are dropped with it
  onCancel: () => void;
  onDone: (task: Task) => void; // the task as the drop returned it
}) {
  const transition = useTransitionTask();
  // mutateAsync, not a per-call onSuccess: TanStack skips that if this unmounts first (a refetch showing
  // the task cancelled takes Drop away), and the modal would stay open on a dropped task. One per tap.
  const [dropping, setDropping] = useState(false);
  async function drop() {
    if (dropping) return;
    setDropping(true);
    try {
      onDone(await transition.mutateAsync({ id: task.id, to: 'cancelled' }));
    } catch {
      // Said below.
    } finally {
      setDropping(false);
    }
  }
  const open = parts?.open.length ?? 0;
  const done = parts?.done ?? 0;
  return (
    <div
      role="alertdialog"
      aria-label={`Drop ${task.title}?`}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <Text size="sm" tone="danger">
        Drop “{task.title}”? It leaves your active lists (kept as history) and won’t count toward
        calibration.
        {open > 0 &&
          ` Its ${open} open ${open === 1 ? 'part is' : 'parts are'} dropped too, with their calendar blocks`}
        {open > 0 &&
          (done > 0
            ? `; ${done === 1 ? 'the done part stays' : `the ${done} done parts stay`} as history.`
            : '.')}
        {task.gcalEventId && ' Its calendar event will be removed too.'}
      </Text>
      <Button
        autoFocus
        variant="gold"
        size="sm"
        onClick={drop}
        aria-disabled={dropping}
        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
      >
        Drop
      </Button>
      <Button variant="quiet" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      {transition.isError && (
        <div role="alert" className="w-full">
          <Text size="sm" tone="danger">
            Couldn’t drop it — try again.
          </Text>
        </div>
      )}
    </div>
  );
}
