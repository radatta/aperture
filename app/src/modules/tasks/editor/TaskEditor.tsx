import { useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { todayKey } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { DeltaBar } from '../../../components/DeltaBar';
import { Text } from '../../../components/Text';
import { fmtDateTime, fmtDuration } from '../../../lib/format';
import { useDeleteCalendarEvent } from '../../../data/hooks/useCalendar';
import { usePlansForDay } from '../../../data/hooks/usePlans';
import { useSeries } from '../../../data/hooks/useSeries';
import { useSettings } from '../../../data/hooks/useSettings';
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
  const [reveal, setReveal] = useState<Reveal>(null);

  const inProgress = task.status === 'in_progress';
  const isDone = task.status === 'done';
  const isTerminal = isDone || task.status === 'cancelled';
  const canScope = task.status === 'backlog' || task.status === 'planned';

  const series = task.seriesId ? seriesList.find((s) => s.id === task.seriesId) : undefined;
  const plannedToday = plans.find((p) => p.taskId === task.id)?.plannedMinutes ?? null;
  const hasEstimate = task.estimateLockedMin != null || task.estimateMin != null;

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
  const showDelta = isDone && task.estimateLockedMin != null;
  const timeHasContent =
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
        {task.gcalEventId ? (
          <div className="flex items-center justify-between gap-3">
            <Text size="sm" tone="teal">
              On Google Calendar
            </Text>
            <Button variant="quiet" size="sm" onClick={() => deleteEvent.mutate(task.id)}>
              Remove
            </Button>
          </div>
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
            <Button variant="quiet" size="sm" onClick={() => setReveal('split')}>
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
        {reveal === 'split' && <SplitForm task={task} onDone={() => setReveal(null)} />}
        {reveal === 'drop' && (
          <DropConfirm task={task} onCancel={() => setReveal(null)} onDone={onClose} />
        )}
        {reveal === 'delete' && <DeleteConfirm task={task} onCancel={() => setReveal(null)} />}
      </section>
    </div>
  );
}
