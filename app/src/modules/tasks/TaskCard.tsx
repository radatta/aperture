import { useRef } from 'react';
import type { ReactNode } from 'react';
import {
  deadlineOf,
  dueUrgency,
  fmtDueDay,
  isKeptNote,
  isPullFresh,
  parentOf,
  partsOf,
  partsSummary,
  todayKey,
} from '@aperture/shared';
import type { PartsSummary } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Text } from '../../components/Text';
import { NoteIcon, PaperclipIcon } from '../../components/icons';
import { cx } from '../../lib/cx';
import { fmtDuration } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useAttachments } from '../../data/hooks/useAttachments';
import { useSettings } from '../../data/hooks/useSettings';
import { useAllTasks, useTransitionTask } from '../../data/hooks/useTasks';
import { usePomodoro } from '../pomodoro/pomodoro-context';
import { CategoryTag } from './CategoryTag';
import { RollTag } from '../rolls/RollTag';
import { PartsList } from './PartRow';
import { TaskModalHost } from './TaskModalHost';
import { useOpenTask } from './task-modal-context';
import { TaskTitleButton } from './TaskTitleButton';
import { urgencyClass, urgencyLabel } from './dueStyle';
import { remainingMin } from './taskMath';
import type { TaskEditorIntent } from './editor/TaskEditor';

const ROW_CONTROLS = 'button, a, input, select, textarea, label';

// One task, slimmed to the lifecycle actions you press without thinking — Start, Focus, Done, plus the
// section's `actions` slot (add-to-today / remove-from-plan). Everything else — scoping, due, split,
// calendar, files, drop, delete — lives in the modal the title (or Scope/Done) opens. No overflow menu.
// `notesHit` marks a search result the title and category alone don't explain, so the row says why
// it's here. A parent (parts.ts) is the deliverable: never started itself, it shows its progress (its
// one-tap Mark done, once every part is dealt with, comes in `actions` from the list, which owns focus
// when the row leaves); `showParts` nests its parts under it (Week/Backlog).
interface TaskCardProps {
  task: Task;
  actions?: ReactNode;
  notesHit?: boolean;
  showParts?: boolean;
}

// The modal lives on the page (TaskModalHost), so it outlives a row that a save moves out of the list.
// A row rendered outside any host hosts itself.
export function TaskCard(props: TaskCardProps) {
  return useOpenTask() ? (
    <TaskRow {...props} />
  ) : (
    <TaskModalHost>
      <TaskRow {...props} />
    </TaskModalHost>
  );
}

function TaskRow({ task, actions, notesHit = false, showParts = false }: TaskCardProps) {
  const transition = useTransitionTask();
  const pomodoro = usePomodoro();
  const openTask = useOpenTask()!;
  const titleRef = useRef<HTMLButtonElement>(null);
  const { data: tasks = [] } = useAllTasks();
  const parts = partsOf(tasks, task.id);
  const summary = parts.length ? partsSummary(parts) : null;
  const canScope = !summary && (task.status === 'backlog' || task.status === 'planned');
  const now = useNow(); // re-read every minute, so a row changes colour on its own
  // Timed tasks only. A part answers to its parent's deadline — the part is where you act on it.
  const urgency = dueUrgency(deadlineOf(task, tasks), now);

  // The intent picks the field the modal focuses (finish → Actual, scope → Estimate); focus returns
  // to the title button on close.
  const openAs = (i: TaskEditorIntent) => openTask(task, i, titleRef.current);

  return (
    // A click anywhere on the row opens the editor too — the title button stays the keyboard path,
    // and clicks on controls are left alone.
    <Card
      className={cx('cursor-pointer px-3.5 py-3', urgencyClass(urgency))}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest(ROW_CONTROLS)) openAs('view');
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <TaskTitleButton task={task} ref={titleRef} onOpen={() => openAs('view')} />
          <TaskMeta
            task={task}
            notesHit={notesHit}
            urgency={urgencyLabel(urgency)}
            summary={summary}
            parent={parentOf(tasks, task)}
          />
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
      {summary && showParts && <PartsList parts={parts} />}
    </Card>
  );
}

// One quiet metadata line. Absence is shown by absence — except that an unscoped backlog task now says
// so, since the always-visible Scope button that used to carry that signal is gone from the card.
function TaskMeta({
  task,
  notesHit,
  urgency,
  summary,
  parent,
}: {
  task: Task;
  notesHit: boolean;
  urgency: string | null;
  summary: PartsSummary | null; // set when it's a parent
  parent: Task | undefined; // set when it's a part
}) {
  const { data: settings } = useSettings();
  const { data: attachments = [] } = useAttachments();
  const now = useNow();
  const today = todayKey(settings?.dayStartHour ?? 4, now);
  const fileCount = attachments.filter((a) => a.taskId === task.id).length;
  const canScope = !summary && (task.status === 'backlog' || task.status === 'planned');
  const bits: string[] = [];
  if (summary) {
    // The deliverable's progress and size: done of the parts not dropped, and their estimates' sum.
    bits.push(summary.total ? `${summary.done}/${summary.total}` : 'all parts dropped');
    if (summary.estimateMin != null) bits.push(`est ${fmtDuration(summary.estimateMin)}`);
    if (summary.unscoped > 0) bits.push(`${summary.unscoped} unscoped`);
  } else if (task.status === 'in_progress') {
    const hasEstimate = task.estimateMin != null;
    bits.push(`${fmtDuration(task.actualAccruedMin)} logged`);
    if (hasEstimate) bits.push(`${fmtDuration(remainingMin(task))} left`);
  } else if (task.estimateMin != null) {
    bits.push(
      `${fmtDuration(task.estimateMin)} est${task.bufferMin ? ` +${fmtDuration(task.bufferMin)}` : ''}`,
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
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
      {/* The deadline phrase stays quiet at every status (no countdown, no aggregate) and shows on
          done/cancelled too, as history. A timed task's urgency is the ROW colour (TaskRow), with the
          same signal spelled out here for a screen reader. */}
      {/* A part's own time is when its block ends; the deadline it answers to is its parent's. */}
      {task.dueDay && (
        <Text size="xs" tone="subtle">
          {fmtDueDay(task.dueDay, today, task.dueTime, parent ? 'ends' : 'due')}
          {!parent && urgency && <span className="sr-only">, {urgency}</span>}
        </Text>
      )}
      {parent && (
        <Text size="xs" tone="muted" className="min-w-0 truncate">
          of {parent.title}
          {parent.dueDay && ` · ${fmtDueDay(parent.dueDay, today, parent.dueTime)}`}
          {urgency && <span className="sr-only">, {urgency}</span>}
        </Text>
      )}
      {task.gcalEventId && (
        <Text size="xs" tone="teal">
          {summary ? 'due marker' : 'on calendar'}
        </Text>
      )}
      {task.gcalSyncError && (
        <Text size="xs" tone="danger">
          calendar sync failed
        </Text>
      )}
      {/* An edit made in Google applied — or was kept out — said out loud until the day rolls over (the
          editor says what). */}
      {isPullFresh(task, settings?.dayStartHour ?? 4, now) && (
        <Text size="xs" tone="gold">
          {task.gcalPulled && isKeptNote(task.gcalPulled.note)
            ? 'kept over Google'
            : 'updated from Google'}
        </Text>
      )}
      <RollTag rollId={task.rollId} />
      {/* Notes: a quiet mark, never a snippet — the text lives in the editor. */}
      {task.notes && (
        <Text size="xs" tone="subtle" className="inline-flex items-center gap-0.5">
          <NoteIcon size={12} />
          {notesHit ? 'in notes' : <span className="sr-only">Has notes</span>}
        </Text>
      )}
      {fileCount > 0 && (
        <Text size="xs" tone="subtle" className="inline-flex items-center gap-0.5">
          <PaperclipIcon size={12} /> {fileCount}
          <span className="sr-only">{fileCount === 1 ? ' file' : ' files'}</span>
        </Text>
      )}
    </div>
  );
}
