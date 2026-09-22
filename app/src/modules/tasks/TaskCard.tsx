import { useState } from 'react';
import type { ReactNode } from 'react';
import { fmtDueDay, todayKey } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Text } from '../../components/Text';
import { PaperclipIcon } from '../../components/icons';
import { fmtDuration } from '../../lib/format';
import { useDisclosure } from '../../lib/useDisclosure';
import { useAttachments } from '../../data/hooks/useAttachments';
import { useSettings } from '../../data/hooks/useSettings';
import { useTransitionTask } from '../../data/hooks/useTasks';
import { usePomodoro } from '../pomodoro/pomodoro-context';
import { CategoryTag } from './CategoryTag';
import { RollTag } from '../rolls/RollTag';
import { TaskModal } from './TaskModal';
import { TaskTitleButton } from './TaskTitleButton';
import { remainingMin } from './taskMath';
import type { TaskEditorIntent } from './editor/TaskEditor';

// One task, slimmed to the lifecycle actions you press without thinking — Start, Focus, Done, plus the
// section's `actions` slot (add-to-today / remove-from-plan). Everything else — scoping, due, split,
// calendar, files, drop, delete — lives in the modal the title (or Scope/Done) opens. No overflow menu.
export function TaskCard({ task, actions }: { task: Task; actions?: ReactNode }) {
  const transition = useTransitionTask();
  const pomodoro = usePomodoro();
  const modal = useDisclosure();
  const [intent, setIntent] = useState<TaskEditorIntent>('view');
  const canScope = task.status === 'backlog' || task.status === 'planned';

  // `useDisclosure` returns focus to the title button on close; set the intent before opening so the
  // modal focuses the right field (finish → Actual, scope → Estimate).
  const openAs = (i: TaskEditorIntent) => {
    setIntent(i);
    modal.onOpen();
  };

  return (
    <Card className="px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <TaskTitleButton task={task} ref={modal.triggerRef} onOpen={() => openAs('view')} />
          <TaskMeta task={task} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {canScope && task.estimateMin == null && (
            <Button variant="quiet" size="sm" onClick={() => openAs('scope')}>
              Scope
            </Button>
          )}
          {canScope && (
            <Button size="sm" onClick={() => transition.mutate({ id: task.id, to: 'in_progress' })}>
              Start
            </Button>
          )}
          {task.status === 'in_progress' && (
            <>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => pomodoro.startFocus({ taskId: task.id })}
              >
                Focus
              </Button>
              <Button size="sm" onClick={() => openAs('finish')}>
                Done
              </Button>
            </>
          )}
        </div>
      </div>
      <TaskModal task={task} open={modal.open} intent={intent} onClose={modal.onClose} />
    </Card>
  );
}

// One quiet metadata line. Absence is shown by absence — except that an unscoped backlog task now says
// so, since the always-visible Scope button that used to carry that signal is gone from the card.
function TaskMeta({ task }: { task: Task }) {
  const { data: settings } = useSettings();
  const { data: attachments = [] } = useAttachments();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const fileCount = attachments.filter((a) => a.taskId === task.id).length;
  const canScope = task.status === 'backlog' || task.status === 'planned';
  const bits: string[] = [];
  if (task.status === 'in_progress') {
    const hasEstimate = task.estimateLockedMin != null || task.estimateMin != null;
    bits.push(`${fmtDuration(task.actualAccruedMin)} logged`);
    if (hasEstimate) bits.push(`${fmtDuration(remainingMin(task))} left`);
  } else if (task.estimateMin != null) {
    bits.push(
      `${fmtDuration(task.estimateMin)} est${task.bufferMin ? ` +${fmtDuration(task.bufferMin)}` : ''}`,
    );
  }

  return (
    <div className="flex items-center gap-2">
      <CategoryTag categoryId={task.categoryId} />
      {task.estimateMin == null && canScope && (
        <Text size="xs" tone="muted">
          not scoped
        </Text>
      )}
      {bits.length > 0 && (
        <Text size="xs" tone="muted" tabular>
          {bits.join(' · ')}
        </Text>
      )}
      {/* Deadline reads flat and quiet at every status — a lapsed due date is an honest signal, never
          a scold (no red, no countdown, no aggregate). Shown on done/cancelled too, as history. */}
      {task.dueDay && (
        <Text size="xs" tone="subtle">
          {fmtDueDay(task.dueDay, today)}
        </Text>
      )}
      {task.gcalEventId && (
        <Text size="xs" tone="teal">
          on calendar
        </Text>
      )}
      <RollTag rollId={task.rollId} />
      {fileCount > 0 && (
        <Text size="xs" tone="subtle" className="inline-flex items-center gap-0.5">
          <PaperclipIcon size={12} /> {fileCount}
        </Text>
      )}
    </div>
  );
}
