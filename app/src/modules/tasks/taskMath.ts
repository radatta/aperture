import type { RecurrenceRule, Task, TaskStatus } from '@aperture/shared';

// Human label for a status. "Dropped" for cancelled — the product word for abandoning a task (the
// row action is "Drop"), never "Cancelled".
export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case 'backlog':
      return 'Backlog';
    case 'planned':
      return 'Planned';
    case 'in_progress':
      return 'In progress';
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Dropped';
  }
}

// The details-edit affordance's label, matching what editing can still do: "Scope" when nothing is
// scoped yet, "Rescope" while the task is open (the working estimate is editable at any open status),
// "Details" once it's finished (its estimate is history).
export function scopeLabel(task: Task): string {
  if (task.status === 'done' || task.status === 'cancelled') return 'Details';
  if (task.estimateMin == null) return 'Scope';
  return 'Rescope';
}

// The flat v1 buffer nudge: +25% of the estimate (personalized-from-bias is parked to v1.1).
export const BUFFER_PCT = 0.25;

export function suggestedBuffer(estimateMin: number): number {
  return Math.round(estimateMin * BUFFER_PCT);
}

// Default planned minutes when pulling a task into a day: estimate + buffer (the honest ask).
export function plannedDefault(task: Task): number {
  return (task.estimateMin ?? 0) + (task.bufferMin ?? 0);
}

// Remaining work: the WORKING estimate minus what's accrued — a mid-task rescope moves it. (The frozen
// baseline is calibration's number, not a plan for what's left.)
export function remainingMin(task: Task): number {
  return Math.max(0, (task.estimateMin ?? 0) - task.actualAccruedMin);
}

// Split prefills: the follow-up's default title, and its estimate — what's left of the working
// estimate, floored so a part that ran over still gets a real number. Null when nothing was scoped.
export const SPLIT_TITLE_SUFFIX = ' (cont.)';
export const SPLIT_MIN_REMAINDER = 5;

export function suggestedRemainder(task: Task): number | null {
  if (task.estimateMin == null) return null;
  return Math.max(SPLIT_MIN_REMAINDER, task.estimateMin - task.actualAccruedMin);
}

// Soonest-due-first HINT for the morning backlog pull: dated tasks ascending by dueDay — within a day,
// timed tasks by time, then the untimed ones — and undated tasks last in their incoming order. Stable +
// non-mutating (copies first). This is only ever applied to the unplanned backlog — where no manual
// taskPlans.order exists — so it never overrides a user ordering. Falsy dueDay/dueTime ('' or the
// undefined that older rows read back as) counts as undated/untimed.
export function byDueHint(tasks: Task[]): Task[] {
  return tasks
    .map((task, i) => ({ task, i }))
    .sort((a, b) => {
      // "99:99" sorts an untimed task after every real time on its day.
      const da = a.task.dueDay ? `${a.task.dueDay} ${a.task.dueTime || '99:99'}` : null;
      const db = b.task.dueDay ? `${b.task.dueDay} ${b.task.dueTime || '99:99'}` : null;
      if (da && db) return da < db ? -1 : da > db ? 1 : a.i - b.i;
      if (da) return -1; // dated before undated
      if (db) return 1;
      return a.i - b.i; // both undated → keep incoming order
    })
    .map((x) => x.task);
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
