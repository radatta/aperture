import type { TaskSeries } from './types';
import { daysBetween, weekdayOf } from './dates';

// Whether a recurring series has an occurrence on a given day (string compare works: YYYY-MM-DD).
// Shared so the stub and the Lambda materialize IDENTICAL occurrences on getDay() (lazy recurrence).
export function seriesDueOn(series: TaskSeries, day: string): boolean {
  if (day < series.anchorDate) return false;
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
