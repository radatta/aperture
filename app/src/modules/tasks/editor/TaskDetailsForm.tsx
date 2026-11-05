import { useEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import {
  canEditEstimate,
  endsAfterParent,
  fmtClock12,
  fmtMonthDayYear,
  TASK_NOTES_MAX,
  TASK_REFLECTION_MAX,
  timeKeyOfInput,
} from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { LoadError } from '../../../components/LoadError';
import { Field } from '../../../components/Field';
import { Select } from '../../../components/Select';
import { Text } from '../../../components/Text';
import { Textarea } from '../../../components/Textarea';
import { useCategoryOptions } from '../../../data/hooks/useCategories';
import { usePlaceOptions } from '../../../data/hooks/usePlaces';
import { useSuggestCategory } from '../../../data/hooks/useSuggestCategory';
import {
  useSetCategory,
  useSetDue,
  useSetEstimate,
  useSetTaskNotes,
  useSetTaskPlace,
  useSetTaskReflection,
  useSetTaskTitle,
} from '../../../data/hooks/useTasks';
import { fmtDuration } from '../../../lib/format';
import { NotesField } from '../notes/NotesField';
import { REFLECTION_FIELD } from '../notes/reflectionField';
import { notesValue } from '../notes/parseNotes';
import { scopeLabel, suggestedBuffer } from '../taskMath';
import { useEditSlot } from './editState';
import type { EditSlots } from './editState';

// The details editor inside the task modal — absorbs ScopePanel (estimate/buffer/category) and the
// in_progress DueDayForm (due). Title is editable at any status (display text, never the lock).
// Estimate + buffer (the working estimate) edit at any open status — rescoping mid-task is fine, since
// calibration is measured against the baseline frozen at start, which never moves; a finished task's
// estimate is history, so it shows read-only (canEditEstimate). Category stays editable at any status;
// due and the place (the store's errand list) lock once finished — a finished errand's place is what
// kept it out of calibration, so it's history too. A part's place is its parent's (places.ts), so a part
// has no picker, only a quiet line. Notes edit at any status, and so does a done task's reflection. Save
// writes only what changed and keeps the modal open (showing "Saved"); the modal's own Close is the way out. A parent's estimate is the sum of its parts
// (read-only); a part's own time is when its block ends, so its due fields read Ends / Ends at (parts.ts),
// with a quiet note when that's after its parent's deadline.
export function TaskDetailsForm({
  task: live,
  parts,
  parent,
  edits,
  estimateRef,
}: {
  task: Task;
  parts?: { estimateMin: number | null; unscoped: number }; // set when it's a parent
  parent?: Pick<Task, 'title' | 'dueDay' | 'dueTime'>; // set when it's a part
  edits?: EditSlots;
  estimateRef?: Ref<HTMLInputElement>;
}) {
  // What the form compares against: the task the last Save's final write returned, until the refetch
  // (or a newer edit from elsewhere) catches up — otherwise the fields would read dirty, and the old
  // values would flash, for the moment between the write and the refetch.
  const [saved, setSaved] = useState<Task | null>(null);
  const task = saved && saved.updatedAt >= live.updatedAt ? saved : live;
  const categoryOptions = useCategoryOptions(task.categoryId);
  const placeOptions = usePlaceOptions();
  const setTitle = useSetTaskTitle();
  const setEstimate = useSetEstimate();
  const setCategory = useSetCategory();
  const setDue = useSetDue();
  const setNotes = useSetTaskNotes();
  const setPlace = useSetTaskPlace();
  // The roster's name for a slug; one it doesn't know reads as the slug itself.
  const placeName = (slug: string) =>
    placeOptions.places.find((p) => p.slug === slug)?.name ?? slug;
  const setReflection = useSetTaskReflection();
  const suggest = useSuggestCategory();

  const isPart = !!task.parentId;
  const editEstimate = canEditEstimate(task) && !parts;
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
  const [place, setPlace_] = useState<string>(task.place ?? '');
  const [editingNotes, setEditingNotes] = useState(false);
  // The reflection: the look back written at Mark done, edited here like notes. A done task shows it,
  // and so does any other with one — except one in progress, whose Done form already holds it.
  const [reflection, setReflection_] = useState<string>(task.reflection ?? '');
  const [editingReflection, setEditingReflection] = useState(false);
  // A confident guess at the category while the field is empty, from the title and notes as typed. A
  // part takes its parent's category, so it never gets one. Tap-only: it fills the select, the form goes
  // dirty, Save writes it like a manual pick — never pre-selected (PRODUCT §2: the enrichment pass).
  const suggestion = useMemo(
    () => (categoryId === '' && !isPart ? suggest({ id: task.id, title, notes }) : null),
    [suggest, categoryId, isPart, task.id, title, notes],
  );
  const suggestedLabel = suggestion
    ? categoryOptions.options.find((o) => o.value === suggestion.categoryId)?.label
    : undefined;
  const showReflection =
    task.status === 'done' || (!!task.reflection && task.status !== 'in_progress');
  // A change that lands from elsewhere — a split's rename/rescope, a calendar pull (an edit made in
  // Google), another device, the MCP — reseeds every field the user hasn't touched (still showing the
  // previous value); edits in progress stay, so a Save can't write stale values back over the change.
  // Due day + time reseed as a pair: never your time on the other side's day. Done during render
  // (React's "adjust state on prop change"), so nothing flashes dirty for a frame.
  const [prevTask, setPrevTask] = useState(task);
  if (prevTask !== task) {
    setPrevTask(task);
    const reseed = (set: (f: (v: string) => string) => void, was: string, now: string) =>
      set((v) => (v === was ? now : v));
    reseed(setTitle_, prevTask.title, task.title);
    reseed(
      setEstimate_,
      prevTask.estimateMin?.toString() ?? '',
      task.estimateMin?.toString() ?? '',
    );
    reseed(setBuffer, prevTask.bufferMin?.toString() ?? '', task.bufferMin?.toString() ?? '');
    reseed(setCategoryId, prevTask.categoryId ?? '', task.categoryId ?? '');
    if (dueDay === (prevTask.dueDay ?? '') && dueTime === (prevTask.dueTime ?? '')) {
      setDueDay_(task.dueDay ?? '');
      setDueTime(task.dueTime ?? '');
    }
    reseed(setNotes_, prevTask.notes ?? '', task.notes ?? '');
    reseed(setPlace_, prevTask.place ?? '', task.place ?? '');
    reseed(setReflection_, prevTask.reflection ?? '', task.reflection ?? '');
  }
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
  const placeDirty = !isTerminal && !isPart && (task.place ?? '') !== place;
  const reflectionTrimmed = notesValue(reflection);
  const reflectionDirty = editingReflection && reflectionTrimmed !== (task.reflection ?? '');
  const reflectionOver = reflectionTrimmed.length > TASK_REFLECTION_MAX;
  const dirty =
    titleDirty ||
    estimateDirty ||
    (task.categoryId ?? '') !== categoryId ||
    dueDirty ||
    notesDirty ||
    placeDirty ||
    reflectionDirty;

  // What the modal's exit paths (Esc/backdrop/Close, opening another task) act on: 'dirty' confirms
  // before discarding; 'saving' waits for the write — those edits are on their way, so "Discard" would
  // be a lie, and leaving would lose them if it fails.
  useEditSlot(edits, 'details', saving ? 'saving' : dirty ? 'dirty' : 'clean');

  // The fields as they are right now, readable after the save's awaits (the closure's are stale).
  const fields = {
    title,
    estimate,
    buffer,
    categoryId,
    dueDay,
    dueTime,
    notes,
    place,
    reflection,
  };
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
      // Never call setEstimate on a finished task — the machine throws (its estimate is history).
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
      if (placeDirty) next = await setPlace.mutateAsync({ id: task.id, place: place || null });
      if (reflectionDirty)
        next = await setReflection.mutateAsync({
          id: task.id,
          reflection: reflectionTrimmed || null,
        });
      const now = current.current;
      const untouched = (k: keyof typeof sent) => now[k] === sent[k];
      if (untouched('title')) setTitle_(next.title);
      if (untouched('estimate')) setEstimate_(next.estimateMin?.toString() ?? '');
      if (untouched('buffer')) setBuffer(next.bufferMin?.toString() ?? '');
      if (untouched('categoryId')) setCategoryId(next.categoryId ?? '');
      if (untouched('dueDay')) setDueDay_(next.dueDay ?? '');
      if (untouched('dueTime')) setDueTime(next.dueTime ?? '');
      if (untouched('place')) setPlace_(next.place ?? '');
      if (untouched('notes')) {
        setNotes_(next.notes ?? '');
        setEditingNotes(false);
      }
      if (untouched('reflection')) {
        setReflection_(next.reflection ?? '');
        setEditingReflection(false);
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
            {task.estimateLockedMin != null && (
              <Text size="xs" tone="muted" className="w-full">
                Started at {fmtDuration(task.estimateLockedMin)} — calibration is measured against
                that.
              </Text>
            )}
          </>
        ) : parts ? (
          <div className="flex flex-col gap-1">
            <Text size="sm" tone="muted">
              Estimate
            </Text>
            <Text tabular>
              {parts.estimateMin != null ? fmtDuration(parts.estimateMin) : 'Not set'} — the sum of
              its parts
              {parts.unscoped > 0 && ` · ${parts.unscoped} unscoped`}
            </Text>
            {task.estimateLockedMin != null && (
              <Text size="xs" tone="muted">
                Locked at {fmtDuration(task.estimateLockedMin)} when the first part started — the
                parts’ total is measured against that.
              </Text>
            )}
          </div>
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
                Started at {fmtDuration(task.estimateLockedMin)}
                {task.status === 'cancelled'
                  ? '.' // dropped tasks never count toward calibration
                  : ' — calibration is measured against that.'}
              </Text>
            )}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Select
            label="Category"
            placeholder="Uncategorized"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            options={categoryOptions.options}
            disabled={categoryOptions.failed}
            className="w-40"
          />
          {suggestion && suggestedLabel && (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => setCategoryId(suggestion.categoryId)}
              aria-label={`Use suggested category ${suggestedLabel}`}
              aria-description="From your other tasks — tap to use"
              title="From your other tasks — tap to use"
              className="border border-dashed border-line"
            >
              {suggestedLabel}?
            </Button>
          )}
        </div>
        {categoryOptions.failed && (
          <LoadError size="xs" onRetry={categoryOptions.retry}>
            Couldn’t load categories.
          </LoadError>
        )}
        {isPart
          ? // It follows its parent: moving the parent moves it, so there's nothing to pick here.
            task.place && (
              <Text size="xs" tone="muted" className="w-full">
                On @{placeName(task.place)} — a part follows its parent’s place.
              </Text>
            )
          : isTerminal
            ? // History, shown like the other finished fields — not a select that looks editable.
              (placeOptions.places.length > 0 || task.place) && (
                <div className="flex flex-col gap-1">
                  <Text size="sm" tone="muted">
                    Place
                  </Text>
                  <Text>{task.place ? `@${placeName(task.place)}` : 'No place'}</Text>
                </div>
              )
            : // With no places at all there's no list to put it on — the picker would only say "No place".
              (placeOptions.failed || placeOptions.places.length > 0 || task.place) && (
                <Select
                  label="Place"
                  placeholder="No place"
                  value={place}
                  onChange={(e) => setPlace_(e.target.value)}
                  options={[
                    ...placeOptions.places.map((p) => ({ value: p.slug, label: p.name })),
                    // A slug the roster doesn't know still shows as what it is, never as "No place".
                    ...(task.place && !placeOptions.places.some((p) => p.slug === task.place)
                      ? [{ value: task.place, label: `@${task.place}` }]
                      : []),
                  ]}
                  disabled={!placeOptions.loaded}
                  className="w-40"
                />
              )}
        {placeOptions.failed && (!isPart || task.place) && (
          <LoadError size="xs" onRetry={placeOptions.retry}>
            Couldn’t load places.
          </LoadError>
        )}
        {isTerminal ? (
          <div className="flex flex-col gap-1">
            <Text size="sm" tone="muted">
              {isPart ? 'Ends' : 'Due'}
            </Text>
            <Text tabular>
              {task.dueDay
                ? `${fmtMonthDayYear(task.dueDay)}${task.dueTime ? ` · ${fmtClock12(task.dueTime)}` : ''}`
                : isPart
                  ? 'No time'
                  : 'No due date'}
            </Text>
          </div>
        ) : (
          // One group, like Buffer + "+25%": the pair (300px) fits a line at 440 and 390, where a bare
          // Due time used to wrap alone under the row.
          <div className="flex items-end gap-3">
            <Field
              label={isPart ? 'Ends' : 'Due'}
              type="date"
              value={dueDay}
              onChange={(e) => {
                setDueDay_(e.target.value);
                if (!e.target.value) setDueTime(''); // a time never outlives its day
              }}
              className="w-40"
            />
            {/* Optional deadline time (a part's: when its block ends). Needs a day; clearing it clears this. */}
            <Field
              label={isPart ? 'Ends at' : 'Due time'}
              type="time"
              step={60}
              value={dueTime}
              disabled={!dueDay}
              onChange={(e) => setDueTime(timeKeyOfInput(e.target.value))}
              className="w-32"
            />
          </div>
        )}
      </div>
      {parent &&
        endsAfterParent(
          isTerminal ? task : { dueDay: dueDay || null, dueTime: dueTime || null },
          parent,
        ) && (
          <Text size="sm" tone="subtle">
            Ends after {parent.title} is due.
          </Text>
        )}
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
      {showReflection && (
        <NotesField
          {...REFLECTION_FIELD}
          placeholder="How did it go? What would you do differently?"
          saved={task.reflection}
          value={reflection}
          editing={editingReflection}
          onEdit={() => {
            setReflection_(task.reflection ?? '');
            setEditingReflection(true);
          }}
          onChange={setReflection_}
        />
      )}
      <div className="flex items-center gap-2">
        {/* Nothing to save (or mid-save) is aria-disabled, not disabled: a keyboard user who pressed
            Save keeps focus on it instead of dropping to <body> as it disables itself. Invalid input
            still really disables it. */}
        <Button
          size="sm"
          onClick={save}
          aria-disabled={saving || !dirty}
          disabled={!titleTrimmed || notesOver || reflectionOver}
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
