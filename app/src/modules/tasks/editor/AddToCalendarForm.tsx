import { useState } from 'react';
import { localEpochFromDayTime } from '@aperture/shared';
import type { Task } from '@aperture/shared';
import { Button } from '../../../components/Button';
import { Field } from '../../../components/Field';
import { Select } from '../../../components/Select';
import { Text } from '../../../components/Text';
import { useGoogleCalendars, useInsertCalendarEvent } from '../../../data/hooks/useCalendar';
import { useSettings } from '../../../data/hooks/useSettings';

// Add-to-calendar: pick a calendar (default = the settings write-default), a start time on the due
// day, and a duration. Time feeds the event only — it's never stored on the task (gcal owns the clock).
export function AddToCalendarForm({ task, onDone }: { task: Task; onDone: () => void }) {
  const { data: settings } = useSettings();
  const { data: calendars = [] } = useGoogleCalendars((settings?.googleAccounts.length ?? 0) > 0);
  const insert = useInsertCalendarEvent();
  const [time, setTime] = useState('09:00');
  const [durationMin, setDurationMin] = useState<number>(task.estimateMin ?? 30);
  const [calIdx, setCalIdx] = useState<number>(-1);

  if (!task.dueDay) return null;
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
            const startMs = localEpochFromDayTime(task.dueDay!, time);
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
