import { useState } from 'react';
import type { ReactNode } from 'react';
import { canTransitionTask, fmtDueDay, todayKey } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { Menu } from '../../components/Menu';
import type { MenuItem } from '../../components/Menu';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { PaperclipIcon } from '../../components/icons';
import { fmtDuration } from '../../lib/format';
import { useAttachments } from '../../data/hooks/useAttachments';
import { useSettings } from '../../data/hooks/useSettings';
import { useSetActual, useSetDueDay, useSplitTask, useTransitionTask } from '../../data/hooks/useTasks';
import {
  useDeleteCalendarEvent,
  useGoogleCalendars,
  useInsertCalendarEvent,
} from '../../data/hooks/useCalendar';
import { usePomodoro } from '../pomodoro/pomodoro-context';
import { AttachmentsPanel } from './AttachmentsPanel';
import { CategoryTag } from './CategoryTag';
import { ScopePanel } from './ScopePanel';
import { remainingMin } from './taskMath';

type Panel = null | 'scope' | 'split' | 'done' | 'due' | 'calendar' | 'files';

// One task, with the lifecycle actions its status allows. `actions` is an optional slot for
// context-specific buttons (add-to-today / remove-from-plan) supplied by the section.
export function TaskCard({ task, actions }: { task: Task; actions?: ReactNode }) {
  const [panel, setPanel] = useState<Panel>(null);
  const transition = useTransitionTask();
  const deleteEvent = useDeleteCalendarEvent();
  const pomodoro = usePomodoro();
  const canScope = task.status === 'backlog' || task.status === 'planned';
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  // Keep the visible set to the actions you'd actually press — the lifecycle one and its natural
  // partner (plus whatever the section slots in). Everything else folds into the overflow, instead
  // of the old row of four equally-loud buttons per task.
  //
  // Note "Drop": the row action that abandons a task used to be called "Cancel", one row away from
  // the "Cancel" that closes a panel. Same stored status, an unambiguous label.
  const overflow: MenuItem[] = [];
  // Files are welcome at every status — a receipt on a done task, a spec on a backlog one.
  overflow.push({ label: 'Files…', onSelect: () => toggle('files') });
  if (task.status !== 'done' && task.status !== 'cancelled')
    overflow.push({ label: 'Split…', onSelect: () => toggle('split') });
  if (task.status === 'in_progress')
    overflow.push({ label: 'Focus', onSelect: () => pomodoro.startFocus({ taskId: task.id }) });
  // Due date is set in ScopePanel for backlog|planned; in_progress has no scope panel, so it gets its
  // own entry here. Done/cancelled stay display-only.
  if (task.status === 'in_progress')
    overflow.push({ label: 'Due day…', onSelect: () => toggle('due') });
  // Add-to-calendar hangs off a set due day (the event's date). One live event per task; removing it
  // deletes the real calendar event via its owning account.
  if (task.status !== 'done' && task.status !== 'cancelled' && task.dueDay && !task.gcalEventId)
    overflow.push({ label: 'Add to calendar…', onSelect: () => toggle('calendar') });
  if (task.gcalEventId)
    overflow.push({
      label: 'Remove from calendar',
      onSelect: () => deleteEvent.mutate(task.id),
    });
  if (canScope)
    overflow.push({
      label: 'Drop task',
      tone: 'danger',
      onSelect: () => transition.mutate({ id: task.id, to: 'cancelled' }),
    });

  return (
    <Card className="px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Text weight="medium" className="truncate">
            {task.title}
          </Text>
          <TaskMeta task={task} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {canScope && (
            <Button variant="quiet" size="sm" onClick={() => toggle('scope')}>
              {/* "Scope" only when there is genuinely nothing scoped yet. A task that rolled back
                  out of in_progress has a real estimate AND a frozen calibration baseline, so
                  "Scope" would misdescribe it — but "Rescope" would over-promise, since editing
                  can no longer move the frozen number. "Edit" says exactly what it does. */}
              {task.estimateMin == null
                ? 'Scope'
                : task.estimateLockedMin == null
                  ? 'Rescope'
                  : 'Edit'}
            </Button>
          )}
          {canScope && (
            <Button size="sm" onClick={() => transition.mutate({ id: task.id, to: 'in_progress' })}>
              Start
            </Button>
          )}
          {task.status === 'in_progress' && (
            <Button size="sm" onClick={() => toggle('done')}>
              Done
            </Button>
          )}
          {overflow.length > 0 && (
            <Menu items={overflow} label={`More actions for ${task.title}`} />
          )}
        </div>
      </div>

      {panel === 'scope' && <ScopePanel task={task} onDone={() => setPanel(null)} />}
      {panel === 'split' && <SplitForm task={task} onDone={() => setPanel(null)} />}
      {panel === 'done' && <DoneForm task={task} onDone={() => setPanel(null)} />}
      {panel === 'due' && <DueDayForm task={task} onDone={() => setPanel(null)} />}
      {panel === 'calendar' && <AddToCalendarForm task={task} onDone={() => setPanel(null)} />}
      {panel === 'files' && <AttachmentsPanel taskId={task.id} />}
    </Card>
  );
}

// One quiet metadata line. An uncategorized, unestimated task used to print "Uncategorized
// unscoped" — two statements of nothing, on every row, at the weight of real data. Absence is now
// shown by absence; the Scope button already says what's missing.
function TaskMeta({ task }: { task: Task }) {
  const { data: settings } = useSettings();
  const { data: attachments = [] } = useAttachments();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const fileCount = attachments.filter((a) => a.taskId === task.id).length;
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
      {fileCount > 0 && (
        <Text size="xs" tone="subtle" className="inline-flex items-center gap-0.5">
          <PaperclipIcon size={12} /> {fileCount}
        </Text>
      )}
    </div>
  );
}

// Scope change = split. Finish the original (done keeps its partial calibration; cancelled excludes
// it) and spawn a fresh backlog follow-up for the remaining work — the locked estimate is never edited.
function SplitForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const split = useSplitTask();
  const [title, setTitle] = useState(`${task.title} (cont.)`);
  // "Done" is only a legal finish once work has started — the state machine forbids backlog|planned →
  // done. Offering it there threw "Invalid task transition". Gate the option on what's actually legal.
  const canFinishDone = canTransitionTask(task.status, 'done');
  const [finish, setFinish] = useState<'done' | 'cancelled'>(canFinishDone ? 'done' : 'cancelled');
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
        {canFinishDone ? (
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
        ) : (
          // Not-yet-started tasks can only be cancelled (never "done"); no choice to offer.
          <Text size="sm" tone="muted">
            The original will be cancelled.
          </Text>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!title.trim() || split.isPending}
          onClick={async () => {
            try {
              await split.mutateAsync({
                id: task.id,
                finishStatus: finish,
                followUpTitle: title.trim(),
              });
              onDone();
            } catch {
              // Surfaced inline below — swallow so it isn't an unhandled rejection (which leaked the
              // raw error JSON to the page).
            }
          }}
        >
          Split
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {split.isError && (
        <Text size="xs" tone="danger">
          Couldn&apos;t split this task. Please try again.
        </Text>
      )}
    </div>
  );
}

// Due date for an in_progress task — the one status without a ScopePanel. Day-granular, editable
// freely (a moved deadline is not a scope change), clears when the field is emptied.
function DueDayForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const setDueDay = useSetDueDay();
  const [dueDay, setDueDay_] = useState<string>(task.dueDay ?? '');
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Due"
          type="date"
          value={dueDay}
          onChange={(e) => setDueDay_(e.target.value)}
          className="w-40"
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={setDueDay.isPending}
          onClick={async () => {
            await setDueDay.mutateAsync({ id: task.id, dueDay: dueDay || null });
            onDone();
          }}
        >
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Add-to-calendar: pick a calendar (default = the settings write-default), a start time on the due
// day, and a duration. Time feeds the event only — it's never stored on the task (gcal owns the clock).
function AddToCalendarForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const { data: settings } = useSettings();
  const { data: calendars = [] } = useGoogleCalendars((settings?.googleAccounts.length ?? 0) > 0);
  const insert = useInsertCalendarEvent();
  const [time, setTime] = useState('09:00');
  const [durationMin, setDurationMin] = useState<number>(task.estimateMin ?? 30);
  const [calIdx, setCalIdx] = useState<number>(-1);

  if (!task.dueDay) return null;
  if (calendars.length === 0) {
    return (
      <div className="mt-3 rounded-xl border border-line bg-surface p-3">
        <Text size="sm" tone="muted">
          Connect a Google account in Settings first.
        </Text>
      </div>
    );
  }

  const def = settings?.calendarWriteDefault;
  const defaultIdx = def
    ? calendars.findIndex((c) => c.accountSub === def.accountSub && c.calendarId === def.calendarId)
    : -1;
  const idx = calIdx >= 0 ? calIdx : defaultIdx >= 0 ? defaultIdx : 0;

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Calendar"
          value={String(idx)}
          onChange={(e) => setCalIdx(Number(e.target.value))}
          options={calendars.map((c, i) => ({ value: String(i), label: c.summary }))}
          className="w-56"
        />
        <Field
          label="Start"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="w-32"
        />
        <Field
          label="Minutes"
          type="number"
          min={5}
          step={5}
          value={durationMin}
          onChange={(e) => setDurationMin(Number(e.target.value))}
          className="w-28"
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={insert.isPending}
          onClick={async () => {
            const cal = calendars[idx]!;
            const [y, m, d] = task.dueDay!.split('-').map(Number) as [number, number, number];
            const [hh, mm] = time.split(':').map(Number) as [number, number];
            const startMs = new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
            await insert.mutateAsync({
              taskId: task.id,
              accountSub: cal.accountSub,
              calendarId: cal.calendarId,
              title: task.title,
              startMs,
              endMs: startMs + durationMin * 60_000,
            });
            onDone();
          }}
        >
          Add to calendar
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
