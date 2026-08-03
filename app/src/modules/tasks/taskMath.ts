import type { RecurrenceRule, Task } from '@aperture/shared';

// The flat v1 buffer nudge: +25% of the estimate (personalized-from-bias is parked to v1.1).
export const BUFFER_PCT = 0.25;

export function suggestedBuffer(estimateMin: number): number {
  return Math.round(estimateMin * BUFFER_PCT);
}

// Default planned minutes when pulling a task into a day: estimate + buffer (the honest ask).
export function plannedDefault(task: Task): number {
  return (task.estimateMin ?? 0) + (task.bufferMin ?? 0);
}

// Remaining work: the frozen estimate (or the working one before freeze) minus what's accrued.
export function remainingMin(task: Task): number {
  const base = task.estimateLockedMin ?? task.estimateMin ?? 0;
  return Math.max(0, base - task.actualAccruedMin);
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function ruleSummary(rule: RecurrenceRule): string {
  switch (rule.kind) {
    case 'daily':
      return 'Every day';
    case 'weekdays':
      return 'Weekdays';
    case 'weekly':
      return rule.daysOfWeek.length
        ? rule.daysOfWeek
            .slice()
            .sort((a, b) => a - b)
            .map((d) => DOW_SHORT[d] ?? '?')
            .join(', ')
        : 'Weekly';
    case 'everyN':
      return rule.interval === 1 ? 'Every day' : `Every ${rule.interval} days`;
  }
}
