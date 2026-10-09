import { useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import {
  autoSyncOn,
  contributesCalibration,
  fmtDueDay,
  hasKeptPart,
  hasUnsent,
  isPullFresh,
  localEpochFromDayTime,
  parentOf,
  partIndex,
  partsOf,
  partsSummary,
  todayKey,
} from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { DeltaBar } from '../../../components/DeltaBar';
import { Text } from '../../../components/Text';
import { fmtDateTime, fmtDuration } from '../../../lib/format';
import { returnFocus } from '../../../lib/useDisclosure';
import { useNow } from '../../../lib/useNow';
import { useDeleteCalendarEvent, useSyncCalendarEvent } from '../../../data/hooks/useCalendar';
import { usePlansForDay } from '../../../data/hooks/usePlans';
import { useSeries } from '../../../data/hooks/useSeries';
import { useSettings } from '../../../data/hooks/useSettings';
import { useAllTasks, useTransitionTask } from '../../../data/hooks/useTasks';
import { AttachmentsPanel } from '../AttachmentsPanel';
import { CategoryTag } from '../CategoryTag';
import { DoneForm } from '../DoneForm';
import { useOpenTask } from '../task-modal-context';
import { remainingMin, ruleSummary, statusLabel } from '../taskMath';
import { AddToCalendarForm } from './AddToCalendarForm';
import { BreakDownForm } from './BreakDownForm';
import { DeleteConfirm, DropConfirm } from './DeleteConfirm';
import { SplitForm } from './SplitForm';
import { TaskDetailsForm } from './TaskDetailsForm';

export type TaskEditorIntent = 'view' | 'finish' | 'scope';
type Reveal = 'split' | 'parts' | 'calendar' | 'drop' | 'delete' | null;

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
  const now = useNow();
  const today = todayKey(settings?.dayStartHour ?? 4, now);
  const { data: plans = [] } = usePlansForDay(today);
  const deleteEvent = useDeleteCalendarEvent();
  const syncEvent = useSyncCalendarEvent();
  const autoCalendar = autoSyncOn(settings);
  const { data: tasksData } = useAllTasks();
  const allTasks = tasksData ?? [];
  const openTask = useOpenTask();
  const markDone = useTransitionTask();
  const [reveal, setReveal] = useState<Reveal>(null);
  // Parent + parts (parts.ts): a parent's parts, or a part's parent and siblings.
  const parts = partsOf(allTasks, task.id);
  const isParent = parts.length > 0;
  const summary = partsSummary(parts);
  const parent = parentOf(allTasks, task);
  const siblings = parent ? partsOf(allTasks, parent.id) : [];
  // Closing the split reveal (Cancel, or a kept-going split) puts focus back on its opener, never <body>.
  const splitRef = useRef<HTMLButtonElement>(null);
  const closeSplit = () => {
    setReveal(null);
    requestAnimationFrame(() => splitRef.current && returnFocus(splitRef.current));
  };

  const inProgress = task.status === 'in_progress';
  const isDone = task.status === 'done';
  const isTerminal = isDone || task.status === 'cancelled';
  const canScope = task.status === 'backlog' || task.status === 'planned';

  const series = task.seriesId ? seriesList.find((s) => s.id === task.seriesId) : undefined;
  const plannedToday = plans.find((p) => p.taskId === task.id)?.plannedMinutes ?? null;
  const hasEstimate = task.estimateMin != null;

  // "Done" opens the modal here (finish intent) — the actual-minutes capture that closes the task.
  const finish =
    inProgress && !isParent ? (
      <section className="flex flex-col gap-2">
        <SectionHeading>Mark done</SectionHeading>
        <DoneForm task={task} actualRef={actualRef} onDone={onClose} />
      </section>
    ) : null;

  // A parent's logged time is what its parts logged; its own row only holds the done stamp.
  const logged = isParent && !isDone ? summary.actualMin : task.actualAccruedMin;
  const showLogged = logged > 0;
  const showRemaining = inProgress && hasEstimate;
  const showLocked = task.estimateLockedMin != null;
  const showDelta = contributesCalibration(task);
  // A task can become a parent while it hasn't been worked on (its logged time would have nowhere to go —
  // split it instead, which keeps that work as Part 1). One level: never a part.
  const canBreakDown =
    !isTerminal &&
    !isParent &&
    !task.parentId &&
    !inProgress &&
    task.startedAt === null &&
    task.actualAccruedMin === 0;
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
          {isParent && task.status === 'backlog' ? 'Open' : statusLabel(task.status)}
          {isParent && ` · ${summary.done} of ${summary.total} parts`}
        </Text>
        <CategoryTag categoryId={task.categoryId} />
        {parent && (
          <Text size="sm" tone="muted">
            · Part {partIndex(task, siblings)} of {siblings.length} of{' '}
            <button
              type="button"
              className="underline decoration-line underline-offset-2 hover:text-ink"
              onClick={(e) => openTask?.(parent, 'view', e.currentTarget)}
            >
              {parent.title}
            </button>
            {parent.dueDay && ` · ${fmtDueDay(parent.dueDay, today, parent.dueTime)}`}
          </Text>
        )}
        {series && (
          <Text size="xs" tone="subtle">
            Recurs · {ruleSummary(series.rule)}
          </Text>
        )}
      </div>

      {intent === 'finish' && finish}

      <TaskDetailsForm
        task={task}
        parts={isParent ? summary : undefined}
        isPart={!!task.parentId}
        onDirtyChange={onDirtyChange}
        estimateRef={estimateRef}
      />

      {intent !== 'finish' && finish}

      {isParent && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <SectionHeading>
              Parts · {summary.done}/{summary.total}
            </SectionHeading>
            {!isTerminal && reveal !== 'parts' && (
              <Button variant="quiet" size="sm" onClick={() => setReveal('parts')}>
                Add parts…
              </Button>
            )}
          </div>
          {reveal === 'parts' && (
            <BreakDownForm
              task={task}
              isParent
              onDone={() => setReveal(null)}
              onCancel={() => setReveal(null)}
            />
          )}
          <ul className="flex flex-col gap-1">
            {parts.map((p) => (
              <li key={p.id} className="flex items-baseline justify-between gap-3">
                <button
                  type="button"
                  className={`min-w-0 truncate text-left text-sm hover:underline ${
                    p.status === 'cancelled' || p.status === 'done'
                      ? 'text-ink-muted line-through'
                      : 'text-ink'
                  }`}
                  onClick={(e) => openTask?.(p, 'view', e.currentTarget)}
                >
                  {p.title}
                </button>
                <Text size="xs" tone="muted" tabular className="shrink-0">
                  {p.status === 'done'
                    ? `${p.estimateMin != null ? `${fmtDuration(p.estimateMin)} → ` : ''}${fmtDuration(p.actualAccruedMin)}`
                    : p.status === 'cancelled'
                      ? 'dropped'
                      : [
                          p.estimateMin != null ? fmtDuration(p.estimateMin) : null,
                          p.status === 'in_progress' ? 'in progress' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'no estimate'}
                </Text>
              </li>
            ))}
          </ul>
          {!isTerminal && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Text size="sm" tone={summary.allDone ? 'teal' : 'muted'}>
                {summary.allDone
                  ? 'All parts done — mark it submitted?'
                  : 'Mark it done once every part is done or dropped.'}
              </Text>
              <Button
                variant={summary.allDone ? 'primary' : 'quiet'}
                size="sm"
                disabled={markDone.isPending}
                onClick={() =>
                  markDone.mutate({ id: task.id, to: 'done' }, { onSuccess: () => onClose() })
                }
              >
                Mark done
              </Button>
            </div>
          )}
          {markDone.isError && (
            <div role="alert">
              <Text size="sm" tone="danger">
                {markDone.error instanceof Error
                  ? markDone.error.message
                  : 'Couldn’t mark it done — try again.'}
              </Text>
            </div>
          )}
        </section>
      )}

      {timeHasContent && (
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Time</SectionHeading>
          {showLogged && <Row label="Logged">{fmtDuration(logged)}</Row>}
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
        {isParent ? (
          // A parent never owns an event (parts.ts) — the work is on the calendar as its parts' blocks.
          <Text size="sm" tone="muted">
            Its parts carry their own calendar blocks.
          </Text>
        ) : (
          <>
            {/* A failed auto-sync never fails the task write — it's said here, with a retry. */}
            {/* The retry/add call itself failing (offline, 5xx) is said too — never a dead button. */}
            {syncEvent.isError && (
              <div role="alert">
                <Text size="sm" tone="danger">
                  Couldn’t reach the calendar sync — try again.
                </Text>
              </div>
            )}
            {/* What an edit made in Google changed — until the day rolls over (the row shows a mark). When
            Aperture kept its value over Google's, Google still shows its own until the next push: one
            tap sends it (a done task never pushes). */}
            {isPullFresh(task, settings?.dayStartHour ?? 4, now) && task.gcalPulled && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div role="status">
                  <Text size="sm" tone="gold">
                    {task.gcalPulled.note}
                  </Text>
                </div>
                {hasKeptPart(task.gcalPulled.note) &&
                  !isTerminal &&
                  !!settings &&
                  settings.autoCalendar !== false &&
                  !task.gcalSyncError && // Retry shows instead
                  hasUnsent(task, localEpochFromDayTime) && (
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={syncEvent.isPending}
                      onClick={() => syncEvent.mutate(task.id)}
                    >
                      Send to Google
                    </Button>
                  )}
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
              // A timed task gets the picker only once settings say auto-sync can't place its block.
              task.dueTime && !settings ? null : reveal === 'calendar' ? (
                <AddToCalendarForm task={task} onDone={() => setReveal(null)} />
              ) : (
                <Button
                  variant="quiet"
                  size="sm"
                  className="self-start"
                  onClick={() => setReveal('calendar')}
                >
                  Add to calendar…
                </Button>
              )
            ) : !isTerminal ? (
              <Text size="sm" tone="muted">
                {task.parentId
                  ? 'Set when this part ends to add it to your calendar.'
                  : 'Set a due day to add this to your calendar.'}
              </Text>
            ) : null}
          </>
        )}
      </section>

      {/* Manage — the lower-frequency, mostly destructive actions. */}
      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {!isTerminal && !isParent && (
            <Button ref={splitRef} variant="quiet" size="sm" onClick={() => setReveal('split')}>
              Split…
            </Button>
          )}
          {canBreakDown && (
            <Button variant="quiet" size="sm" onClick={() => setReveal('parts')}>
              Break down…
            </Button>
          )}
          {canScope && (
            <Button
              variant="quiet"
              size="sm"
              className="text-danger"
              onClick={() => setReveal('drop')}
            >
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
        {reveal === 'parts' && !isParent && (
          <BreakDownForm
            task={task}
            isParent={false}
            onDone={() => setReveal(null)}
            onCancel={() => setReveal(null)}
          />
        )}
        {reveal === 'split' && (
          <SplitForm
            task={task}
            parentTitle={parent?.title}
            // Done finishes this task, so the modal closes (like Mark done); kept going, it stays open.
            onDone={(finish) => (finish === 'done' ? onClose() : closeSplit())}
            onCancel={closeSplit}
          />
        )}
        {reveal === 'drop' && (
          <DropConfirm
            task={task}
            parts={isParent ? summary : undefined}
            onCancel={() => setReveal(null)}
            onDone={onClose}
          />
        )}
        {reveal === 'delete' && (
          <DeleteConfirm
            task={task}
            parts={isParent ? summary : undefined}
            onCancel={() => setReveal(null)}
          />
        )}
      </section>
    </div>
  );
}
