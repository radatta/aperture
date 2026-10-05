// Calendar auto-sync for timed tasks (docs/areas/calendar/index.md → Auto-sync). A PURE planner over
// (before, after, settings): both ApiClient impls run it after a task write and execute the one action
// it returns — the Lambda against Google, the stub against a fake id — so their decisions can't drift.
//
// One-way: the task is the source of record; an event edited in Google is overwritten by the next task
// change. The toggle (settings.autoCalendar) gates ALL of it — off means existing events stay put and
// nothing syncs. Delete-on-cancel is separate (transitionTask) and predates this.

import { eventWindow } from './due';
import type { DueEpoch } from './due';
import type { CalendarRef, Settings, Task } from './types';

export type CalendarSyncAction =
  | { kind: 'none' }
  | { kind: 'delete' }
  | { kind: 'create'; target: CalendarRef; title: string; startMs: number; endMs: number }
  | { kind: 'patch'; title: string; startMs?: number; endMs?: number };

type SyncFields = Pick<
  Task,
  'title' | 'status' | 'dueDay' | 'dueTime' | 'estimateMin' | 'gcalEventId'
>;

const NONE: CalendarSyncAction = { kind: 'none' };

// `prev` null = a fresh create; `ensure` = the explicit retry (sync to the task as it is now).
export function calendarSyncPlan(
  prev: SyncFields | null,
  next: SyncFields,
  settings: Pick<Settings, 'autoCalendar' | 'calendarWriteDefault'>,
  epoch: DueEpoch,
  opts: { ensure?: boolean } = {},
): CalendarSyncAction {
  // Old settings rows read back undefined → on (the default).
  if (settings.autoCalendar === false) return NONE;
  if (next.status === 'done' || next.status === 'cancelled') return NONE;
  const ensure = !!opts.ensure;
  const window = eventWindow(next, epoch);
  const changed = (k: keyof SyncFields) => prev === null || (prev[k] || null) !== (next[k] || null);
  const whenChanged = changed('dueDay') || changed('dueTime');

  if (next.gcalEventId) {
    const wasTimed = !!prev?.dueDay && !!prev.dueTime;
    if (!window) {
      // Lost its time → the event it auto-synced goes. An untimed task with a manual event: gcal owns
      // that clock, so only a rename reaches it.
      if (wasTimed) return { kind: 'delete' };
      return ensure || changed('title') ? { kind: 'patch', title: next.title } : NONE;
    }
    if (ensure || whenChanged || changed('estimateMin') || changed('title'))
      return { kind: 'patch', title: next.title, ...window };
    return NONE;
  }

  // Unlinked: only a timed task gets an event, and only when its time is new or moved (a rename alone
  // never resurrects an event you removed by hand).
  if (!window || !settings.calendarWriteDefault) return NONE;
  if (!ensure && !whenChanged) return NONE;
  return { kind: 'create', target: settings.calendarWriteDefault, title: next.title, ...window };
}
