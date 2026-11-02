import { useEffect, useRef, useState } from 'react';
import { fmtDueDay, isTimed, todayKey } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { LoadError } from '../../components/LoadError';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { PlusIcon } from '../../components/icons';
import { useDisclosure } from '../../lib/useDisclosure';
import { useAddToDay } from '../../data/hooks/useAddToDay';
import { useCategories } from '../../data/hooks/useCategories';
import { usePlansForDay } from '../../data/hooks/usePlans';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { CategoryTag } from './CategoryTag';
import { labelOfFrom, matchesText, normalize } from './query';
import { byDueHint } from './taskMath';

// Enough to scan; past this, typing is faster than scrolling.
const CAP = 30;
const isOpen = (t: Task) =>
  t.status === 'backlog' || t.status === 'planned' || t.status === 'in_progress';

// Home's "+ Add": the quiet trigger for the dialog below. Focus returns here when it closes.
export function AddToTodayButton() {
  const d = useDisclosure();
  return (
    <>
      <button
        type="button"
        ref={d.triggerRef}
        onClick={d.onOpen}
        aria-label="Add to today"
        className="flex items-center gap-0.5 text-teal"
      >
        <PlusIcon size={13} />
        <Text size="xs" tone="teal">
          Add
        </Text>
      </button>
      <AddToTodayDialog open={d.open} onClose={d.onClose} />
    </>
  );
}

// Pull something onto today without leaving Home: find an open task and add it, or — when nothing
// matches what you typed — create it straight onto today. Stays open so you can add several.
//
// Same unsaved-changes guard as the task editor (TaskModal): Esc, a backdrop click and Close all go
// through `requestClose`, which confirms first when something's typed in the box — likely a task
// title you haven't added yet. Adding or creating clears the box, so a finished visit never prompts.
export function AddToTodayDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) {
      setDirty(false);
      setConfirming(false);
    }
  }, [open]);

  const requestClose = () => (dirty ? setConfirming(true) : onClose());

  // The body mounts only while open: a closed native <dialog> keeps its content in the DOM, and
  // remounting gives every visit a fresh search.
  return (
    <>
      <Modal open={open} onClose={requestClose} closeOnBackdrop label="Add to today">
        {open && <DialogBody onClose={requestClose} onDirtyChange={setDirty} />}
      </Modal>

      {/* Stacks on top of the dialog (a second native dialog → higher in the top layer). */}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        label="Discard unsaved changes?"
      >
        <div className="flex flex-col gap-3">
          <Text as="h2" size="lg" weight="semibold">
            Discard what you typed?
          </Text>
          <Text size="sm" tone="muted">
            It hasn’t been added. Leaving now loses it.
          </Text>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep editing
            </Button>
            <Button
              variant="gold"
              onClick={() => {
                setConfirming(false);
                onClose();
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function DialogBody({
  onClose,
  onDirtyChange,
}: {
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { data: settings } = useSettings();
  const dayStartHour = settings?.dayStartHour ?? 4;
  const today = todayKey(dayStartHour);
  const tasksQ = useAllTasks();
  const plansQ = usePlansForDay(today);
  const categoriesQ = useCategories();
  const { data: tasks = [] } = tasksQ;
  const { data: plans = [] } = plansQ;
  const { data: categories = [] } = categoriesQ;
  // An empty candidate list would read as "nothing to add" — a failed read says so instead.
  const listFailed =
    (tasksQ.isError && tasksQ.data === undefined) || (plansQ.isError && plansQ.data === undefined);
  const categoriesFailed = categoriesQ.isError && categoriesQ.data === undefined;
  const { addToDay, createToday } = useAddToDay();
  const [text, setText] = useState('');
  // Added this visit: they stay listed, marked "Added", instead of vanishing from under your thumb.
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => onDirtyChange(text.trim() !== ''), [text, onDirtyChange]);

  const labelOf = labelOfFrom(categories);
  const onToday = new Set(plans.map((p) => p.taskId));
  // A parent is never put on a day — its parts are (parts.ts), each labelled with what it's part of.
  const parentIds = new Set(tasks.map((t) => t.parentId).filter(Boolean));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const candidates = tasks.filter(
    (t) =>
      isOpen(t) &&
      !parentIds.has(t.id) &&
      (!onToday.has(t.id) || added.has(t.id)) &&
      matchesText(t, text, labelOf, false),
  );
  // A timed task's day is its time (lenses.md D13) — it lands on Today on its day, never added early.
  const matches = byDueHint(candidates.filter((t) => !isTimed(t)));
  const hidTimed = candidates.length > matches.length;
  const typed = text.trim();
  const exact =
    typed !== '' && tasks.some((t) => isOpen(t) && normalize(t.title) === normalize(typed));
  const markAdded = (id: string) => setAdded((s) => new Set(s).add(id));

  async function add(task: Task) {
    setNote(null);
    try {
      await addToDay(task);
      markAdded(task.id);
    } catch {
      setNote('Couldn’t add that — try again.');
    }
  }

  // Enter-then-click (or a double Enter) while the create is in flight must not make two tasks.
  const creating = useRef(false);
  async function create() {
    if (creating.current || !typed) return;
    creating.current = true;
    const title = typed;
    setText('');
    setNote(null);
    try {
      const r = await createToday(title);
      markAdded(r.task.id);
      if (!r.planned) setNote('Created, but couldn’t plan it — it’s in the backlog.');
    } catch {
      setText((current) => (current === '' ? title : current));
      setNote('Couldn’t create that — try again.');
    } finally {
      creating.current = false;
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Text as="h2" size="lg" weight="semibold">
        Add to today
      </Text>
      <Field
        aria-label="Find a task"
        placeholder="Find a task…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && typed && !exact && create()}
      />
      <div role="status">
        {note && (
          <Text size="sm" tone="danger">
            {note}
          </Text>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {typed && !exact && (
          <Button variant="ghost" size="sm" className="justify-start gap-1" onClick={create}>
            <PlusIcon size={13} /> Add “{typed}” as a new task today
          </Button>
        )}
        {listFailed && (
          <LoadError
            onRetry={() => {
              if (tasksQ.isError) void tasksQ.refetch();
              if (plansQ.isError) void plansQ.refetch();
            }}
          >
            Couldn’t load your tasks.
          </LoadError>
        )}
        {categoriesFailed && !listFailed && (
          <Text size="xs" tone="muted">
            Couldn’t load categories — #label search is off.
          </Text>
        )}
        {!listFailed &&
          matches.slice(0, CAP).map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-3 py-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <Text size="sm" className="min-w-0 truncate">
                  {t.title}
                </Text>
                <CategoryTag categoryId={t.categoryId} />
                {t.parentId && byId.get(t.parentId) && (
                  <Text size="xs" tone="muted" className="min-w-0 truncate">
                    of {byId.get(t.parentId)!.title}
                  </Text>
                )}
                {t.dueDay && (
                  <Text size="xs" tone="subtle" className="shrink-0">
                    {fmtDueDay(t.dueDay, today, t.dueTime, {
                      verb: t.parentId ? 'ends' : 'due',
                      dayStartHour,
                    })}
                  </Text>
                )}
              </div>
              {added.has(t.id) ? (
                <Text size="xs" tone="teal" className="shrink-0 px-3">
                  Added
                </Text>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  aria-label={`Add ${t.title} to today`}
                  onClick={() => add(t)}
                >
                  Add
                </Button>
              )}
            </div>
          ))}
        {matches.length > CAP && (
          <Text size="xs" tone="muted">
            {matches.length - CAP} more — narrow it down
          </Text>
        )}
        {hidTimed && (
          <Text size="xs" tone="muted">
            Timed tasks land on their day — break one down to work on it earlier.
          </Text>
        )}
        {!listFailed && matches.length === 0 && !typed && (
          <Text size="sm" tone="muted">
            Nothing waiting — type a title to create one for today.
          </Text>
        )}
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
