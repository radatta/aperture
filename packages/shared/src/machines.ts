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

// Does this task feed calibration at all? An errand (a placed task) is checked off, not timed (places.ts).
// The one predicate behind the done gate, the start nudge and contributesCalibration.
export const isCalibrated = (task: Pick<Task, 'place'>): boolean => !task.place;
// No estimate worth measuring against yet: what the Start nudge, the Done form and complete_task ask for.
export const needsEstimate = (task: Pick<Task, 'place' | 'estimateMin'>): boolean =>
  isCalibrated(task) && !((task.estimateMin ?? 0) >= 1);
export const DONE_NEEDS_NUMBERS_ERROR =
  "Needs an estimate and an actual (minutes) before it's marked done";

// Done gate (docs/areas/calibration/integrity.md): every calibrated done task is a point. Started unscoped,
// its lock comes now, in hindsight, and the source says so; a lock of 0 was never a baseline. Stored, not
// derived: complete_task's chain through in_progress would otherwise make a retro number look honest.
const hasBaseline = (task: Task): boolean => (task.estimateLockedMin ?? 0) >= 1;
function finishCalibrated(task: Task, next: Task): void {
  if (needsEstimate(task) || !(task.actualAccruedMin >= 1))
    throw new Error(DONE_NEEDS_NUMBERS_ERROR);
  if (!hasBaseline(task)) {
    next.estimateLockedMin = task.estimateMin;
    next.estimateSource = 'retro';
    return;
  }
  next.estimateSource = task.estimateLockedMin === task.estimateMin ? 'planned' : 'revised';
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
    next.estimateLockedMin = task.estimateMin; // may be null → the done gate asks for a retro estimate
  }
  if (to === 'done' && isCalibrated(task)) finishCalibrated(task, next);
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
  'A timed task is on the day its time falls on — change its time instead of planning it.';
// getDay's guard: its sweep is monotone, so a day after the user's current app day would move every
// task whose rows are all before it — today's plan included. A future call is a client bug, refused.
export const FUTURE_DAY_ERROR =
  "getDay is for the current day — a future day would sweep today's plan.";

// Stale-planned sweep (getDay's lazy rollover): a planned task with no alive plan row on `day` or later
// was left behind. `plans` is the alive rows dated `day` or later — earlier rows never change a move, so
// a caller may pass only those (the Lambda's range read does). A timed `planned` task is swept whatever its rows — option 3's standing invariant,
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

// The one way into a finished estimate: a done task with no baseline (from before the gate, or a parent
// whose parts all went) takes one retro
// estimate. Once it has that lock it's history like any other. Not offered in the UI (canEditEstimate).
export const canBackfillEstimate = (task: Task): boolean =>
  task.status === 'done' && isCalibrated(task) && !hasBaseline(task);

export function withEstimate(
  task: Task,
  estimateMin: number | null,
  bufferMin: number | null,
  now: number,
): Task {
  if (canBackfillEstimate(task)) {
    if (estimateMin === null || !(estimateMin >= 1))
      throw new Error('A backfilled estimate needs at least 1 minute');
    return {
      ...task,
      estimateMin,
      bufferMin,
      estimateLockedMin: estimateMin,
      estimateSource: 'retro',
      updatedAt: now,
    };
  }
  if (!canEditEstimate(task)) {
    throw new Error(`Estimate is history once a task is finished (status: ${task.status})`);
  }
  return { ...task, estimateMin, bufferMin, updatedAt: now };
}

// A done task with a frozen baseline is a calibration point; a cancelled one never is. Parts are points of
// their own, and so is a done parent (its lock vs Σ parts — parts.ts). An errand (a placed task) never is,
// even with an estimate typed: it's checked off, not timed (places.ts).
export function contributesCalibration(task: Task): boolean {
  return task.status === 'done' && task.estimateLockedMin !== null && isCalibrated(task);
}

// While open an actual can still read 0 (nothing tracked yet). A done calibrated task's is a measurement.
export function assertActualAllowed(task: Task, actualMin: number): void {
  if (task.status === 'done' && isCalibrated(task) && !(actualMin >= 1))
    throw new Error(DONE_NEEDS_NUMBERS_ERROR);
}

// A closing work session adds its minutes only to a task still open. A done task's actual is the one typed
// at Mark done (or complete_task); a timer stopped after that would count the same time twice, straight into
// calibration. Kept apart from contributesCalibration: a placed task's timer still accrues while it's open.
export function accruesTime(task: Task): boolean {
  return task.status !== 'done' && task.status !== 'cancelled';
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

// A beat whose credit is capped at `capMin` when given: a block that reached its target credits up to the
// target however long it sat on "done" (the client knows the target; iOS freezes a locked page's timers, so
// the last stretch before the lock is still real work and a client-side reset would drop it), and a paused
// timer stops with 0 (its pause beat already captured the worked time). Undefined = uncapped.
function cappedBeat(session: PomodoroSession, now: number, capMin?: number): PomodoroSession {
  if (capMin !== undefined && !(Number.isFinite(capMin) && capMin >= 0))
    throw new Error(`capMin must be a non-negative number of minutes, got ${String(capMin)}`);
  const beat = heartbeatSession(session, now);
  if (capMin === undefined) return beat;
  return { ...beat, activeMinutes: Math.min(beat.activeMinutes, session.activeMinutes + capMin) };
}

export function completeSession(
  session: PomodoroSession,
  now: number,
  capMin?: number,
): PomodoroSession {
  return { ...cappedBeat(session, now, capMin), status: 'completed', endedAt: now, updatedAt: now };
}

// Again on a block that reached its target: the block's last stretch is credited as a stop would, the wait
// isn't, and the clock restarts for one more block. On the row, so a reload or another device keeps the target.
export function extendSession(
  session: PomodoroSession,
  now: number,
  capMin?: number,
): PomodoroSession {
  return { ...cappedBeat(session, now, capMin), blocks: (session.blocks ?? 1) + 1 };
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
