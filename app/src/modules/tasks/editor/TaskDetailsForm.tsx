import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { canEditEstimate, fmtClock12, fmtMonthDayYear, TASK_NOTES_MAX } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { Select } from '../../../components/Select';
import { Text } from '../../../components/Text';
import { Textarea } from '../../../components/Textarea';
import { useCategoryOptions } from '../../../data/hooks/useCategories';
import {
  useSetCategory,
  useSetDue,
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
// finished. Notes edit at any status too. Save writes only what changed and keeps the modal open
// (showing "Saved"); the modal's own Close is the way out.
export function TaskDetailsForm({
  task: live,
  onDirtyChange,
  estimateRef,
}: {
  task: Task;
  onDirtyChange?: (dirty: boolean) => void;
  estimateRef?: Ref<HTMLInputElement>;
}) {
  // What the form compares against: the task the last Save's final write returned, until the refetch
  // (or a newer edit from elsewhere) catches up — otherwise the fields would read dirty, and the old
  // values would flash, for the moment between the write and the refetch.
  const [saved, setSaved] = useState<Task | null>(null);
  const task = saved && saved.updatedAt >= live.updatedAt ? saved : live;
  const categoryOptions = useCategoryOptions(task.categoryId);
  const setTitle = useSetTaskTitle();
  const setEstimate = useSetEstimate();
  const setCategory = useSetCategory();
  const setDue = useSetDue();
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
  const [dueTime, setDueTime] = useState<string>(task.dueTime ?? '');
  const [notes, setNotes_] = useState<string>(task.notes ?? '');
  const [editingNotes, setEditingNotes] = useState(false);
  // One flag for the whole sequence of writes (the mutations' own isPending gaps between them).
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const estNum = estimate === '' ? null : Number(estimate);
  const titleTrimmed = title.trim();
  const titleDirty = titleTrimmed !== task.title;
  const estimateDirty =
    editEstimate &&
    (String(task.estimateMin ?? '') !== estimate || String(task.bufferMin ?? '') !== buffer);
  const dueDirty =
    !isTerminal && ((task.dueDay ?? '') !== dueDay || (task.dueTime ?? '') !== dueTime);
  const notesTrimmed = notesValue(notes);
  // Only a draft being edited counts: in view mode the field shows the live task.notes, so a stale draft
  // must never read as a change (or be saved back over a newer note).
  const notesDirty = editingNotes && notesTrimmed !== (task.notes ?? '');
  const notesOver = notesTrimmed.length > TASK_NOTES_MAX;
  const dirty =
    titleDirty || estimateDirty || (task.categoryId ?? '') !== categoryId || dueDirty || notesDirty;

  // Bubble dirtiness up so the modal's exit paths (Esc/backdrop/Close) can confirm before discarding.
  // Not while saving: those edits are already on their way, so "Discard" would be a lie.
  const reportDirty = dirty && !saving;
  useEffect(() => onDirtyChange?.(reportDirty), [reportDirty, onDirtyChange]);

  // The fields as they are right now, readable after the save's awaits (the closure's are stale).
  const fields = { title, estimate, buffer, categoryId, dueDay, dueTime, notes };
  const current = useRef(fields);
  useEffect(() => {
    current.current = fields;
  });

  // Writes what changed, in order, then reseeds each field from the task the last write returned (so
  // "030" reads back as "30") and shows the rendered note again — but only fields the user hasn't
  // touched since pressing Save, so typing during a slow save is never overwritten. Stays open; a
  // failure keeps the edits and says so.
  async function save() {
    if (saving || !dirty) return;
    const sent = fields;
    setSaving(true);
    setFailed(false);
    try {
      let next = task;
      if (titleDirty) next = await setTitle.mutateAsync({ id: task.id, title: titleTrimmed });
      // Never call setEstimate past planning — the machine throws on a frozen estimate.
      if (estimateDirty)
        next = await setEstimate.mutateAsync({
          id: task.id,
          estimateMin: estNum,
          bufferMin: buffer === '' ? null : Number(buffer),
        });
      if ((task.categoryId ?? '') !== categoryId)
        next = await setCategory.mutateAsync({ id: task.id, categoryId: categoryId || null });
      if (dueDirty)
        next = await setDue.mutateAsync({
          id: task.id,
          due: { dueDay: dueDay || null, dueTime: (dueDay && dueTime) || null },
        });
      if (notesDirty)
        next = await setNotes.mutateAsync({ id: task.id, notes: notesTrimmed || null });
      const now = current.current;
      const untouched = (k: keyof typeof sent) => now[k] === sent[k];
      if (untouched('title')) setTitle_(next.title);
      if (untouched('estimate')) setEstimate_(next.estimateMin?.toString() ?? '');
      if (untouched('buffer')) setBuffer(next.bufferMin?.toString() ?? '');
      if (untouched('categoryId')) setCategoryId(next.categoryId ?? '');
      if (untouched('dueDay')) setDueDay_(next.dueDay ?? '');
      if (untouched('dueTime')) setDueTime(next.dueTime ?? '');
      if (untouched('notes')) {
        setNotes_(next.notes ?? '');
        setEditingNotes(false);
      }
      setSaved(next);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
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
            <Text tabular>
              {task.dueDay
                ? `${fmtMonthDayYear(task.dueDay)}${task.dueTime ? ` · ${fmtClock12(task.dueTime)}` : ''}`
                : 'No due date'}
            </Text>
          </div>
        ) : (
          <>
            <Field
              label="Due"
              type="date"
              value={dueDay}
              onChange={(e) => {
                setDueDay_(e.target.value);
                if (!e.target.value) setDueTime(''); // a time never outlives its day
              }}
              className="w-40"
            />
            {/* Optional deadline time. Needs a day; clearing the day clears it. */}
            <Field
              label="Due time"
              type="time"
              step={60}
              value={dueTime}
              disabled={!dueDay}
              onChange={(e) => setDueTime(e.target.value)}
              className="w-32"
            />
          </>
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
        {/* Nothing to save (or mid-save) is aria-disabled, not disabled: a keyboard user who pressed
            Save keeps focus on it instead of dropping to <body> as it disables itself. Invalid input
            still really disables it. */}
        <Button
          size="sm"
          onClick={save}
          aria-disabled={saving || !dirty}
          disabled={!titleTrimmed || notesOver}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          Save
        </Button>
        {dirty && !saving && (
          <Text size="xs" tone="muted">
            Unsaved changes
          </Text>
        )}
        <span role="status">
          {((failed && dirty) || (!failed && saved && !dirty)) && (
            <Text size="xs" tone={failed ? 'danger' : 'teal'}>
              {failed ? 'Couldn’t save — try again.' : 'Saved'}
            </Text>
          )}
        </span>
      </div>
    </section>
  );
}
