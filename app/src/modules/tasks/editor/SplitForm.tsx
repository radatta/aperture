import { useState } from 'react';
import {
  canTransitionTask,
  isCalibrated,
  isTimed,
  needsEstimate,
  STANDALONE_PART_TITLE,
} from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { ModeToggle } from '../../../components/ModeToggle';
import { Text } from '../../../components/Text';
import { useSplitTask } from '../../../data/hooks/useTasks';
import { fmtDuration } from '../../../lib/format';
import { liveElapsedMin } from '../../home/rightNow';
import { usePomodoro } from '../../pomodoro/pomodoro-context';
import {
  SPLIT_TITLE_SUFFIX,
  splitDefaults,
  typedBadMinutes,
  WHOLE_MINUTES_ERROR,
} from '../taskMath';
import { useEditSlot } from './editState';
import type { EditSlots } from './editState';

type Finish = 'done' | 'keep';

const minutes = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const valid = (v: string) => v.trim() === '' || Number(v) >= 0; // empty, or real non-negative minutes
const str = (n: number | null) => n?.toString() ?? '';

// Split always yields parent + parts (split.ts). This part is either done (an actual is required, and an
// estimate if it has none — it feeds calibration, like Mark done) or keeps going (rescoped), and the rest becomes a new part with its
// own estimate. A standalone task becomes Part 1 under a new parent that keeps its deadline — all three
// titles are editable here, so what's typed is what's stored; a part (`parentTitle` set) gains a sibling.
// Never cancels. `onDone(finish)` lets the editor close on done and stay open on keep. A done split stops
// this task's running timer first, like Mark done (DoneForm): the actual prefills from the live elapsed, and
// the typed one replaces what the stop lands. A stop that doesn't land keeps the form and the timer.
export function SplitForm({
  task,
  parentTitle,
  onDone,
  onCancel,
  edits,
}: {
  task: Task;
  parentTitle?: string; // set when it's already a part
  onDone: (finish: Finish, original: Task) => void; // original: this task as the split returned it
  onCancel: () => void;
  edits?: EditSlots;
}) {
  const standalone = !task.parentId;
  const split = useSplitTask();
  const { timers, stop } = usePomodoro();
  // "Done" is only a legal finish once work has started — the state machine forbids backlog|planned →
  // done. An unstarted task can only keep going, so there's no choice to offer.
  const canFinishDone = canTransitionTask(task.status, 'done');
  const [finish, setFinish_] = useState<Finish>(canFinishDone ? 'done' : 'keep');
  const [deliverable, setDeliverable] = useState(task.title);
  const [title, setTitle] = useState(standalone ? STANDALONE_PART_TITLE : task.title);
  const [actual, setActual] = useState(() => {
    const tracked = Math.round(liveElapsedMin(task, timers));
    return tracked > 0 ? String(tracked) : '';
  });
  // An unscoped task's starts empty: an estimate of 0 with time logged would prefill the actual, as hindsight.
  const [estimate, setEstimate] = useState(
    needsEstimate(task) ? '' : str(splitDefaults(task, 'keep').thisPart),
  );
  const [restTitle, setRestTitle] = useState(
    standalone ? 'Part 2' : `${task.title}${SPLIT_TITLE_SUFFIX}`,
  );
  const [restEstimate, setRestEstimate_] = useState(str(splitDefaults(task, finish).rest));
  const [restTyped, setRestTyped] = useState(false);
  const setRestEstimate = (v: string) => {
    setRestEstimate_(v);
    setRestTyped(true);
  };
  // Switching mode re-defaults the rest's estimate — unless the user already typed their own.
  const setFinish = (next: Finish) => {
    if (!restTyped) setRestEstimate_(str(splitDefaults(task, next).rest));
    setFinish_(next);
  };
  // Set here, not read from the mutation (TanStack's isPending lands a tick later): the modal reads the
  // slot on the very next event.
  const [splitting, setSplitting] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  // Typed but not split asks before an exit; a split on its way holds it. The mode toggle alone isn't
  // an edit, and neither is the rest's estimate it re-defaults.
  const [initial] = useState(() => ({ deliverable, title, actual, estimate, restTitle }));
  const dirty =
    deliverable !== initial.deliverable ||
    title !== initial.title ||
    actual !== initial.actual ||
    estimate !== initial.estimate ||
    restTitle !== initial.restTitle ||
    (restTyped && restEstimate !== str(splitDefaults(task, finish).rest));
  // Once the split landed the typed values are stored: nothing left to discard, whatever still shows (a
  // done split hands the close to the modal's guard). Add parts always unmounts on success, so it has
  // no such flag.
  const [sent, setSent] = useState(false);
  useEditSlot(edits, 'reveal', sent ? 'clean' : splitting ? 'saving' : dirty ? 'dirty' : 'clean');

  const done = finish === 'done';
  // A done split of an unscoped task asks for the estimate too, in hindsight (the done gate, machines.ts).
  const askEstimate = done && needsEstimate(task);
  // Where the rest lands — the server rule, stated generally: plan rows are loaded per day here, and a
  // planned task can have rows ahead of today (the night "Tomorrow"), so naming a day could be wrong.
  const landing = isTimed(task)
    ? 'Lands on its day, by its time'
    : task.status === 'planned' || task.status === 'in_progress'
      ? 'Lands on this one’s latest plan day, else the backlog'
      : 'Lands in the backlog';
  // The two parts' total vs the original working estimate — the size of the rescope, at a glance.
  const thisPart = done ? minutes(actual) : minutes(estimate);
  const rest = minutes(restEstimate);
  // Only what shows counts: a done part's estimate field is there only when it's asked for.
  // An estimate is whole minutes or none (0 would read as scoped); what the form prefilled always passes, an
  // older fractional estimate included. An errand's actual takes what it always did.
  const calibrated = isCalibrated(task);
  const estimateOk = (v: string, seed: string) => v === seed || !typedBadMinutes(v);
  const numbersOk =
    (done && calibrated ? !typedBadMinutes(actual) : valid(actual)) &&
    (done ? !askEstimate || !typedBadMinutes(estimate) : estimateOk(estimate, initial.estimate)) &&
    estimateOk(restEstimate, str(splitDefaults(task, finish).rest));
  const negative = [done ? actual : estimate, restEstimate].some((v) => Number(v) < 0);
  const total = numbersOk && thisPart != null && rest != null ? thisPart + rest : null;
  const canSubmit =
    !!title.trim() &&
    !!restTitle.trim() &&
    (!standalone || !!deliverable.trim()) &&
    (!done || actual.trim() !== '') &&
    (!askEstimate || estimate.trim() !== '') &&
    numbersOk;

  async function submit() {
    if (!canSubmit || splitting) return;
    setSplitting(true);
    setStopFailed(false);
    try {
      if (done)
        for (const t of timers)
          if (t.session.kind === 'work' && t.session.taskId === task.id)
            await stop(t.session.id).catch((e: unknown) => {
              setStopFailed(true);
              throw e;
            });
      const { original } = await split.mutateAsync({
        id: task.id,
        input: {
          finish,
          ...(standalone ? { parentTitle: deliverable.trim() } : {}),
          ...(standalone || title.trim() !== task.title ? { title: title.trim() } : {}),
          ...(done
            ? {
                actualMin: Number(actual),
                ...(askEstimate ? { estimateMin: minutes(estimate) } : {}),
              }
            : minutes(estimate) !== task.estimateMin
              ? { estimateMin: minutes(estimate) }
              : {}),
          followUp: { title: restTitle.trim(), estimateMin: rest },
        },
      });
      setSent(true);
      onDone(finish, original);
    } catch {
      // Surfaced inline below — swallow so it isn't an unhandled rejection (which leaked the raw error
      // JSON to the page).
    } finally {
      setSplitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      {canFinishDone ? (
        <ModeToggle<Finish>
          size="sm"
          className="self-start"
          value={finish}
          onChange={setFinish}
          options={[
            { value: 'done', label: 'Done with this part' },
            { value: 'keep', label: 'Keep going' },
          ]}
        />
      ) : (
        // No Done here (it isn't in progress) — the parts each get an estimate of their own.
        <Text size="sm" tone="muted">
          Not in progress — each part gets its own estimate.
        </Text>
      )}

      {standalone && (
        <div className="flex flex-col gap-2">
          <Text as="p" size="sm" weight="semibold" tone="muted">
            Deliverable (new)
          </Text>
          <Field
            label="Title"
            aria-label="Deliverable's title"
            value={deliverable}
            onChange={(e) => setDeliverable(e.target.value)}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Text as="p" size="sm" weight="semibold" tone="muted">
          This part
        </Text>
        <Field
          label="Title"
          aria-label="This part's title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {done ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Actual (min)"
              aria-label="This part's actual (min)"
              type="number"
              min={calibrated ? 1 : 0}
              inputMode="numeric"
              placeholder="minutes"
              value={actual}
              onChange={(e) => setActual(e.target.value)}
              className="w-28"
            />
            {askEstimate && (
              <Field
                label="Estimate in hindsight"
                aria-label="This part's estimate in hindsight"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="minutes"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                className="w-28"
              />
            )}
          </div>
        ) : (
          <Field
            label="Estimate (min)"
            aria-label="This part's estimate (min)"
            type="number"
            min={0}
            inputMode="numeric"
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            className="w-28"
          />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Text as="p" size="sm" weight="semibold" tone="muted">
          {standalone ? 'Next part' : `Remaining → new part of ${parentTitle ?? 'its parent'}`}
        </Text>
        <Field
          label="Title"
          aria-label="Next part's title"
          value={restTitle}
          onChange={(e) => setRestTitle(e.target.value)}
        />
        <Field
          label="Estimate (min)"
          aria-label="Next part's estimate (min)"
          type="number"
          min={0}
          inputMode="numeric"
          value={restEstimate}
          onChange={(e) => setRestEstimate(e.target.value)}
          className="w-28"
        />
        <Text size="xs" tone="muted">
          {landing}
          {total != null &&
            ` · Both parts: ${fmtDuration(total)}${
              task.estimateMin != null ? ` · was ${fmtDuration(task.estimateMin)}` : ''
            }`}
        </Text>
        {standalone && (
          <Text size="xs" tone="muted">
            “{deliverable.trim() || task.title}” keeps the due date; the parts carry the work.
          </Text>
        )}
      </div>

      {askEstimate && (task.estimateLockedMin ?? 0) < 1 && (
        <Text size="xs" tone="muted">
          No estimate yet — what would you have said? It counts as estimated after the fact.
        </Text>
      )}
      {!numbersOk && (
        <Text size="xs" tone="danger">
          {negative ? "Minutes can't be negative." : WHOLE_MINUTES_ERROR}
        </Text>
      )}
      <div className="flex gap-2">
        {/* aria-disabled while pending (like the details Save): a keyboard user who pressed Split keeps
            focus on it, rather than dropping to <body> if the split fails. Invalid input really disables. */}
        <Button
          size="sm"
          disabled={!canSubmit}
          aria-disabled={splitting}
          onClick={submit}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          Split
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {(stopFailed || split.isError) && (
        <div role="alert">
          <Text size="xs" tone="danger">
            Couldn&apos;t split this task. Please try again.
          </Text>
        </div>
      )}
    </div>
  );
}
