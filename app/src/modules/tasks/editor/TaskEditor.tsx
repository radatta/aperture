import { useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { inSplitFamily, splitChildren, todayKey } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { DeltaBar } from '../../../components/DeltaBar';
import { Text } from '../../../components/Text';
import { fmtDateTime, fmtDuration } from '../../../lib/format';
import { useDeleteCalendarEvent, useSyncCalendarEvent } from '../../../data/hooks/useCalendar';
import { usePlansForDay } from '../../../data/hooks/usePlans';
import { useSeries } from '../../../data/hooks/useSeries';
import { useSettings } from '../../../data/hooks/useSettings';
import { useAllTasks } from '../../../data/hooks/useTasks';
import { AttachmentsPanel } from '../AttachmentsPanel';
import { CategoryTag } from '../CategoryTag';
import { DoneForm } from '../DoneForm';
import { remainingMin, ruleSummary, statusLabel } from '../taskMath';
import { AddToCalendarForm } from './AddToCalendarForm';
import { DeleteConfirm, DropConfirm } from './DeleteConfirm';
import { SplitForm } from './SplitForm';
import { TaskDetailsForm } from './TaskDetailsForm';

export type TaskEditorIntent = 'view' | 'finish' | 'scope';
type Reveal = 'split' | 'calendar' | 'drop' | 'delete' | null;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Text size="sm" tone="muted">
        {label}
      </Text>
      <Text size="sm" tabular className="text-right">
        {children}
      </Text>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <Text as="h3" size="sm" weight="semibold" tone="muted">
      {children}
    </Text>
  );
}

// The task modal's body. The title (read-only for now) fixes the truncation; every edit and manage
// action the card used to hold lives here. All gating rules are the card's, moved verbatim.
export function TaskEditor({
  task,
  intent,
  onClose,
  onRequestClose,
  onDirtyChange,
  estimateRef,
  actualRef,
}: {
  task: Task;
  intent: TaskEditorIntent;
  onClose: () => void; // real close — after Mark done / Drop, no guard (Save stays open)
  onRequestClose: () => void; // guarded close — Esc/backdrop/Close button; confirms if dirty
  onDirtyChange: (dirty: boolean) => void;
  estimateRef?: Ref<HTMLInputElement>;
  actualRef?: Ref<HTMLInputElement>;
}) {
  const { data: settings } = useSettings();
  const { data: seriesList = [] } = useSeries();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const { data: plans = [] } = usePlansForDay(today);
  const deleteEvent = useDeleteCalendarEvent();
  const syncEvent = useSyncCalendarEvent();
  const autoCalendar = settings?.autoCalendar !== false && !!settings?.calendarWriteDefault;
  const { data: allTasks = [] } = useAllTasks();
  const [reveal, setReveal] = useState<Reveal>(null);
  // Closing the split reveal (Cancel, or a kept-going split) puts focus back on its opener, never <body>.
  const splitRef = useRef<HTMLButtonElement>(null);
  const closeSplit = () => {
    setReveal(null);
    requestAnimationFrame(() => splitRef.current?.focus());
  };

  const inProgress = task.status === 'in_progress';
  const isDone = task.status === 'done';
  const isTerminal = isDone || task.status === 'cancelled';
  const canScope = task.status === 'backlog' || task.status === 'planned';

  const series = task.seriesId ? seriesList.find((s) => s.id === task.seriesId) : undefined;
  const plannedToday = plans.find((p) => p.taskId === task.id)?.plannedMinutes ?? null;
  const hasEstimate = task.estimateMin != null;

  // "Done" opens the modal here (finish intent) — the actual-minutes capture that closes the task.
  const finish = inProgress ? (
    <section className="flex flex-col gap-2">
      <SectionHeading>Mark done</SectionHeading>
      <DoneForm task={task} actualRef={actualRef} onDone={onClose} />
    </section>
  ) : null;

  const showLogged = task.actualAccruedMin > 0;
  const showRemaining = inProgress && hasEstimate;
  const showLocked = task.estimateLockedMin != null;
  // A split family member isn't measured alone — its lock covers the whole job (split.ts).
  const showDelta = isDone && task.estimateLockedMin != null && !inSplitFamily(task, allTasks);
  const splitFrom = task.splitFromId ? allTasks.find((t) => t.id === task.splitFromId) : undefined;
  const splitInto = splitChildren(allTasks, task.id);
  const timeHasContent =
    !!splitFrom ||
    splitInto.length > 0 ||
    showLogged ||
    showRemaining ||
    showLocked ||
    plannedToday != null ||
    task.startedAt != null ||
    task.completedAt != null ||
    task.cancelledAt != null;

  return (
    <div className="flex flex-col gap-4">
      {/* Header — the status line. The full title is the editable Title field in the details form
          below, which is also where it reads unclipped. */}
      <div className="flex flex-wrap items-center gap-2">
        <Text size="sm" tone="muted">
          {statusLabel(task.status)}
        </Text>
        <CategoryTag categoryId={task.categoryId} />
        {series && (
          <Text size="xs" tone="subtle">
            Recurs · {ruleSummary(series.rule)}
          </Text>
        )}
      </div>

      {intent === 'finish' && finish}

      <TaskDetailsForm task={task} onDirtyChange={onDirtyChange} estimateRef={estimateRef} />

      {intent !== 'finish' && finish}

      {timeHasContent && (
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Time</SectionHeading>
          {showLogged && <Row label="Logged">{fmtDuration(task.actualAccruedMin)}</Row>}
          {showRemaining && <Row label="Remaining">{fmtDuration(remainingMin(task))}</Row>}
          {showLocked && <Row label="Locked estimate">{fmtDuration(task.estimateLockedMin!)}</Row>}
          {plannedToday != null && <Row label="Planned today">{fmtDuration(plannedToday)}</Row>}
          {task.startedAt != null && <Row label="Started">{fmtDateTime(task.startedAt)}</Row>}
          {task.completedAt != null && <Row label="Completed">{fmtDateTime(task.completedAt)}</Row>}
          {task.cancelledAt != null && <Row label="Dropped">{fmtDateTime(task.cancelledAt)}</Row>}
          {splitFrom && <Row label="Split from">{splitFrom.title}</Row>}
          {splitInto.length > 0 && (
            <Row label="Split into">{splitInto.map((t) => t.title).join(', ')}</Row>
          )}
          {showDelta && (
            <DeltaBar
              estimateMin={task.estimateLockedMin!}
              actualMin={task.actualAccruedMin}
              className="mt-1"
            />
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SectionHeading>Files</SectionHeading>
        <AttachmentsPanel taskId={task.id} />
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading>Calendar</SectionHeading>
        {/* A failed auto-sync never fails the task write — it's said here, with a retry. */}
        {/* The retry/add call itself failing (offline, 5xx) is said too — never a dead button. */}
        {syncEvent.isError && (
          <div role="alert">
            <Text size="sm" tone="danger">
              Couldn’t reach the calendar sync — try again.
            </Text>
          </div>
        )}
        {task.gcalSyncError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2">
            <Text size="sm" tone="danger">
              {task.gcalSyncError}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              disabled={syncEvent.isPending}
              onClick={() => syncEvent.mutate(task.id)}
            >
              Retry
            </Button>
          </div>
        )}
        {task.gcalEventId ? (
          <div className="flex items-center justify-between gap-3">
            <Text size="sm" tone="teal">
              On Google Calendar
            </Text>
            <Button variant="quiet" size="sm" onClick={() => deleteEvent.mutate(task.id)}>
              Remove
            </Button>
          </div>
        ) : task.dueDay && task.dueTime && autoCalendar && !isTerminal ? (
          // Timed + auto-sync but no event: timed while sync was off, or its event was removed (by
          // hand or in Google) — one tap creates it, ending at the deadline.
          !task.gcalSyncError && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Text size="sm" tone="muted">
                Not on your calendar.
              </Text>
              <Button
                variant="quiet"
                size="sm"
                disabled={syncEvent.isPending}
                onClick={() => syncEvent.mutate(task.id)}
              >
                Add to calendar
              </Button>
            </div>
          )
        ) : task.dueDay && !isTerminal ? (
          reveal === 'calendar' ? (
            <AddToCalendarForm task={task} onDone={() => setReveal(null)} />
          ) : (
            <Button variant="quiet" size="sm" className="self-start" onClick={() => setReveal('calendar')}>
              Add to calendar…
            </Button>
          )
        ) : !isTerminal ? (
          <Text size="sm" tone="muted">
            Set a due day to add this to your calendar.
          </Text>
        ) : null}
      </section>

      {/* Manage — the lower-frequency, mostly destructive actions. */}
      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {!isTerminal && (
            <Button ref={splitRef} variant="quiet" size="sm" onClick={() => setReveal('split')}>
              Split…
            </Button>
          )}
          {canScope && (
            <Button variant="quiet" size="sm" className="text-danger" onClick={() => setReveal('drop')}>
              Drop task…
            </Button>
          )}
          {task.seriesId === null && (
            <Button
              variant="quiet"
              size="sm"
              className="text-danger"
              onClick={() => setReveal('delete')}
            >
              Delete task…
            </Button>
          )}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onRequestClose}>
            Close
          </Button>
        </div>
        {reveal === 'split' && (
          <SplitForm
            task={task}
            // Done finishes this task, so the modal closes (like Mark done); kept going, it stays open.
            onDone={(finish) => (finish === 'done' ? onClose() : closeSplit())}
            onCancel={closeSplit}
          />
        )}
        {reveal === 'drop' && (
          <DropConfirm task={task} onCancel={() => setReveal(null)} onDone={onClose} />
        )}
        {reveal === 'delete' && <DeleteConfirm task={task} onCancel={() => setReveal(null)} />}
      </section>
    </div>
  );
}
