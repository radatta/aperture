// Calendar two-way sync, the incoming half (docs/areas/calendar/index.md → Two-way sync). A PURE planner
// over (task, the event as Google now has it): both ApiClient impls run it per changed event in a pull
// and write the one action it returns — the Lambda over an events.list delta, the stub over its dev
// queue — so their decisions can't drift. The outgoing half is calendarSync.ts.
//
// Only events Aperture created are ever matched (by the task's stored pointer); everything else in the
// delta is dropped untouched by the caller.

import { dayKey, fmtClock12, fmtDuration, fmtMonthShortDay, todayKey } from './dates';
import { eventLengthMin, syncWindow } from './due';
import type { DueClock, DueEpoch } from './due';
import { isPendingRemoval, sameTitle } from './calendarSync';
import { blockTitle, titleFromBlock } from './parts';
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
  // An event's first sight on the account's first sync (linked before two-way sync), or a change that
  // maps to nothing: just remember the event as Google has it (gcalSeen, with its `updated`) — nothing
  // on the task changes.
  | { kind: 'see'; seen: GcalSeen }
  | { kind: 'unlink'; note: string }
  // `fields` is empty when the note only says a Google change was kept out (Aperture's unsent edit won).
  | {
      kind: 'apply';
      fields: Partial<Pick<Task, 'title' | 'dueDay' | 'dueTime' | 'estimateMin'>>;
      note: string;
      seen: GcalSeen;
    };

type PullFields = Pick<Task, 'title' | 'status' | 'dueDay' | 'dueTime' | 'estimateMin'> &
  Partial<Pick<Task, 'gcalSyncError' | 'gcalSeen'>>;

// A field Google changed that Aperture had also changed and not yet sent — Aperture's value stays.
export type KeptField = 'title' | 'time';

// The app pulls at most once a minute per account (server-side; failures count).
export const PULL_THROTTLE_MS = 60_000;
export const PULL_REMOVED_NOTE = 'Removed in Google Calendar';
export const PULL_KEPT_PREFIX = 'Kept your';
const NONE: PullAction = { kind: 'none' };

// A three-way merge over (the event as Aperture last knew it = task.gcalSeen, the task, the event now).
// Google changed a field iff the event differs from gcalSeen; Aperture changed it iff the task does. So
// our own push echoing back is a no-op, a field only Google changed applies, a field only Aperture
// changed is never "taken" from Google's copy, and a field both changed keeps Aperture's value (unsent —
// the next push sends it) while the base takes Google's, so it isn't re-detected. An event state older
// than the base (Google's `updated` < gcalSeen.updatedMs — both Google's clock) is stale: our own push
// came after it, and that push's echo carries anything newer.
//
// A parent's event is its due marker: its end is the deadline, its start/length map to nothing. A part's
// block is named "P2 · Part 1" — the prefix is stripped before a rename reaches the part's title.
export function calendarPullPlan(
  task: PullFields,
  ev: PulledEvent,
  time: { epoch: DueEpoch; clock: DueClock },
  opts: { firstSync: boolean; parent?: boolean; parentTitle?: string | null },
): PullAction {
  if (task.status === 'cancelled') return NONE; // its event went with the cancel
  // Deleted or moved away → unlink, never resurrect. Deletion wins whatever `updated` says.
  if (ev.cancelled) return { kind: 'unlink', note: PULL_REMOVED_NOTE };
  if (isPendingRemoval(task.gcalSyncError)) return NONE; // the next sync deletes it anyway
  if (ev.recurring) return NONE;

  const title = ev.title?.trim() || null;
  const timed = !ev.allDay && ev.startMs !== null && ev.endMs !== null;
  const parent = !!opts.parent;
  const window = syncWindow(task, time.epoch, parent);
  const known = blockTitle(task, opts.parentTitle); // the title the event should have
  // No gcalSeen (linked before two-way sync): on the first sync, remember Google's state — a difference
  // is Aperture's unsent value. Later, it only shows up by changing in Google, so the task as it is
  // stands in for the base — unless it holds a failed push (docs/areas/calendar → First sight).
  const seen =
    task.gcalSeen ??
    (opts.firstSync || task.gcalSyncError ? null : seenFromTask(task, window, opts.parentTitle));
  // An all-day conversion's time is ignored: keep the known window, so the block isn't "re-timed" back
  // until the task's own time changes.
  const now: GcalSeen = {
    title: title ?? seen?.title ?? null,
    startMs: timed ? ev.startMs : (seen?.startMs ?? null),
    endMs: timed ? ev.endMs : (seen?.endMs ?? null),
    updatedMs: ev.updatedMs,
  };
  if (!seen) return { kind: 'see', seen: now };
  // Stale: predates the base. (`?? 0`: a base from an earlier build of this branch has no version.)
  if (ev.updatedMs < (seen.updatedMs ?? 0)) return NONE;
  const titleUnsent = !sameTitle(known, seen.title);
  // Aperture changed the time iff the task no longer maps to the base the way a pull would map it: the
  // deadline (the same instant, or the same wall-clock minute — a fall-back hour's second 1:30, an end
  // with seconds), the length in whole minutes (not on a done task or a marker — their start never
  // maps). A window not known (first seen all-day) isn't unsent: the push side only moves it with the
  // task's time.
  const seenEnd = seen.endMs !== null ? time.clock(seen.endMs) : null;
  const timeUnsent =
    !!window &&
    seen.startMs !== null &&
    seen.endMs !== null &&
    ((window.endMs !== seen.endMs &&
      (seenEnd!.day !== task.dueDay || seenEnd!.hhmm !== task.dueTime)) ||
      (task.status !== 'done' &&
        !parent &&
        Math.round((seen.endMs - seen.startMs) / 60_000) !==
          (window.endMs - window.startMs) / 60_000));

  const fields: Extract<PullAction, { kind: 'apply' }>['fields'] = {};
  const kept: KeptField[] = [];
  // Title: Google renamed it since Aperture last knew the event (trim-insensitive).
  const renamed = title ? titleFromBlock(title, opts.parentTitle) : '';
  if (title && renamed && !sameTitle(title, seen.title) && !sameTitle(renamed, task.title)) {
    if (titleUnsent) kept.push('title');
    else fields.title = renamed;
  }
  // Time — only a timed task's block maps to task fields; an event on an untimed task syncs its title only.
  const moved = timed && (ev.startMs !== seen.startMs || ev.endMs !== seen.endMs);
  if (moved && window) {
    // Compared as wall-clock day + "HH:MM" and whole minutes, so a value equal to the task's writes nothing.
    const timeFields: typeof fields = {};
    // Only an end that moved touches the deadline (a start drag on a deadline in the skipped spring-forward
    // hour mustn't rewrite its wall clock).
    const end = time.clock(ev.endMs!);
    if (ev.endMs !== seen.endMs && (end.day !== task.dueDay || end.hhmm !== task.dueTime)) {
      timeFields.dueDay = end.day;
      timeFields.dueTime = end.hhmm;
    }
    // The start sets the working estimate (never the frozen estimateLockedMin). A done task's estimate
    // is history — a stretched block doesn't rewrite it. Against eventLengthMin, so a no-estimate task's
    // default-length block reads as unchanged rather than writing estimateMin = 30. A marker's length
    // is ignored (a parent has no estimate of its own).
    const len = Math.round((ev.endMs! - ev.startMs!) / 60_000);
    if (task.status !== 'done' && !parent && len > 0 && len !== eventLengthMin(task))
      timeFields.estimateMin = len;
    if (Object.keys(timeFields).length > 0) {
      if (timeUnsent) kept.push('time');
      else Object.assign(fields, timeFields);
    }
  }
  if (Object.keys(fields).length > 0 || kept.length > 0)
    return { kind: 'apply', fields, note: pullNote(fields, kept), seen: now };
  // A newer state with nothing to map still advances the base's version (so an older one is stale).
  return sameSeen(now, seen) && now.updatedMs <= (seen.updatedMs ?? 0)
    ? NONE
    : { kind: 'see', seen: now };
}

// The event as the task maps to it — the base for an event first seen after the first sync (the stub's
// dev queue uses it the same way: its edits are always deliberate).
export const seenFromTask = (
  task: Pick<Task, 'title'>,
  window: { startMs: number; endMs: number } | null,
  parentTitle?: string | null,
): GcalSeen => ({
  title: blockTitle(task, parentTitle),
  startMs: window?.startMs ?? null,
  endMs: window?.endMs ?? null,
  updatedMs: 0,
});

const sameSeen = (a: GcalSeen, b: GcalSeen): boolean =>
  sameTitle(a.title, b.title) && a.startMs === b.startMs && a.endMs === b.endMs;

// One short line saying what Google changed: "Moved to Oct 9 5pm · Now 45m in Google Calendar", and what
// it changed that Aperture kept: "Kept your title — renamed in Google Calendar too".
export function pullNote(
  fields: Extract<PullAction, { kind: 'apply' }>['fields'],
  kept: KeptField[] = [],
): string {
  const parts: string[] = [];
  if (fields.dueDay && fields.dueTime)
    parts.push(`Moved to ${fmtMonthShortDay(fields.dueDay)} ${fmtClock12(fields.dueTime)}`);
  if (fields.estimateMin != null) parts.push(`Now ${fmtDuration(fields.estimateMin)}`);
  if (fields.title) {
    const t = fields.title.length > 40 ? `${fields.title.slice(0, 39)}…` : fields.title;
    parts.push(`Renamed to “${t}”`);
  }
  const keptWhat = kept.join(' and ');
  if (parts.length === 0) {
    const how = kept.length > 1 ? 'changed' : kept[0] === 'title' ? 'renamed' : 'moved';
    return `${PULL_KEPT_PREFIX} ${keptWhat} — ${how} in Google Calendar too`;
  }
  const applied = `${parts.join(' · ')} in Google Calendar`;
  return kept.length > 0 ? `${applied} · ${PULL_KEPT_PREFIX} ${keptWhat}` : applied;
}

// Only kept out (the row's "kept over Google") vs kept out in part (a mixed note — Send still applies).
export const isKeptNote = (note: string): boolean => note.startsWith(PULL_KEPT_PREFIX);
export const hasKeptPart = (note: string): boolean => note.includes(PULL_KEPT_PREFIX);

// The "updated from Google" mark shows until the next day rollover (browser-local, dayStartHour).
export const isPullFresh = (
  task: Pick<Task, 'gcalPulled'>,
  dayStartHour: number,
  now: number,
): boolean =>
  !!task.gcalPulled && dayKey(task.gcalPulled.at, dayStartHour) === todayKey(dayStartHour, now);
