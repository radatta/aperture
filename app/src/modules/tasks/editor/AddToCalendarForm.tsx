import { useState } from 'react';
import {
  blockStartBefore,
  blockTitle,
  DEFAULT_EVENT_MIN,
  fmtClock12,
  localEpochFromDayTime,
  timeKeyOfInput,
} from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { Select } from '../../../components/Select';
import { LoadError } from '../../../components/LoadError';
import { Text } from '../../../components/Text';
import { useGoogleCalendars, useInsertCalendarEvent } from '../../../data/hooks/useCalendar';
import { useSettings } from '../../../data/hooks/useSettings';

// Add-to-calendar (the manual path — timed tasks with auto-sync on get theirs automatically): pick a
// calendar (default = the settings write-default), a start time on the due day, and a duration. A task
// with a due time prefills the block that ENDS at the deadline; the picked start feeds the event only.
// A part's block is named after its parent ("P2 · Part 1"), as an auto-synced one is.
export function AddToCalendarForm({
  task,
  parentTitle,
  onDone,
}: {
  task: Task;
  parentTitle?: string | null;
  onDone: () => void;
}) {
  const { data: settings } = useSettings();
  const calendarsQ = useGoogleCalendars((settings?.googleAccounts.length ?? 0) > 0);
  const { data: calendars = [] } = calendarsQ;
  const insert = useInsertCalendarEvent();
  const [durationMin, setDurationMin] = useState<number>(task.estimateMin ?? DEFAULT_EVENT_MIN);
  // With a due time the start follows the duration (so the block keeps ending at the deadline) until
  // you pick a start yourself.
  const [pickedTime, setTime] = useState<string | null>(null);
  const time =
    pickedTime ??
    (task.dueDay && task.dueTime
      ? blockStartBefore(task.dueDay, task.dueTime, durationMin)
      : '09:00');

  const [calIdx, setCalIdx] = useState<number>(-1);
  // A cleared Start or Minutes would send a NaN or zero-length block — said, never sent.
  const canAdd = !!time && durationMin > 0;

  if (!task.dueDay) return null;
  // Never "connect an account" for a read that failed while one is connected.
  if (calendarsQ.isError && calendarsQ.data === undefined)
    return (
      <div className="rounded-xl border border-line bg-surface p-3">
        <LoadError onRetry={() => void calendarsQ.refetch()}>
          Couldn’t load your calendars.
        </LoadError>
      </div>
    );
  if (calendars.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface p-3">
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
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
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
          onChange={(e) => setTime(timeKeyOfInput(e.target.value))}
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
      {task.dueTime && (
        <Text size="xs" tone="muted">
          Due at {fmtClock12(task.dueTime)} — the block ends there.
        </Text>
      )}
      {!canAdd && (
        <Text size="xs" tone="muted">
          Pick a start time and a length first.
        </Text>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={insert.isPending || !canAdd}
          onClick={async () => {
            const cal = calendars[idx]!;
            const startMs = localEpochFromDayTime(task.dueDay!, time);
            try {
              await insert.mutateAsync({
                taskId: task.id,
                accountSub: cal.accountSub,
                calendarId: cal.calendarId,
                title: blockTitle(task, parentTitle),
                startMs,
                endMs: startMs + durationMin * 60_000,
              });
              onDone();
            } catch {
              // Shown below; the form stays open with what you picked.
            }
          }}
        >
          Add to calendar
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {insert.isError && (
        <div role="alert">
          <Text size="xs" tone="danger">
            Couldn’t add it to your calendar
            {insert.error instanceof Error ? `: ${insert.error.message}` : '.'}
          </Text>
        </div>
      )}
    </div>
  );
}
