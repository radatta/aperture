import { useState } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { useCategories } from '../../data/hooks/useCategories';
import { useSetCategory, useSetEstimate } from '../../data/hooks/useTasks';
import { suggestedBuffer } from './taskMath';

// The scoping step: estimate + buffer + category. Only reachable while backlog|planned — the stub
// (via the shared machine) throws if the estimate is already frozen, so this UI is never shown then.
export function ScopePanel({ task, onDone }: { task: Task; onDone: () => void }) {
  const { data: cats = [] } = useCategories();
  const setEstimate = useSetEstimate();
  const setCategory = useSetCategory();

  const [estimate, setEstimate_] = useState<string>(task.estimateMin?.toString() ?? '');
  const [buffer, setBuffer] = useState<string>(task.bufferMin?.toString() ?? '');
  const [categoryId, setCategoryId] = useState<string>(task.categoryId ?? '');

  const estNum = estimate === '' ? null : Number(estimate);

  async function save() {
    await setEstimate.mutateAsync({
      id: task.id,
      estimateMin: estNum,
      bufferMin: buffer === '' ? null : Number(buffer),
    });
    if ((task.categoryId ?? '') !== categoryId) {
      await setCategory.mutateAsync({ id: task.id, categoryId: categoryId || null });
    }
    onDone();
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field
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
        <Select
          label="Category"
          placeholder="Uncategorized"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          options={cats.map((c) => ({ value: c.id, label: c.label }))}
          className="w-40"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={setEstimate.isPending}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        {/* The new "Edit" affordance opens this panel after work started, where the field still
            edits but the calibration baseline is already frozen. Saying "editable until work
            starts" there would contradict the surface that opened it. */}
        <Text size="xs" tone="muted">
          {task.estimateLockedMin != null
            ? "Editing this won't move the frozen estimate calibration is measured against."
            : 'Editable until work starts — then it freezes.'}
        </Text>
      </div>
    </div>
  );
}
