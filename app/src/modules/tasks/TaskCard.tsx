import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { fmtDuration } from '../../lib/format';
import { useSetActual, useSplitTask, useTransitionTask } from '../../data/hooks/useTasks';
import { usePomodoro } from '../pomodoro/pomodoro-context';
import { CategoryTag } from './CategoryTag';
import { ScopePanel } from './ScopePanel';
import { remainingMin } from './taskMath';

type Panel = null | 'scope' | 'split' | 'done';

// One task, with the lifecycle actions its status allows. `actions` is an optional slot for
// context-specific buttons (add-to-today / remove-from-plan) supplied by the section.
export function TaskCard({ task, actions }: { task: Task; actions?: ReactNode }) {
  const [panel, setPanel] = useState<Panel>(null);
  const transition = useTransitionTask();
  const pomodoro = usePomodoro();
  const canScope = task.status === 'backlog' || task.status === 'planned';
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Text weight="medium" className="truncate">
            {task.title}
          </Text>
          <div className="flex items-center gap-2">
            <CategoryTag categoryId={task.categoryId} />
            <TaskMeta task={task} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {canScope && (
            <Button variant="ghost" size="sm" onClick={() => toggle('scope')}>
              Scope
            </Button>
          )}
          {canScope && (
            <Button size="sm" onClick={() => transition.mutate({ id: task.id, to: 'in_progress' })}>
              Start
            </Button>
          )}
          {task.status === 'in_progress' && (
            <Button variant="ghost" size="sm" onClick={() => pomodoro.startFocus({ taskId: task.id })}>
              Focus
            </Button>
          )}
          {task.status === 'in_progress' && (
            <Button size="sm" onClick={() => toggle('done')}>
              Done
            </Button>
          )}
          {task.status !== 'done' && task.status !== 'cancelled' && (
            <Button variant="ghost" size="sm" onClick={() => toggle('split')}>
              Split
            </Button>
          )}
          {canScope && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => transition.mutate({ id: task.id, to: 'cancelled' })}
            >
              Cancel
            </Button>
          )}
          {actions}
        </div>
      </div>

      {panel === 'scope' && <ScopePanel task={task} onDone={() => setPanel(null)} />}
      {panel === 'split' && <SplitForm task={task} onDone={() => setPanel(null)} />}
      {panel === 'done' && <DoneForm task={task} onDone={() => setPanel(null)} />}
    </Card>
  );
}

function TaskMeta({ task }: { task: Task }) {
  if (task.status === 'in_progress') {
    const hasEstimate = task.estimateLockedMin != null || task.estimateMin != null;
    return (
      <Text size="xs" tone="muted" tabular>
        {fmtDuration(task.actualAccruedMin)} logged ·{' '}
        {hasEstimate ? `${fmtDuration(remainingMin(task))} left` : 'no estimate'}
      </Text>
    );
  }
  if (task.estimateMin != null) {
    return (
      <Text size="xs" tone="muted" tabular>
        {fmtDuration(task.estimateMin)} est
        {task.bufferMin ? ` +${fmtDuration(task.bufferMin)}` : ''}
      </Text>
    );
  }
  return (
    <Text size="xs" tone="subtle">
      unscoped
    </Text>
  );
}

// Scope change = split. Finish the original (done keeps its partial calibration; cancelled excludes
// it) and spawn a fresh backlog follow-up for the remaining work — the locked estimate is never edited.
function SplitForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const split = useSplitTask();
  const [title, setTitle] = useState(`${task.title} (cont.)`);
  const [finish, setFinish] = useState<'done' | 'cancelled'>(
    task.status === 'in_progress' ? 'done' : 'cancelled',
  );
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <Text size="sm" tone="muted">
        Split off the remaining scope into a new backlog task.
      </Text>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Follow-up title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-64"
        />
        <Select
          label="Finish original as"
          value={finish}
          onChange={(e) => setFinish(e.target.value as 'done' | 'cancelled')}
          options={[
            { value: 'done', label: 'Done (keeps calibration)' },
            { value: 'cancelled', label: 'Cancelled (excluded)' },
          ]}
          className="w-52"
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!title.trim() || split.isPending}
          onClick={async () => {
            await split.mutateAsync({ id: task.id, finishStatus: finish, followUpTitle: title.trim() });
            onDone();
          }}
        >
          Split
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// "Done" captures the actual — prefilled from tracked pomodoro time, but editable (works with no
// timer). This is what the estimate is measured against.
function DoneForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const setActual = useSetActual();
  const transition = useTransitionTask();
  const [actual, setActual_] = useState<string>(String(Math.round(task.actualAccruedMin)));
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Actual (min)"
          type="number"
          min={0}
          inputMode="numeric"
          value={actual}
          onChange={(e) => setActual_(e.target.value)}
          className="w-32"
        />
        {task.estimateLockedMin != null && (
          <Text size="sm" tone="muted" tabular>
            vs {fmtDuration(task.estimateLockedMin)} estimated
          </Text>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={transition.isPending}
          onClick={async () => {
            const n = actual === '' ? 0 : Number(actual);
            await setActual.mutateAsync({ id: task.id, actualMin: n });
            await transition.mutateAsync({ id: task.id, to: 'done' });
            onDone();
          }}
        >
          Mark done
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
