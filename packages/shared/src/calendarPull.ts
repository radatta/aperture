// Calendar two-way sync, the incoming half (docs/areas/calendar/index.md → Two-way sync). A PURE planner
// over (task, the event as Google now has it): both ApiClient impls run it per changed event in a pull
// and write the one action it returns — the Lambda over an events.list delta, the stub over its dev
// queue — so their decisions can't drift. The outgoing half is calendarSync.ts.
//
// Only events Aperture created are ever matched (by the task's stored pointer); everything else in the
// delta is dropped untouched by the caller.

import { dayKey, fmtClock12, fmtDuration, fmtMonthShortDay, todayKey } from './dates';
import { eventLengthMin, eventWindow } from './due';
import type { DueClock, DueEpoch } from './due';
import { isPendingRemoval, sameTitle } from './calendarSync';
import type { GcalSeen, Task } from './types';

// One changed event from the delta, normalised by the gateway.
export interface PulledEvent {
  eventId: string;
  cancelled: boolean; // status "cancelled": deleted in Google, or moved to another calendar
  recurring: boolean; // made recurring in Google → ignored
  title: string | null;
  allDay: boolean;
  startMs: number | null; // null when all-day
  endMs: number | null;
  updatedMs: number; // Google's `updated`; a cancelled stub may lack it → the caller passes now
}

export type PullAction =
  | { kind: 'none' }
  // First sighting of an event Aperture didn't know yet (linked before two-way sync), or a change
  // that maps to nothing: just remember the event (gcalSeen) — nothing on the task changes.
  | { kind: 'see'; seen: GcalSeen }
  | { kind: 'unlink'; note: string }
  | {
      kind: 'apply';
      fields: Partial<Pick<Task, 'title' | 'dueDay' | 'dueTime' | 'estimateMin'>>;
      note: string;
      seen: GcalSeen;
    };

type PullFields = Pick<Task, 'title' | 'status' | 'dueDay' | 'dueTime' | 'estimateMin'> &
  Partial<
    Pick<Task, 'gcalSyncError' | 'gcalTouchedAt' | 'gcalEditedAt' | 'gcalManual' | 'gcalSeen'>
  >;

// The app pulls at most once a minute per account (server-side; failures count).
export const PULL_THROTTLE_MS = 60_000;
export const PULL_REMOVED_NOTE = 'Removed in Google Calendar';
const NONE: PullAction = { kind: 'none' };

// A three-way merge over (the event as Aperture last knew it = task.gcalSeen, the task, the event now).
// Google changed a field iff the event differs from gcalSeen; Aperture changed it iff the task does. So
// our own push echoing back is a no-op, a field only Google changed applies, a field only Aperture
// changed is never "taken" from Google's copy, and a field both changed goes to the later edit (Google's
// `updated` vs gcalEditedAt). An event state older than Aperture's last successful push (Google's
// `updated` < gcalTouchedAt — both Google's clock) predates it and is stale.
export function calendarPullPlan(
  task: PullFields,
  ev: PulledEvent,
  time: { epoch: DueEpoch; clock: DueClock },
): PullAction {
  if (task.status === 'cancelled') return NONE; // its event went with the cancel
  // Deleted or moved away → unlink, never resurrect. Deletion wins whatever `updated` says.
  if (ev.cancelled) return { kind: 'unlink', note: PULL_REMOVED_NOTE };
  if (isPendingRemoval(task.gcalSyncError)) return NONE; // the next sync deletes it anyway
  if (ev.recurring) return NONE;

  const title = ev.title?.trim() || null;
  const timed = !ev.allDay && ev.startMs !== null && ev.endMs !== null;
  const seen = task.gcalSeen;
  // An all-day conversion's time is ignored: keep the known window, so the block isn't "re-timed" back
  // until the task's own time changes.
  const now: GcalSeen = {
    title: title ?? seen?.title ?? null,
    startMs: timed ? ev.startMs : (seen?.startMs ?? null),
    endMs: timed ? ev.endMs : (seen?.endMs ?? null),
  };
  const window = eventWindow(task, time.epoch);
  if (!seen) return { kind: 'see', seen: now }; // first sight: remember it, apply nothing
  const titleUnsent = !sameTitle(task.title, seen.title);
  const timeUnsent = !!window && (window.startMs !== seen.startMs || window.endMs !== seen.endMs);
  if (ev.updatedMs < (task.gcalTouchedAt ?? 0)) {
    // Stale: our push came after this state. Apply nothing — but for a field Aperture hasn't got to
    // Google yet, take Google's value into the base, so it can't be "re-detected" as a Google change
    // later and undo Aperture's (the task still differs from the base, so the next push sends it).
    const absorbed: GcalSeen = {
      title: titleUnsent ? now.title : seen.title,
      startMs: timeUnsent ? now.startMs : seen.startMs,
      endMs: timeUnsent ? now.endMs : seen.endMs,
    };
    return sameSeen(absorbed, seen) ? NONE : { kind: 'see', seen: absorbed };
  }

  // Where both sides changed a field, the later edit wins; when Aperture's does, Google's value still
  // goes into the base (`now`), and the next push sends Aperture's.
  const googleLater = ev.updatedMs > (task.gcalEditedAt ?? 0);
  const fields: Extract<PullAction, { kind: 'apply' }>['fields'] = {};
  // Title: Google renamed it since Aperture last knew the event (trim-insensitive).
  if (
    title &&
    !sameTitle(title, seen.title) &&
    !sameTitle(title, task.title) &&
    (!titleUnsent || googleLater)
  )
    fields.title = title;
  // Time — only a timed task's auto-synced block maps to task fields; a manual block (gcalManual, or any
  // event on an untimed task) syncs its title only.
  const moved = timed && (ev.startMs !== seen.startMs || ev.endMs !== seen.endMs);
  if (moved && window && !task.gcalManual && (!timeUnsent || googleLater)) {
    // Compared as wall-clock day + "HH:MM" and whole minutes, so a value equal to the task's writes nothing.
    const end = time.clock(ev.endMs!);
    if (end.day !== task.dueDay || end.hhmm !== task.dueTime) {
      fields.dueDay = end.day;
      fields.dueTime = end.hhmm;
    }
    // The start sets the working estimate (never the frozen estimateLockedMin). A done task's estimate
    // is history — a stretched block doesn't rewrite it. Against eventLengthMin, so a no-estimate task's
    // default-length block reads as unchanged rather than writing estimateMin = 30.
    const len = Math.round((ev.endMs! - ev.startMs!) / 60_000);
    if (task.status !== 'done' && len > 0 && len !== eventLengthMin(task)) fields.estimateMin = len;
  }
  if (Object.keys(fields).length > 0)
    return { kind: 'apply', fields, note: pullNote(fields), seen: now };
  return sameSeen(now, seen) ? NONE : { kind: 'see', seen: now };
}

const sameSeen = (a: GcalSeen, b: GcalSeen): boolean =>
  sameTitle(a.title, b.title) && a.startMs === b.startMs && a.endMs === b.endMs;

// One short line saying what Google changed: "Moved to Oct 9 5pm · Now 45m in Google Calendar".
export function pullNote(fields: Extract<PullAction, { kind: 'apply' }>['fields']): string {
  const parts: string[] = [];
  if (fields.dueDay && fields.dueTime)
    parts.push(`Moved to ${fmtMonthShortDay(fields.dueDay)} ${fmtClock12(fields.dueTime)}`);
  if (fields.estimateMin != null) parts.push(`Now ${fmtDuration(fields.estimateMin)}`);
  if (fields.title) {
    const t = fields.title.length > 40 ? `${fields.title.slice(0, 39)}…` : fields.title;
    parts.push(`Renamed to “${t}”`);
  }
  return `${parts.join(' · ')} in Google Calendar`;
}

// The "updated from Google" mark shows until the next day rollover (browser-local, dayStartHour).
export const isPullFresh = (
  task: Pick<Task, 'gcalPulledAt'>,
  dayStartHour: number,
  now: number,
): boolean =>
  !!task.gcalPulledAt && dayKey(task.gcalPulledAt, dayStartHour) === todayKey(dayStartHour, now);
