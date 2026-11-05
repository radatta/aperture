import { useState } from 'react';
import type { Ref } from 'react';
import { TASK_REFLECTION_MAX } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Text } from '../../components/Text';
import { fmtDuration } from '../../lib/format';
import { useSetActual, useTransitionTask } from '../../data/hooks/useTasks';
import { useEditSlot } from './editor/editState';
import type { EditSlots } from './editor/editState';
import { NotesField } from './notes/NotesField';
import { REFLECTION_FIELD } from './notes/reflectionField';
import { notesValue } from './notes/parseNotes';

// "Done" captures the actual — prefilled from tracked pomodoro time, but editable (works with no
// timer). This is what the estimate is measured against. `initialActualMin` lets a caller prefill the
// LIVE elapsed (accrued + a running timer) that isn't on the task yet; defaults to the persisted value.
// `actualRef` lets the task editor's finish-intent focus the Actual field when the dialog opens.
// Nothing tracked starts EMPTY, not "0" (you'd type over it), and an empty field can't be submitted —
// a quiet 0 would land in calibration as a real actual.
// The optional reflection (what went well, what to do differently) rides the same write as the actual;
// focus stays on Actual. Left as it was seeded, it's not sent at all, so one saved meanwhile (MCP, another
// device) is kept; cleared, it sends null. Over the cap, Mark done disables (no maxLength, so a paste is
// never silently cut). In the task modal (`edits`), a changed reflection makes leaving ask first.
// Either onDone uses the finished task and Cancel is its own (the task modal, which asks about unsaved
// edits), or onDone is the caller's plain close and Cancel just closes too.
type DoneProps =
  | { onDone: (task: Task) => void; onCancel: () => void }
  | { onDone: () => void; onCancel?: undefined };

export function DoneForm({
  task,
  initialActualMin,
  actualRef,
  edits,
  onDone,
  onCancel,
}: {
  task: Task;
  initialActualMin?: number;
  actualRef?: Ref<HTMLInputElement>;
  edits?: EditSlots;
} & DoneProps) {
  const setActual = useSetActual();
  const transition = useTransitionTask();
  const [actual, setActual_] = useState<string>(() => {
    const tracked = Math.round(initialActualMin ?? task.actualAccruedMin);
    return tracked > 0 ? String(tracked) : '';
  });
  const [seed] = useState(() => task.reflection ?? '');
  const [reflection, setReflection] = useState(seed);
  const reflectionTrimmed = notesValue(reflection);
  const reflectionChanged = reflectionTrimmed !== notesValue(seed);
  const reflectionOver = reflectionTrimmed.length > TASK_REFLECTION_MAX;
  // One submit per tap, set before the first await: transition.isPending is false during setActual's,
  // and arrives a tick late anyway.
  const [busy, setBusy] = useState(false);
  // Mid-submit it's on its way, and leaving then never waits on the finish (it closes nothing later).
  useEditSlot(edits, 'finish', reflectionChanged && !busy ? 'dirty' : 'clean');
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await setActual.mutateAsync({
        id: task.id,
        actualMin: Number(actual),
        reflection: reflectionChanged ? reflectionTrimmed || null : undefined,
      });
      onDone(await transition.mutateAsync({ id: task.id, to: 'done' }));
    } catch {
      // Said below.
    } finally {
      setBusy(false);
    }
  }
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
      <NotesField
        {...REFLECTION_FIELD}
        placeholder="How did it go? Optional."
        saved={null}
        value={reflection}
        editing
        focusOnEdit={false}
        onEdit={() => {}}
        onChange={setReflection}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={submit}
          aria-disabled={busy}
          disabled={actual.trim() === '' || reflectionOver}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          Mark done
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel ?? (() => (onDone as () => void)())}>
          Cancel
        </Button>
      </div>
      {(setActual.isError || transition.isError) && (
        <div role="alert">
          <Text size="sm" tone="danger">
            Couldn’t mark it done — try again.
          </Text>
        </div>
      )}
    </div>
  );
}
