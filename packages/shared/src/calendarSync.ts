// Calendar auto-sync for timed tasks (docs/areas/calendar/index.md → Auto-sync). A PURE planner over
// (before, after, settings): both ApiClient impls run it after a task write and execute the one action
// it returns — the Lambda against Google, the stub against a fake id — so their decisions can't drift.
//
// The outgoing half of two-way sync (the incoming half, Google → task, is calendarPull.ts). A patch
// sends only what the task has that the event doesn't (against gcalSeen, the event as Aperture last
// knew it), so an Aperture rename can't undo a drag in Google that hasn't been pulled yet — while a
// change that never reached Google (a failed push, or one made with sync off) goes with the next push.
// A done task never pushes; its unsent edits still win a conflict on the pull (calendarPull.ts) and go
// with the next push if one ever happens.
//
// The toggle (settings.autoCalendar) gates ALL of it — off means existing events stay put and nothing
// syncs. Delete-on-cancel is separate (transitionTask) and predates this.

import { syncWindow } from './due';
import type { DueEpoch } from './due';
import { blockTitle } from './parts';
import type { CalendarRef, GcalSeen, Settings, Task } from './types';

// `marker`: the event is a parent's due marker (free, graphite); false on a patch turns one back into a
// block. Absent on a patch = leave how it shows alone.
export type CalendarSyncAction =
  | { kind: 'none' }
  | { kind: 'delete' }
  | {
      kind: 'create';
      target: CalendarRef;
      title: string;
      startMs: number;
      endMs: number;
      marker: boolean;
    }
  | { kind: 'patch'; title?: string; startMs?: number; endMs?: number; marker?: boolean };

// What the caller knows from the task list. `parent` = the task has parts (parts.ts) — its one event is
// the due marker; `parentTitle` = a part's parent, which names its block.
export interface SyncContext {
  ensure?: boolean;
  parent?: boolean;
  parentTitle?: string | null;
}

// Does the event's look need sending? A parent's event shows as its due marker, anything else as a
// block. Compared with the look Aperture last sent (gcalSeen.marker), so a switch that failed or was
// skipped (sync off, finished) heals with the next push. A block never sent a look is left alone — its
// colour may be the user's own.
const lookOff = (seen: GcalSeen | null | undefined, parent: boolean): boolean =>
  parent ? seen?.marker !== true : seen?.marker === true;

// The window a known event lacks. A marker's length is ignored (the pull never maps it), so only its
// end — the deadline — counts.
const windowOff = (
  seen: Pick<GcalSeen, 'startMs' | 'endMs'>,
  w: { startMs: number; endMs: number },
  parent: boolean,
): boolean => seen.endMs !== w.endMs || (!parent && seen.startMs !== w.startMs);

type SyncFields = Pick<
  Task,
  'title' | 'status' | 'dueDay' | 'dueTime' | 'estimateMin' | 'gcalEventId'
> &
  Partial<Pick<Task, 'gcalSyncError' | 'gcalSeen'>>;

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

// Auto-sync can place blocks: on, with a calendar to write to. A timed task's block is then its auto
// block, at its deadline — no picked time (the editor's picker and insertCalendarEvent both check this).
export const autoSyncOn = (
  s: Pick<Settings, 'autoCalendar' | 'calendarWriteDefault'> | null | undefined,
): boolean => s?.autoCalendar !== false && !!s?.calendarWriteDefault;
export const AUTO_PLACED_ERROR =
  'Auto-sync places this task’s calendar block at its deadline — change its due time instead, or turn auto-sync off to pick a time.';

// Does a linked task hold a change its event doesn't have yet (a failed, skipped or kept-out one)? What
// the next push would send — the same comparison as calendarSyncPlan's known-event branch.
export const hasUnsent = (
  t: SyncFields,
  epoch: DueEpoch,
  ctx: Pick<SyncContext, 'parent' | 'parentTitle'> = {},
): boolean => {
  const seen = t.gcalSeen;
  const parent = !!ctx.parent;
  if (!t.gcalEventId || !seen) return false;
  if (!sameTitle(seen.title, blockTitle(t, ctx.parentTitle))) return true;
  const w = syncWindow(t, epoch, parent);
  if (w && lookOff(seen, parent)) return true;
  return !!w && seen.startMs !== null && windowOff(seen, w, parent);
};

// Titles compare trim-insensitively both ways (an untrimmed title from an older client isn't a change).
export const sameTitle = (a: string | null, b: string | null): boolean =>
  (a ?? '').trim() === (b ?? '').trim();

// Did a write change anything the event mirrors? (`?? null`: an older row's undefined equals null.)
export const syncedFieldsChanged = (
  prev: Pick<Task, 'title' | 'dueDay' | 'dueTime' | 'estimateMin'>,
  next: Pick<Task, 'title' | 'dueDay' | 'dueTime' | 'estimateMin'>,
): boolean =>
  (['title', 'dueDay', 'dueTime', 'estimateMin'] as const).some(
    (k) => (prev[k] ?? null) !== (next[k] ?? null),
  );

// The event as Aperture knows it after a create/patch succeeds — the next gcalSeen, versioned by the
// `updated` Google returned for it.
export function seenAfter(
  action: Extract<CalendarSyncAction, { kind: 'create' | 'patch' }>,
  prev: GcalSeen | null | undefined,
  updatedMs: number,
): GcalSeen {
  return {
    title: action.title ?? prev?.title ?? null,
    startMs: action.startMs ?? prev?.startMs ?? null,
    endMs: action.endMs ?? prev?.endMs ?? null,
    updatedMs,
    ...((action.marker ?? prev?.marker) !== undefined && { marker: action.marker ?? prev?.marker }),
  };
}

// `prev` null = a fresh create; `ensure` = the explicit retry (sync to the task as it is now). A parent's
// event is its due marker (MARKER_MIN, ending at the deadline); a part's block is named after its parent.
export function calendarSyncPlan(
  prev: SyncFields | null,
  next: SyncFields,
  settings: Pick<Settings, 'autoCalendar' | 'calendarWriteDefault'>,
  epoch: DueEpoch,
  opts: SyncContext = {},
): CalendarSyncAction {
  const parent = !!opts.parent;
  const window = syncWindow(next, epoch, parent);
  // Old settings rows read back undefined → on (the default).
  // A removal already owed (it failed earlier) is carried out on the next sync whatever else holds —
  // finished, or sync turned off since: the user asked for it while sync was on.
  if (next.gcalEventId && isPendingRemoval(next.gcalSyncError) && !window)
    return { kind: 'delete' };
  // A parent's one event is its marker, which needs a time — an untimed parent's event (a manual block
  // from before it had parts) goes, whatever the toggle says (like delete-on-cancel).
  if (parent && !window) return next.gcalEventId ? { kind: 'delete' } : NONE;
  if (settings.autoCalendar === false) return NONE;
  if (next.status === 'done' || next.status === 'cancelled') return NONE;
  const ensure = !!opts.ensure;
  const title = blockTitle(next, opts.parentTitle);
  // `?? null` so an older row's undefined equals null (and an estimate of 0 stays distinct from none).
  const changed = (k: keyof SyncFields) => prev === null || (prev[k] ?? null) !== (next[k] ?? null);
  const whenChanged = changed('dueDay') || changed('dueTime');

  if (next.gcalEventId) {
    const wasTimed = !!prev?.dueDay && !!prev.dueTime;
    if (!window) {
      // Lost its time → the event it auto-synced goes. An untimed task with a manual event: gcal owns
      // that clock, so only a rename reaches it.
      if (wasTimed) return { kind: 'delete' };
      return ensure ||
        changed('title') ||
        (!!next.gcalSeen && !sameTitle(next.gcalSeen.title, title))
        ? { kind: 'patch', title }
        : NONE;
    }
    // ensure (the retry) sends everything. The window moves as one block.
    const seen = next.gcalSeen;
    let retime: boolean;
    let retitle: boolean;
    const relook = lookOff(seen, parent);
    if (seen) {
      // Send whatever the event doesn't have yet — a timed task's one block is its auto block, whatever
      // placed it, so a block off the deadline moves there. A window not known (first seen all-day)
      // moves only when the task's own time does.
      retime =
        ensure ||
        (seen.startMs === null
          ? whenChanged || changed('estimateMin')
          : windowOff(seen, window, parent));
      retitle = ensure || !sameTitle(seen.title, title);
    } else {
      // Not known yet (linked before two-way sync): any change sends everything, once — after which the
      // event is known.
      // A look to send counts as a change too, so the patch leaves a whole base behind.
      retime = retitle =
        ensure || whenChanged || changed('estimateMin') || changed('title') || !wasTimed || relook;
    }
    if (!retime && !retitle && !relook) return NONE;
    return {
      kind: 'patch',
      ...(retitle && { title }),
      ...(retime && window),
      ...(relook && { marker: parent }),
    };
  }

  // Unlinked: only a timed task gets an event, and only when its time is new or moved (a rename alone
  // never resurrects an event you removed by hand).
  if (!window || !settings.calendarWriteDefault) return NONE;
  if (!ensure && !whenChanged) return NONE;
  const target = settings.calendarWriteDefault;
  return { kind: 'create', target, title, ...window, marker: parent };
}
