import { useEffect, useRef, useState } from 'react';
import type { ReactNode, Ref, RefObject } from 'react';
import {
  autoSyncOn,
  canBecomeParent,
  canSplit,
  contributesCalibration,
  fmtDueDay,
  hasKeptPart,
  hasUnsent,
  isPullFresh,
  isTimed,
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
import { cx } from '../../../lib/cx';
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
import type { EditSlots } from './editState';

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

// The task modal's body. The full title (editable, in the details form) fixes the truncation; every edit
// and manage action the card used to hold lives here. All gating rules are the card's, moved verbatim.
export function TaskEditor({
  task,
  intent,
  edits,
  onFinished,
  onRequestClose,
  onLeaveReveal,
  estimateRef,
  actualRef,
}: {
  task: Task;
  intent: TaskEditorIntent;
  edits?: EditSlots; // where each form's edits stand, read by the modal's guard
  // Finished here (Mark done, Drop, a done split), as the write returned it: the modal closes, guarded.
  // `here` is false when this editor has gone by the time the write lands (closed or switched away).
  onFinished: (task: Task, here: boolean) => void;
  onRequestClose: () => void; // guarded close — Esc/backdrop/Close button; confirms if dirty
  onLeaveReveal: (go: () => void) => void; // the guard for the open reveal's text alone
  estimateRef?: Ref<HTMLInputElement>;
  actualRef?: Ref<HTMLInputElement>;
}) {
  const { data: settings } = useSettings();
  const { data: seriesList = [] } = useSeries();
  const now = useNow();
  const dayStartHour = settings?.dayStartHour ?? 4;
  const today = todayKey(dayStartHour, now);
  const { data: plans = [] } = usePlansForDay(today);
  const deleteEvent = useDeleteCalendarEvent();
  const syncEvent = useSyncCalendarEvent();
  const autoCalendar = autoSyncOn(settings);
  const { data: tasksData } = useAllTasks();
  const allTasks = tasksData ?? [];
  const openTask = useOpenTask();
  const markDone = useTransitionTask();
  // The refusal ("Part 2 isn't finished…") renders under the button, below a phone's fold — bring it into
  // view each time one lands, or the tap reads as doing nothing.
  const markDoneErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (markDone.error) markDoneErrorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [markDone.error]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const finished = (done: Task) => onFinished(done, mounted.current);
  // The parent's Mark done: one per tap, set before the await (isPending arrives a tick late), and its
  // close from the write's answer, not a per-call onSuccess a second tap would drop.
  const [marking, setMarking] = useState(false);
  async function markParentDone() {
    if (marking) return;
    setMarking(true);
    try {
      finished(await markDone.mutateAsync({ id: task.id, to: 'done' }));
    } catch {
      // Said below.
    } finally {
      setMarking(false);
    }
  }
  const [reveal, setReveal] = useState<Reveal>(null);
  // Another section while the open reveal holds unsent text (part lines, split titles) asks first, via
  // the modal's confirm; a write in flight is waited for. The details form stays mounted — its edits
  // never prompt here.
  const openReveal = (r: Reveal) => {
    if (r !== reveal) onLeaveReveal(() => setReveal(r));
  };
  // Parent + parts (parts.ts): a parent's parts, or a part's parent and siblings.
  const parts = partsOf(allTasks, task.id);
  const isParent = parts.length > 0;
  const summary = partsSummary(parts);
  const parent = parentOf(allTasks, task);
  // "Part 2 of 3" counts the parts not dropped (as the parent’s own "1 of 3 parts" does).
  const siblings = parent
    ? partsOf(allTasks, parent.id).filter((p) => p.status !== 'cancelled')
    : [];
  // Closing Break down / Add parts, or the split reveal (Cancel, or a kept-going split), puts focus back
  // on its opener (whichever shows by then), never <body> — from an effect, once the form has left: a
  // frame callback can run before React's commit on an async close (after the send's await), find focus
  // still inside the form, and let the unmount drop it to <body>. Never overrides focus that already
  // went somewhere: a swap held for the send opens another section, whose own field takes it next.
  const [refocus, setRefocus] = useState<RefObject<HTMLButtonElement | null> | null>(null);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    const at = document.activeElement;
    if (refocus.current && (!at || at === document.body || at.tagName === 'DIALOG'))
      returnFocus(refocus.current);
  }, [refocus]);
  const partsRef = useRef<HTMLButtonElement>(null);
  const closeParts = () => {
    setReveal(null);
    setRefocus(partsRef);
  };
  const splitRef = useRef<HTMLButtonElement>(null);
  const closeSplit = () => {
    setReveal(null);
    setRefocus(splitRef);
  };

  const inProgress = task.status === 'in_progress';
  const isDone = task.status === 'done';
  const isTerminal = isDone || task.status === 'cancelled';
  const canScope = task.status === 'backlog' || task.status === 'planned';

  const series = task.seriesId ? seriesList.find((s) => s.id === task.seriesId) : undefined;
  // A timed task's row is history (its day is its time, lenses.md D13): nothing planned to show.
  const plannedToday = isTimed(task)
    ? null
    : (plans.find((p) => p.taskId === task.id)?.plannedMinutes ?? null);
  const hasEstimate = task.estimateMin != null;

  // "Done" opens the modal here (finish intent) — the actual-minutes capture that closes the task.
  const finish =
    inProgress && !isParent ? (
      <section className="flex flex-col gap-2">
        <SectionHeading>Mark done</SectionHeading>
        <DoneForm task={task} actualRef={actualRef} onDone={finished} onCancel={onRequestClose} />
      </section>
    ) : null;

  // A parent's logged time is what its parts logged; its own row only holds the done stamp.
  const logged = isParent && !isDone ? summary.actualMin : task.actualAccruedMin;
  const showLogged = logged > 0;
  const showRemaining = inProgress && hasEstimate;
  const showLocked = task.estimateLockedMin != null;
  const showDelta = contributesCalibration(task);
  // parts.ts canBecomeParent: never worked on, not a part, not a roll rep or a recurring occurrence.
  const canBreakDown = !isParent && canBecomeParent(task);
  // split.ts canSplit: open, not a roll rep or a recurring occurrence — and a parent takes a part instead.
  const showSplit = !isParent && canSplit(task);
  const timeHasContent =
    showLogged ||
    showRemaining ||
    showLocked ||
    plannedToday != null ||
    task.startedAt != null ||
    task.completedAt != null ||
    task.cancelledAt != null;

  const showCalendar =
    !isTerminal ||
    !!task.gcalEventId ||
    !!task.gcalSyncError ||
    syncEvent.isError ||
    (isPullFresh(task, settings?.dayStartHour ?? 4, now) && !!task.gcalPulled);

  const parentLink = parent && (
    <button
      type="button"
      className="underline decoration-line underline-offset-2 hover:text-ink"
      onClick={(e) => openTask?.(parent, 'view', e.currentTarget)}
    >
      {parent.title}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Header — the status line. The full title is the editable Title field in the details form
          below, which is also where it reads unclipped. */}
      <div className="flex flex-wrap items-center gap-2">
        <Text size="sm" tone="muted">
          {isParent && task.status === 'backlog' ? 'Open' : statusLabel(task.status)}
          {isParent &&
            ` · ${summary.done} of ${summary.total} ${summary.total === 1 ? 'part' : 'parts'}`}
          {/* A dropped part no longer counts among its parent's parts, so it has no "Part 2 of 2". */}
          {parentLink && task.status === 'cancelled' && <> · part of {parentLink}</>}
        </Text>
        <CategoryTag categoryId={task.categoryId} />
        {parentLink && task.status !== 'cancelled' && (
          <Text size="sm" tone="muted">
            Part {partIndex(task, siblings)} of {siblings.length} of {parentLink}
          </Text>
        )}
        {parent?.dueDay && (
          <Text size="sm" tone="muted">
            {fmtDueDay(parent.dueDay, today, parent.dueTime, { dayStartHour })}
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
        parent={parent}
        edits={edits}
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
              <Button ref={partsRef} variant="quiet" size="sm" onClick={() => openReveal('parts')}>
                Add parts…
              </Button>
            )}
          </div>
          {reveal === 'parts' && !isTerminal && (
            <BreakDownForm
              task={task}
              isParent
              onDone={closeParts}
              onCancel={closeParts}
              edits={edits}
            />
          )}
          <ul className="flex flex-col gap-1">
            {parts.map((p) => (
              <li key={p.id} className="flex items-baseline justify-between gap-3">
                <button
                  type="button"
                  className={cx(
                    'min-w-0 truncate text-left text-sm hover:underline',
                    p.status === 'cancelled' || p.status === 'done'
                      ? 'text-ink-muted line-through'
                      : 'text-ink',
                  )}
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
          {/* Every part dropped: nothing to submit, so it's dropped too (parts.ts) — no Mark done. */}
          {!isTerminal && summary.total === 0 && (
            <Text size="sm" tone="muted">
              Every part was dropped — drop this too (Drop task… below).
            </Text>
          )}
          {!isTerminal && summary.total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Text size="sm" tone={summary.allDone ? 'teal' : 'muted'}>
                {summary.allDone
                  ? 'All parts done — mark it submitted?'
                  : 'Mark it done once every part is done or dropped.'}
              </Text>
              <Button
                variant={summary.allDone ? 'primary' : 'quiet'}
                size="sm"
                onClick={markParentDone}
                aria-disabled={marking}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                Mark done
              </Button>
            </div>
          )}
          {markDone.isError && (
            <div ref={markDoneErrorRef} role="alert">
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

      {/* A finished task with no event and nothing to say has no Calendar section (no bare heading). */}
      <section className={cx('flex flex-col gap-2', !showCalendar && 'hidden')}>
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
              hasUnsent(task, localEpochFromDayTime, {
                parent: isParent,
                parentTitle: parent?.title,
              }) && (
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
        {task.gcalEventId ? (
          // A parent's one event is its due marker (parts.ts): 15 minutes, free, ending at its deadline.
          <div className="flex items-center justify-between gap-3">
            <Text size="sm" tone="teal">
              {isParent ? 'Due marker on Google Calendar' : 'On Google Calendar'}
            </Text>
            <Button variant="quiet" size="sm" onClick={() => deleteEvent.mutate(task.id)}>
              Remove
            </Button>
          </div>
        ) : task.dueDay && task.dueTime && autoCalendar && !isTerminal ? (
          // Timed + auto-sync but no event: timed while sync was off, or its event was removed (by
          // hand or in Google) — one tap creates it, ending at the deadline.
          !task.gcalSyncError && (
            <div className="flex items-center justify-between gap-3">
              <Text size="sm" tone="muted" className="min-w-0">
                {isParent ? 'No due marker on your calendar.' : 'Not on your calendar.'}
              </Text>
              <Button
                variant="quiet"
                size="sm"
                className="shrink-0"
                disabled={syncEvent.isPending}
                onClick={() => syncEvent.mutate(task.id)}
              >
                {isParent ? 'Add due marker' : 'Add to calendar'}
              </Button>
            </div>
          )
        ) : isParent ? (
          // No picked time for a parent: its marker goes where its deadline is, with auto-sync on. Nothing
          // until settings load, so a timed parent never flashes "Connect Google Calendar…".
          !isTerminal &&
          !!settings && (
            <Text size="sm" tone="muted">
              {!task.dueTime
                ? 'Set a due time to put its deadline on your calendar.'
                : settings?.calendarWriteDefault
                  ? 'Its due marker goes on your calendar while auto-sync is on.'
                  : 'Connect Google Calendar in Settings to put its deadline there.'}
            </Text>
          )
        ) : task.dueDay && !isTerminal ? (
          // A timed task gets the picker only once settings say auto-sync can't place its block.
          task.dueTime && !settings ? null : reveal === 'calendar' ? (
            <AddToCalendarForm
              task={task}
              parentTitle={parent?.title}
              onDone={() => setReveal(null)}
            />
          ) : (
            <Button
              variant="quiet"
              size="sm"
              className="self-start"
              onClick={() => openReveal('calendar')}
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
      </section>

      {/* Manage — the lower-frequency, mostly destructive actions. */}
      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {showSplit && (
            <Button ref={splitRef} variant="quiet" size="sm" onClick={() => openReveal('split')}>
              Split…
            </Button>
          )}
          {canBreakDown && (
            <Button ref={partsRef} variant="quiet" size="sm" onClick={() => openReveal('parts')}>
              Break down…
            </Button>
          )}
          {canScope && (
            <Button
              variant="quiet"
              size="sm"
              className="text-danger"
              onClick={() => openReveal('drop')}
            >
              Drop task…
            </Button>
          )}
          {task.seriesId === null && (
            <Button
              variant="quiet"
              size="sm"
              className="text-danger"
              onClick={() => openReveal('delete')}
            >
              Delete task…
            </Button>
          )}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onRequestClose}>
            Close
          </Button>
        </div>
        {reveal === 'parts' && canBreakDown && (
          <BreakDownForm
            task={task}
            isParent={false}
            onDone={closeParts}
            onCancel={closeParts}
            edits={edits}
          />
        )}
        {reveal === 'split' && showSplit && (
          <SplitForm
            task={task}
            parentTitle={parent?.title}
            // Done finishes this task, so the modal closes (like Mark done); kept going, it stays open.
            onDone={(finish, original) => (finish === 'done' ? finished(original) : closeSplit())}
            onCancel={closeSplit}
            edits={edits}
          />
        )}
        {reveal === 'drop' && canScope && (
          <DropConfirm
            task={task}
            parts={isParent ? summary : undefined}
            onCancel={() => setReveal(null)}
            onDone={finished}
          />
        )}
        {reveal === 'delete' && task.seriesId === null && (
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
