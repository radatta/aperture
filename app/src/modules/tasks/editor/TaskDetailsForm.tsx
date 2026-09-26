import { useEffect, useState } from 'react';
import type { Ref } from 'react';
import { canEditEstimate, fmtMonthDayYear, TASK_NOTES_MAX } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { Select } from '../../../components/Select';
import { Text } from '../../../components/Text';
import { Textarea } from '../../../components/Textarea';
import { useCategoryOptions } from '../../../data/hooks/useCategories';
import {
  useSetCategory,
  useSetDueDay,
  useSetEstimate,
  useSetTaskNotes,
  useSetTaskTitle,
} from '../../../data/hooks/useTasks';
import { fmtDuration } from '../../../lib/format';
import { NotesField } from '../notes/NotesField';
import { notesValue } from '../notes/parseNotes';
import { scopeLabel, suggestedBuffer } from '../taskMath';

// The details editor inside the task modal — absorbs ScopePanel (estimate/buffer/category) and the
// in_progress DueDayForm (due). Title is editable at any status (display text, never the lock).
// Estimate + buffer edit only while backlog|planned; past that the calibration baseline is frozen
// (canEditEstimate), so they show read-only. Category stays editable at any status; due locks once
// finished. Notes edit at any status too. Save writes only what changed and closes; the modal's own
// Close is the cancel.
export function TaskDetailsForm({
  task,
  onDone,
  onDirtyChange,
  estimateRef,
}: {
  task: Task;
  onDone: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  estimateRef?: Ref<HTMLInputElement>;
}) {
  const categoryOptions = useCategoryOptions(task.categoryId);
  const setTitle = useSetTaskTitle();
  const setEstimate = useSetEstimate();
  const setCategory = useSetCategory();
  const setDueDay = useSetDueDay();
  const setNotes = useSetTaskNotes();

  const editEstimate = canEditEstimate(task);
  // A finished task is history: its due date is locked (re-dating it is meaningless). Category and
  // title stay editable at every status — recategorizing a done task matters (calibration aggregates
  // by category), and a title is just display text.
  const isTerminal = task.status === 'done' || task.status === 'cancelled';
  const [title, setTitle_] = useState<string>(task.title);
  const [estimate, setEstimate_] = useState<string>(task.estimateMin?.toString() ?? '');
  const [buffer, setBuffer] = useState<string>(task.bufferMin?.toString() ?? '');
  const [categoryId, setCategoryId] = useState<string>(task.categoryId ?? '');
  const [dueDay, setDueDay_] = useState<string>(task.dueDay ?? '');
  const [notes, setNotes_] = useState<string>(task.notes ?? '');
  const [editingNotes, setEditingNotes] = useState(false);

  const estNum = estimate === '' ? null : Number(estimate);
  const titleTrimmed = title.trim();
  const titleDirty = titleTrimmed !== task.title;
  const estimateDirty =
    editEstimate &&
    (String(task.estimateMin ?? '') !== estimate || String(task.bufferMin ?? '') !== buffer);
  const dueDirty = !isTerminal && (task.dueDay ?? '') !== dueDay;
  const notesTrimmed = notesValue(notes);
  // Only a draft being edited counts: in view mode the field shows the live task.notes, so a stale draft
  // must never read as a change (or be saved back over a newer note).
  const notesDirty = editingNotes && notesTrimmed !== (task.notes ?? '');
  const notesOver = notesTrimmed.length > TASK_NOTES_MAX;
  const dirty =
    titleDirty || estimateDirty || (task.categoryId ?? '') !== categoryId || dueDirty || notesDirty;
  const pending =
    setTitle.isPending ||
    setEstimate.isPending ||
    setCategory.isPending ||
    setDueDay.isPending ||
    setNotes.isPending;

  // Bubble dirtiness up so the modal's exit paths (Esc/backdrop/Close) can confirm before discarding.
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  async function save() {
    if (titleDirty) {
      await setTitle.mutateAsync({ id: task.id, title: titleTrimmed });
    }
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
    if (notesDirty) {
      await setNotes.mutateAsync({ id: task.id, notes: notesTrimmed || null });
    }
    onDone();
  }

  return (
    <section className="flex flex-col gap-3">
      <Textarea
        label="Title"
        rows={2}
        value={title}
        onChange={(e) => setTitle_(e.target.value)}
        className="text-base"
      />
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
          options={categoryOptions}
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
      <NotesField
        saved={task.notes}
        value={notes}
        editing={editingNotes}
        onEdit={() => {
          setNotes_(task.notes ?? ''); // start from the live note, not the one seen at mount
          setEditingNotes(true);
        }}
        onChange={setNotes_}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={pending || !dirty || !titleTrimmed || notesOver}>
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
