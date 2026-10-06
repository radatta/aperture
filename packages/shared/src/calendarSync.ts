// Calendar auto-sync for timed tasks (docs/areas/calendar/index.md → Auto-sync). A PURE planner over
// (before, after, settings): both ApiClient impls run it after a task write and execute the one action
// it returns — the Lambda against Google, the stub against a fake id — so their decisions can't drift.
//
// The outgoing half of two-way sync (the incoming half, Google → task, is calendarPull.ts). A patch
// sends only what changed, so an Aperture rename can't undo a drag in Google that hasn't been pulled
// yet. The toggle (settings.autoCalendar) gates ALL of it — off means existing events stay put and
// nothing syncs. Delete-on-cancel is separate (transitionTask) and predates this.

import { eventWindow } from './due';
import type { DueEpoch } from './due';
import type { CalendarRef, Settings, Task } from './types';

export type CalendarSyncAction =
  | { kind: 'none' }
  | { kind: 'delete' }
  | { kind: 'create'; target: CalendarRef; title: string; startMs: number; endMs: number }
  | { kind: 'patch'; title?: string; startMs?: number; endMs?: number };

type SyncFields = Pick<
  Task,
  'title' | 'status' | 'dueDay' | 'dueTime' | 'estimateMin' | 'gcalEventId'
> &
  Partial<Pick<Task, 'gcalSyncError'>>;

const NONE: CalendarSyncAction = { kind: 'none' };

// The failure note stored on the task (gcalSyncError). A failed REMOVE keeps the event linked, and its
// note is what marks it as still owed a removal (an untimed linked task could otherwise be a manual
// event that should stay) — every later sync, not just the retry, finishes the removal.
const FAILED: Record<'create' | 'patch' | 'delete', string> = {
  create: 'Couldn’t add the calendar event',
  patch: 'Couldn’t update the calendar event',
  delete: 'Couldn’t remove the calendar event',
};
export const gcalSyncMessage = (kind: 'create' | 'patch' | 'delete', detail: string): string =>
  `${FAILED[kind]} (${detail})`;
export const isPendingRemoval = (gcalSyncError: string | null | undefined): boolean =>
  !!gcalSyncError?.startsWith(FAILED.delete);

// `prev` null = a fresh create; `ensure` = the explicit retry (sync to the task as it is now).
export function calendarSyncPlan(
  prev: SyncFields | null,
  next: SyncFields,
  settings: Pick<Settings, 'autoCalendar' | 'calendarWriteDefault'>,
  epoch: DueEpoch,
  opts: { ensure?: boolean } = {},
): CalendarSyncAction {
  // Old settings rows read back undefined → on (the default).
  // A removal already owed (it failed earlier) is carried out on the next sync whatever else holds —
  // finished, or sync turned off since: the user asked for it while sync was on.
  if (next.gcalEventId && isPendingRemoval(next.gcalSyncError) && !eventWindow(next, epoch))
    return { kind: 'delete' };
  if (settings.autoCalendar === false) return NONE;
  if (next.status === 'done' || next.status === 'cancelled') return NONE;
  const ensure = !!opts.ensure;
  const window = eventWindow(next, epoch);
  // `?? null` so an older row's undefined equals null (and an estimate of 0 stays distinct from none).
  const changed = (k: keyof SyncFields) => prev === null || (prev[k] ?? null) !== (next[k] ?? null);
  const whenChanged = changed('dueDay') || changed('dueTime');

  if (next.gcalEventId) {
    const wasTimed = !!prev?.dueDay && !!prev.dueTime;
    if (!window) {
      // Lost its time → the event it auto-synced goes. An untimed task with a manual event: gcal owns
      // that clock, so only a rename reaches it.
      if (wasTimed) return { kind: 'delete' };
      return ensure || changed('title') ? { kind: 'patch', title: next.title } : NONE;
    }
    // Changed fields only (ensure = the retry sends everything). The window moves as one block; a
    // manual event moves too when its task first gains a time.
    const retime = ensure || whenChanged || changed('estimateMin') || !wasTimed;
    const retitle = ensure || changed('title');
    if (!retime && !retitle) return NONE;
    return { kind: 'patch', ...(retitle && { title: next.title }), ...(retime && window) };
  }

  // Unlinked: only a timed task gets an event, and only when its time is new or moved (a rename alone
  // never resurrects an event you removed by hand).
  if (!window || !settings.calendarWriteDefault) return NONE;
  if (!ensure && !whenChanged) return NONE;
  return { kind: 'create', target: settings.calendarWriteDefault, title: next.title, ...window };
}
