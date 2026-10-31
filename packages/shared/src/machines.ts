// Pure state machines & invariants — shared so the stub and the eventual Lambda enforce the
// SAME rules. These never touch storage; they take an entity + inputs and return the next entity
// (or throw on an illegal move). This is where the calibration integrity actually lives.

import { dayKey, localEpochFromDayTime } from './dates';
import type { PomodoroSession, Task, TaskPlan, TaskStatus } from './types';

// --- Tasks -----------------------------------------------------------------

const TASK_EDGES: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['planned', 'in_progress', 'cancelled'],
  planned: ['backlog', 'in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled', 'backlog'], // → backlog = rollover, no penalty
  done: [], // terminal — scope change is a split, not an un-done
  cancelled: [], // terminal
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_EDGES[from].includes(to);
}

// The heart of calibration: the estimate FREEZES on first exit from planning. After that the
// locked value is what "done" is measured against — hindsight can't launder it.
export function taskTransition(task: Task, to: TaskStatus, now: number): Task {
  if (!canTransitionTask(task.status, to)) {
    throw new Error(`Invalid task transition: ${task.status} → ${to}`);
  }
  const next: Task = { ...task, status: to, updatedAt: now };
  const leavingPlanning = task.status === 'backlog' || task.status === 'planned';
  const enteringWork = to === 'in_progress' || to === 'done';
  if (leavingPlanning && enteringWork && next.estimateLockedMin === null) {
    next.estimateLockedMin = task.estimateMin; // may be null → this task yields no calibration point
  }
  if (to === 'in_progress' && next.startedAt === null) next.startedAt = now;
  if (to === 'done') next.completedAt = now;
  if (to === 'cancelled') next.cancelledAt = now;
  return next;
}

// Option 3 (lenses.md D13, parts.md D14): a time decides the day. A timed task is on the app day its
// deadline falls on, by clock, and never holds a plan row; only an untimed task is planned. Time-only
// rules — callers add the parent check (a parent is never on Today; parts.ts can't be imported here).
export const isTimed = (t: Pick<Task, 'dueDay' | 'dueTime'>): boolean => !!t.dueDay && !!t.dueTime;
// The deadline instant, bucketed like every other instant (dayKey): with a 4am day start a 00:30
// deadline is still tonight. Browser-side — the zone is the runtime's. null if untimed.
export const timedDay = (
  t: Pick<Task, 'dueDay' | 'dueTime'>,
  dayStartHour: number,
): string | null =>
  isTimed(t) ? dayKey(localEpochFromDayTime(t.dueDay!, t.dueTime!), dayStartHour) : null;
export const placedByTime = (
  t: Pick<Task, 'dueDay' | 'dueTime'>,
  day: string,
  dayStartHour: number,
): boolean => timedDay(t, dayStartHour) === day;
export const TIMED_NO_PLAN_ERROR =
  'A timed task is on the day its time falls on — change when it ends instead of planning it.';

// Stale-planned sweep (getDay's lazy rollover): a planned task with no alive plan row on `day` or later
// was left behind. A timed `planned` task is swept whatever its rows — option 3's standing invariant,
// and the lazy migration of rows made before it (the rows stay as history). It goes back to backlog —
// unless it's a recurring occurrence already superseded by its series' copy on `day`, which is dropped
// instead (a missed daily would otherwise pile up one backlog copy per day). An occurrence carrying a
// calendar event goes to backlog: a background read never deletes external events. Plan rows are
// history and stay. Pass alive rows only.
// Monotone in `day`: a past day never moves more than today would; a FUTURE day would sweep today's plan.
export function stalePlannedMoves(
  tasks: Task[],
  plans: TaskPlan[],
  day: string,
): { task: Task; to: 'backlog' | 'cancelled' }[] {
  const planned = tasks.filter((t) => t.status === 'planned');
  if (planned.length === 0) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ahead = new Set<string>();
  const seriesToday = new Set<string>();
  for (const p of plans) {
    if (p.day >= day) ahead.add(p.taskId);
    const seriesId = p.day === day ? byId.get(p.taskId)?.seriesId : null;
    if (seriesId) seriesToday.add(seriesId);
  }
  return planned
    .filter((t) => isTimed(t) || !ahead.has(t.id))
    .map((task) => {
      // A timed occurrence's own row today would read as its series' copy: never drop it for that.
      const superseded =
        !isTimed(task) &&
        task.seriesId !== null &&
        seriesToday.has(task.seriesId) &&
        !task.gcalEventId;
      return { task, to: superseded ? 'cancelled' : 'backlog' };
    });
}

// The working estimate is editable at any open status — rescoping mid-task is fine, because calibration
// is measured against estimateLockedMin (frozen at start, never touched here). Only history is read-only.
export function canEditEstimate(task: Task): boolean {
  return task.status !== 'done' && task.status !== 'cancelled';
}

export function withEstimate(
  task: Task,
  estimateMin: number | null,
  bufferMin: number | null,
  now: number,
): Task {
  if (!canEditEstimate(task)) {
    throw new Error(`Estimate is history once a task is finished (status: ${task.status})`);
  }
  return { ...task, estimateMin, bufferMin, updatedAt: now };
}

// A done task with a frozen baseline is a calibration point; a cancelled one never is. Parts are points of
// their own, and so is a done parent (its lock vs Σ parts — parts.ts).
export function contributesCalibration(task: Task): boolean {
  return task.status === 'done' && task.estimateLockedMin !== null;
}

// --- Sessions --------------------------------------------------------------

// Heartbeat accrues only the elapsed time since the last beat, and only while running.
// The client stops beating during a pause, so paused time never counts.
export function heartbeatSession(session: PomodoroSession, now: number): PomodoroSession {
  if (session.status !== 'running') return session;
  const deltaMin = Math.max(0, (now - session.lastHeartbeatAt) / 60_000);
  return {
    ...session,
    activeMinutes: session.activeMinutes + deltaMin,
    lastHeartbeatAt: now,
    updatedAt: now,
  };
}

// Resume after a pause: reset the heartbeat clock to now WITHOUT crediting the paused gap. Pause
// captures active time via a final heartbeat, then the client stops beating; this restarts the clock
// so the next beat measures only post-resume time.
export function resumeSession(session: PomodoroSession, now: number): PomodoroSession {
  return { ...session, lastHeartbeatAt: now, updatedAt: now };
}

export function completeSession(session: PomodoroSession, now: number): PomodoroSession {
  const beat = heartbeatSession(session, now);
  return { ...beat, status: 'completed', endedAt: now, updatedAt: now };
}

export function discardSession(session: PomodoroSession, now: number): PomodoroSession {
  return { ...session, status: 'discarded', endedAt: now, updatedAt: now };
}

// A running session found on next open (the app was closed mid-timer): keep or discard.
// KEEP caps accrual at the last heartbeat we actually saw — the dark gap is not credited.
export function resolveStaleSession(
  session: PomodoroSession,
  decision: 'keep' | 'discard',
  now: number,
): PomodoroSession {
  if (decision === 'discard') return discardSession(session, now);
  return { ...session, status: 'completed', endedAt: session.lastHeartbeatAt, updatedAt: now };
}

// --- Categories ------------------------------------------------------------

// Deleting a category is only legal once its referencing items have somewhere to go.
export function assertCategoryDeletable(
  referencingCount: number,
  reassignToId: string | null,
): void {
  if (referencingCount > 0 && !reassignToId) {
    throw new Error('Category has references; provide a reassignment target before deleting.');
  }
}
