import type { BaseEntity, Task, TaskPlan, TaskSeries } from './types';
import { addDays, daysBetween, isDayKey, weekdayOf } from './dates';

// Shared so the stub and the Lambda materialize IDENTICAL occurrences on getDay() (lazy recurrence).
// Model and decisions: docs/areas/tasks/recurring.md.

export const SERIES_OFFSET_ERROR = 'Due offset must be a whole number of days, 0 or more';
export const SERIES_UNTIL_ERROR = 'Until must be a date (YYYY-MM-DD)';

// The cadence half of an upsert, validated and normalized (omitted → null). Throws before any write.
export function seriesCadence(input: { dueOffsetDays?: number | null; until?: string | null }): {
  dueOffsetDays: number | null;
  until: string | null;
} {
  const dueOffsetDays = input.dueOffsetDays ?? null;
  if (dueOffsetDays !== null && (!Number.isInteger(dueOffsetDays) || dueOffsetDays < 0))
    throw new Error(SERIES_OFFSET_ERROR);
  const until = input.until ?? null;
  if (until !== null && !isDayKey(until)) throw new Error(SERIES_UNTIL_ERROR);
  return { dueOffsetDays, until };
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

// The occurrence seriesDueOn says to spawn: a planned task on `day`, due per the cadence, untimed (D1).
// Every spawn path starts reflection/notes null (reflection.md). Callers add BaseEntity.
export function occurrenceFields(series: TaskSeries, day: string): Omit<Task, keyof BaseEntity> {
  return {
    title: series.title,
    status: 'planned',
    categoryId: series.categoryId,
    seriesId: series.id,
    seriesDay: day,
    dueDay: occurrenceDueDay(series, day),
    dueTime: null,
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
