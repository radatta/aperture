import { useState } from 'react';
import type { Ref } from 'react';
import { canEditEstimate, fmtMonthDayYear } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { Select } from '../../../components/Select';
import { Text } from '../../../components/Text';
import { useCategories } from '../../../data/hooks/useCategories';
import { useSetCategory, useSetDueDay, useSetEstimate } from '../../../data/hooks/useTasks';
import { fmtDuration } from '../../../lib/format';
import { scopeLabel, suggestedBuffer } from '../taskMath';

// The details editor inside the task modal — absorbs ScopePanel (estimate/buffer/category) and the
// in_progress DueDayForm (due). Estimate + buffer edit only while backlog|planned; past that the
// calibration baseline is frozen (canEditEstimate), so they show read-only. Category + due stay
// editable at any status. Title is display-only for now — the editable field lands with setTaskTitle.
// Save writes only what changed and closes; the modal's own Close is the cancel.
export function TaskDetailsForm({
  task,
  onDone,
  estimateRef,
}: {
  task: Task;
  onDone: () => void;
  estimateRef?: Ref<HTMLInputElement>;
}) {
  const { data: cats = [] } = useCategories();
  const setEstimate = useSetEstimate();
  const setCategory = useSetCategory();
  const setDueDay = useSetDueDay();

  const editEstimate = canEditEstimate(task);
  // A finished task is history: its due date is locked (re-dating it is meaningless). Category stays
  // editable at every status — recategorizing a done task actually matters, since calibration
  // aggregates by category.
  const isTerminal = task.status === 'done' || task.status === 'cancelled';
  const [estimate, setEstimate_] = useState<string>(task.estimateMin?.toString() ?? '');
  const [buffer, setBuffer] = useState<string>(task.bufferMin?.toString() ?? '');
  const [categoryId, setCategoryId] = useState<string>(task.categoryId ?? '');
  const [dueDay, setDueDay_] = useState<string>(task.dueDay ?? '');

  const estNum = estimate === '' ? null : Number(estimate);
  const estimateDirty =
    editEstimate &&
    (String(task.estimateMin ?? '') !== estimate || String(task.bufferMin ?? '') !== buffer);
  const dueDirty = !isTerminal && (task.dueDay ?? '') !== dueDay;
  const dirty = estimateDirty || (task.categoryId ?? '') !== categoryId || dueDirty;
  const pending = setEstimate.isPending || setCategory.isPending || setDueDay.isPending;

  async function save() {
    // Never call setEstimate past planning — the machine throws on a frozen estimate.
    if (estimateDirty) {
      await setEstimate.mutateAsync({
        id: task.id,
        estimateMin: estNum,
        bufferMin: buffer === '' ? null : Number(buffer),
      });
    }
    if ((task.categoryId ?? '') !== categoryId) {
      await setCategory.mutateAsync({ id: task.id, categoryId: categoryId || null });
    }
    if (dueDirty) {
      await setDueDay.mutateAsync({ id: task.id, dueDay: dueDay || null });
    }
    onDone();
  }

  return (
    <section className="flex flex-col gap-3">
      <Text as="h3" size="sm" weight="semibold" tone="muted">
        {scopeLabel(task)}
      </Text>
      <div className="flex flex-wrap items-end gap-3">
        {editEstimate ? (
          <>
            <Field
              ref={estimateRef}
              label="Estimate (min)"
              type="number"
              min={0}
              inputMode="numeric"
              value={estimate}
              onChange={(e) => setEstimate_(e.target.value)}
              className="w-28"
            />
            <div className="flex items-end gap-2">
              <Field
                label="Buffer (min)"
                type="number"
                min={0}
                inputMode="numeric"
                value={buffer}
                onChange={(e) => setBuffer(e.target.value)}
                className="w-28"
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={estNum === null || estNum <= 0}
                onClick={() => estNum && setBuffer(String(suggestedBuffer(estNum)))}
                title="Suggest +25%"
              >
                +25%
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1">
            <Text size="sm" tone="muted">
              Estimate
            </Text>
            <Text tabular>
              {task.estimateMin != null
                ? `${fmtDuration(task.estimateMin)}${task.bufferMin ? ` +${fmtDuration(task.bufferMin)}` : ''}`
                : 'Not set'}
            </Text>
            {task.estimateLockedMin != null && (
              <Text size="xs" tone="muted">
                Frozen at {fmtDuration(task.estimateLockedMin)} when work started — calibration is
                measured against this.
              </Text>
            )}
          </div>
        )}
        <Select
          label="Category"
          placeholder="Uncategorized"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          options={cats.map((c) => ({ value: c.id, label: c.label }))}
          className="w-40"
        />
        {isTerminal ? (
          <div className="flex flex-col gap-1">
            <Text size="sm" tone="muted">
              Due
            </Text>
            <Text tabular>{task.dueDay ? fmtMonthDayYear(task.dueDay) : 'No due date'}</Text>
          </div>
        ) : (
          <Field
            label="Due"
            type="date"
            value={dueDay}
            onChange={(e) => setDueDay_(e.target.value)}
            className="w-40"
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={pending || !dirty}>
          Save
        </Button>
        {dirty && (
          <Text size="xs" tone="muted">
            Unsaved changes
          </Text>
        )}
      </div>
    </section>
  );
}
