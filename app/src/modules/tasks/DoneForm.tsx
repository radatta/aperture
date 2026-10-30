import { useState } from 'react';
import type { Ref } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Text } from '../../components/Text';
import { fmtDuration } from '../../lib/format';
import { useSetActual, useTransitionTask } from '../../data/hooks/useTasks';

// "Done" captures the actual — prefilled from tracked pomodoro time, but editable (works with no
// timer). This is what the estimate is measured against. `initialActualMin` lets a caller prefill the
// LIVE elapsed (accrued + a running timer) that isn't on the task yet; defaults to the persisted value.
// `actualRef` lets the task editor's finish-intent focus the Actual field when the dialog opens.
// Nothing tracked starts EMPTY, not "0" (you'd type over it), and an empty field can't be submitted —
// a quiet 0 would land in calibration as a real actual.
export function DoneForm({
  task,
  initialActualMin,
  actualRef,
  onDone,
  onCancel,
}: {
  task: Task;
  initialActualMin?: number;
  actualRef?: Ref<HTMLInputElement>;
  onDone: () => void;
  onCancel?: () => void; // where Cancel isn't just closing (the task modal asks about unsaved edits)
}) {
  const setActual = useSetActual();
  const transition = useTransitionTask();
  const [actual, setActual_] = useState<string>(() => {
    const tracked = Math.round(initialActualMin ?? task.actualAccruedMin);
    return tracked > 0 ? String(tracked) : '';
  });
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          ref={actualRef}
          label="Actual (min)"
          type="number"
          min={0}
          inputMode="numeric"
          placeholder="minutes"
          value={actual}
          onChange={(e) => setActual_(e.target.value)}
          className="w-32"
        />
        {task.estimateLockedMin != null && (
          <Text size="sm" tone="muted" tabular>
            vs {fmtDuration(task.estimateLockedMin)} estimated
            {task.estimateMin !== task.estimateLockedMin && ' at start'}
          </Text>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={transition.isPending || actual.trim() === ''}
          onClick={async () => {
            await setActual.mutateAsync({ id: task.id, actualMin: Number(actual) });
            await transition.mutateAsync({ id: task.id, to: 'done' });
            onDone();
          }}
        >
          Mark done
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel ?? onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
