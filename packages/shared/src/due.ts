// A task's deadline as a day plus an optional clock time (docs/areas/tasks/due-dates.md). Pure helpers
// shared by the app, the stub and the Lambda, so the invariant and the urgency tiers live in one place.

import { isDayKey, isTimeKey, localEpochFromDayTime } from './dates';
import type { Task } from './types';

// Epoch of a wall-clock day+time. The browser passes localEpochFromDayTime; the (UTC) Lambda passes a
// zonedEpoch over USER_TIME_ZONE — never the local one.
export type DueEpoch = (dueDay: string, dueTime: string) => number;

// The one gate for a deadline write: a cleared day clears the time; a time needs a day; both must be
// well-formed. `dueTime` undefined = keep `currentTime` (the caller's existing value).
export function normalizeDue(
  dueDay: string | null,
  dueTime: string | null | undefined,
  currentTime: string | null = null,
): { dueDay: string | null; dueTime: string | null } {
  if (dueDay !== null && !isDayKey(dueDay)) throw new Error(`invalid dueDay '${dueDay}'`);
  const time = dueTime === undefined ? currentTime || null : dueTime;
  if (dueDay === null) {
    if (dueTime) throw new Error('dueTime requires dueDay');
    return { dueDay: null, dueTime: null };
  }
  if (time !== null && !isTimeKey(time))
    throw new Error(`invalid dueTime '${time}' — use HH:MM (24h)`);
  return { dueDay, dueTime: time };
}

// A timed task's event length when it has no estimate.
export const DEFAULT_EVENT_MIN = 30;

// The calendar block for a timed task: it ENDS at the deadline and is as long as the estimate (the work
// before it). null when the task has no time.
export function eventWindow(
  task: Pick<Task, 'dueDay' | 'dueTime' | 'estimateMin'>,
  epoch: DueEpoch,
): { startMs: number; endMs: number } | null {
  if (!task.dueDay || !task.dueTime) return null;
  const endMs = epoch(task.dueDay, task.dueTime);
  return { startMs: endMs - (task.estimateMin ?? DEFAULT_EVENT_MIN) * 60_000, endMs };
}

// Timed tasks only, never once finished. soon = within 6h, imminent = within 1h, past = the time has
// gone by (persists, across days, until the task is done, cancelled or moved). Revisits due-dates D5.
export type DueUrgency = 'none' | 'soon' | 'imminent' | 'past';
const HOUR_MS = 3_600_000;

export function dueUrgency(
  task: Pick<Task, 'dueDay' | 'dueTime' | 'status'>,
  nowMs: number,
  epoch: DueEpoch = localEpochFromDayTime,
): DueUrgency {
  if (!task.dueDay || !task.dueTime) return 'none';
  if (task.status === 'done' || task.status === 'cancelled') return 'none';
  const delta = epoch(task.dueDay, task.dueTime) - nowMs;
  if (delta <= 0) return 'past';
  if (delta <= HOUR_MS) return 'imminent';
  if (delta <= 6 * HOUR_MS) return 'soon';
  return 'none';
}
