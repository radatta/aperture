import type { BaseEntity, Task, TaskPlan, TaskSeries } from './types';
import { addDays, beforeDayStart, daysBetween, isDayKey, isTimeKey, weekdayOf } from './dates';

// Shared so the stub and the Lambda materialize IDENTICAL occurrences on getDay() (lazy recurrence).
// Model and decisions: docs/areas/tasks/recurring.md.

export const SERIES_OFFSET_ERROR = 'Due offset must be a whole number of days, 0 or more';
export const SERIES_UNTIL_ERROR = 'Until must be a date (YYYY-MM-DD)';
export const SERIES_TIME_ERROR = 'Due time must be a clock time (HH:MM)';
export const SERIES_TIME_NEEDS_DUE_ERROR = 'A due time needs a due day — pick when it is due first';
export const SERIES_TIME_SMALL_HOURS_ERROR =
  'Due the same day at a time before your day starts would spawn already past due — pick Next day';

// The cadence half of an upsert, validated and normalized (omitted → null). Throws before any write.
// `dayStartHour` judges a same-day time before the day start, which would spawn past due (D8).
export function seriesCadence(
  input: { dueOffsetDays?: number | null; until?: string | null; dueTime?: string | null },
  dayStartHour: number,
): { dueOffsetDays: number | null; until: string | null; dueTime: string | null } {
  const dueOffsetDays = input.dueOffsetDays ?? null;
  if (dueOffsetDays !== null && (!Number.isInteger(dueOffsetDays) || dueOffsetDays < 0))
    throw new Error(SERIES_OFFSET_ERROR);
  const until = input.until ?? null;
  if (until !== null && !isDayKey(until)) throw new Error(SERIES_UNTIL_ERROR);
  const dueTime = input.dueTime ?? null;
  if (dueTime !== null) {
    if (typeof dueTime !== 'string' || !isTimeKey(dueTime)) throw new Error(SERIES_TIME_ERROR);
    if (dueOffsetDays === null) throw new Error(SERIES_TIME_NEEDS_DUE_ERROR);
    if (dueOffsetDays === 0 && beforeDayStart(dueTime, dayStartHour))
      throw new Error(SERIES_TIME_SMALL_HOURS_ERROR);
  }
  return { dueOffsetDays, until, dueTime };
}

// Whether a recurring series has an occurrence on a given day (string compare works: YYYY-MM-DD) — within
// [anchorDate, until] and on the rule.
export function seriesDueOn(series: TaskSeries, day: string): boolean {
  if (day < series.anchorDate) return false;
  if (series.until != null && day > series.until) return false;
  switch (series.rule.kind) {
    case 'daily':
      return true;
    case 'weekdays': {
      const w = weekdayOf(day);
      return w >= 1 && w <= 5;
    }
    case 'weekly':
      return series.rule.daysOfWeek.includes(weekdayOf(day));
    case 'everyN': {
      const n = daysBetween(series.anchorDate, day);
      return n >= 0 && series.rule.interval > 0 && n % series.rule.interval === 0;
    }
  }
}

// The day the occurrence spawned on `day` is due: `day` + the offset, or none (D1).
export function occurrenceDueDay(series: TaskSeries, day: string): string | null {
  const offset = series.dueOffsetDays ?? null;
  return offset === null ? null : addDays(day, offset);
}

// Whether the series already spawned its occurrence for `day` — by identity (`seriesDay`), whatever became of
// the task or its plan row, so unplanning an occurrence never respawns it (D4). An occurrence from before the
// field (seriesDay undefined) is known by its alive plan row on the day — the old rule, kept so the first
// getDay after the change doesn't double today's. `tasks`: alive tasks, any status; `plansOnDay`: alive rows of `day`.
export function seriesHasOccurrence(
  series: TaskSeries,
  day: string,
  tasks: readonly Task[],
  plansOnDay: readonly TaskPlan[],
): boolean {
  return tasks.some(
    (t) =>
      t.seriesId === series.id &&
      (t.seriesDay == null ? plansOnDay.some((p) => p.taskId === t.id) : t.seriesDay === day),
  );
}

// Whether the occurrence spawns planned on its day (D8): yes, unless it's due that same day at a time —
// then the time decides its day (lenses.md D13) and it spawns unplanned, on Today by its time.
export const occurrencePlanned = (series: TaskSeries): boolean =>
  !(series.dueTime != null && series.dueOffsetDays === 0);

// The occurrence seriesDueOn says to spawn: on `day`, due per the cadence, timed if the series is (D1, D8).
// Every spawn path starts reflection/notes null (reflection.md). Callers add BaseEntity; the caller writes a
// plan row only when occurrencePlanned.
export function occurrenceFields(series: TaskSeries, day: string): Omit<Task, keyof BaseEntity> {
  const dueDay = occurrenceDueDay(series, day);
  return {
    title: series.title,
    status: occurrencePlanned(series) ? 'planned' : 'backlog',
    categoryId: series.categoryId,
    seriesId: series.id,
    seriesDay: day,
    dueDay,
    dueTime: dueDay === null ? null : (series.dueTime ?? null),
    notes: null,
    reflection: null,
    rollId: null,
    estimateMin: series.defaultEstimateMin,
    bufferMin: null,
    estimateLockedMin: null,
    parentId: null,
    place: null,
    actualAccruedMin: 0,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    gcalAccountId: null,
    gcalCalendarId: null,
    gcalEventId: null,
    gcalSyncError: null,
  };
}
