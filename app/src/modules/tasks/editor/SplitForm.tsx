import { useState } from 'react';
import { canTransitionTask } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { ModeToggle } from '../../../components/ModeToggle';
import { Text } from '../../../components/Text';
import { useSplitTask } from '../../../data/hooks/useTasks';
import { fmtDuration } from '../../../lib/format';
import { SPLIT_TITLE_SUFFIX, splitDefaults } from '../taskMath';

type Finish = 'done' | 'keep';

const minutes = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const valid = (v: string) => v.trim() === '' || Number(v) >= 0; // empty, or real non-negative minutes
const str = (n: number | null) => n?.toString() ?? '';

// Split: one task becomes two (split.ts). This part is either done (an actual is required — it feeds
// calibration, like Mark done) or keeps going (rescoped), and the rest becomes a new task with its own
// estimate. Never cancels. `onDone(finish)` lets the editor close on done and stay open on keep.
export function SplitForm({
  task,
  onDone,
  onCancel,
}: {
  task: Task;
  onDone: (finish: Finish) => void;
  onCancel: () => void;
}) {
  const split = useSplitTask();
  // "Done" is only a legal finish once work has started — the state machine forbids backlog|planned →
  // done. An unstarted task can only keep going, so there's no choice to offer.
  const canFinishDone = canTransitionTask(task.status, 'done');
  const [finish, setFinish_] = useState<Finish>(canFinishDone ? 'done' : 'keep');
  const [title, setTitle] = useState(task.title);
  const [actual, setActual] = useState(() =>
    task.actualAccruedMin > 0 ? String(Math.round(task.actualAccruedMin)) : '',
  );
  const [estimate, setEstimate] = useState(str(splitDefaults(task, 'keep').thisPart));
  const [restTitle, setRestTitle] = useState(`${task.title}${SPLIT_TITLE_SUFFIX}`);
  const [restEstimate, setRestEstimate] = useState(str(splitDefaults(task, finish).rest));
  // Switching mode re-defaults the rest's estimate — unless the user already typed their own.
  const setFinish = (next: Finish) => {
    if (restEstimate === str(splitDefaults(task, finish).rest))
      setRestEstimate(str(splitDefaults(task, next).rest));
    setFinish_(next);
  };

  const done = finish === 'done';
  // Where the rest lands — the server rule, stated generally: plan rows are loaded per day here, and a
  // planned task can have rows ahead of today (the night "Tomorrow"), so naming a day could be wrong.
  const landing =
    task.status === 'planned' || task.status === 'in_progress'
      ? 'Lands on this one’s latest plan day, else the backlog'
      : 'Lands in the backlog';
  // The two parts' total vs the original working estimate — the size of the rescope, at a glance.
  const thisPart = done ? minutes(actual) : minutes(estimate);
  const rest = minutes(restEstimate);
  const total = thisPart != null && rest != null ? thisPart + rest : null;
  const numbersOk = valid(actual) && valid(estimate) && valid(restEstimate);
  const canSubmit =
    !!title.trim() && !!restTitle.trim() && (!done || actual.trim() !== '') && numbersOk;

  async function submit() {
    if (!canSubmit || split.isPending) return;
    try {
      await split.mutateAsync({
        id: task.id,
        input: {
          finish,
          ...(title.trim() !== task.title ? { title: title.trim() } : {}),
          ...(done
            ? { actualMin: Number(actual) }
            : minutes(estimate) !== task.estimateMin
              ? { estimateMin: minutes(estimate) }
              : {}),
          followUp: { title: restTitle.trim(), estimateMin: rest },
        },
      });
      onDone(finish);
    } catch {
      // Surfaced inline below — swallow so it isn't an unhandled rejection (which leaked the raw error
      // JSON to the page).
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
        <Text size="sm" tone="muted">
          Not started yet — the parts get their own estimates.
        </Text>
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
          <Field
            label="Actual (min)"
            aria-label="This part's actual (min)"
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="minutes"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            className="w-28"
          />
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
          Remaining → new task
        </Text>
        <Field
          label="Title"
          aria-label="New task's title"
          value={restTitle}
          onChange={(e) => setRestTitle(e.target.value)}
        />
        <Field
          label="Estimate (min)"
          aria-label="New task's estimate (min)"
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
      </div>

      <div className="flex gap-2">
        {/* aria-disabled while pending (like the details Save): a keyboard user who pressed Split keeps
            focus on it, rather than dropping to <body> if the split fails. Invalid input really disables. */}
        <Button
          size="sm"
          disabled={!canSubmit}
          aria-disabled={split.isPending}
          onClick={submit}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          Split
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!numbersOk && (
        <Text size="xs" tone="danger">
          Minutes can&apos;t be negative.
        </Text>
      )}
      {split.isError && (
        <div role="alert">
          <Text size="xs" tone="danger">
            Couldn&apos;t split this task. Please try again.
          </Text>
        </div>
      )}
    </div>
  );
}
