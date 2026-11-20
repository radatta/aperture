// Calibration's shared rules (docs/areas/calibration): which points score the gap, which lane a point is in,
// the points themselves (the stub and the Lambda build them here, so they can't drift), and the backfill —
// closing an old ticket with its real minutes, kept out of the gap (docs/areas/calibration/dev-lane.md).
//
// "Backfill" here is the import: a done task marked `backfilled`. It is not the one-time retro estimate on a
// done task with no baseline (machines.ts canBackfillEstimate), which scores like any other point.

import type { DateRange } from './api';
import { areaOf } from './areas';
import { dayKeyInZone, isDayKey, USER_TIME_ZONE, zonedEpoch } from './dates';
import {
  contributesCalibration,
  isCalibrated,
  needsEstimate,
  taskTransition,
  withEstimate,
} from './machines';
import { calibrationTasks, hasParts, rollupParts } from './parts';
import type { CalibrationPoint, Category, Task } from './types';

// Does this point count toward the gap? A done parent's rollup doesn't (its parts are points already, and
// counting both weighs that work twice), and nor does a backfilled one (its minutes are real, its estimate
// isn't a forecast anyone made). An older Lambda's point (no field) reads as scored.
export const scoresGap = (p: Pick<CalibrationPoint, 'parts' | 'backfilled'>): boolean =>
  !p.parts && !p.backfilled;

// The Aperture life area is its own lane (dev work: his attention minutes); everything else is Life. A
// point with no area (an older Lambda) reads as Life, as a category with none reads as Personal.
export type CalibrationLane = 'life' | 'aperture';
export const laneOf = (p: Pick<CalibrationPoint, 'area'>): CalibrationLane =>
  p.area === 'aperture' ? 'aperture' : 'life';

// Every done calibrated task as a point, by completion DAY (dayStartHour offset) in the user's zone. The area
// is the category's now, read live: a category moved to another area takes its history with it.
export function calibrationPoints(
  tasks: Task[],
  categories: Pick<Category, 'id' | 'area'>[],
  dayStartHour: number,
  range: DateRange,
): CalibrationPoint[] {
  const catOf = new Map(categories.map((c) => [c.id, c]));
  return calibrationTasks(tasks)
    .filter((t) => t.completedAt !== null)
    .map((t) => ({
      taskId: t.id,
      day: dayKeyInZone(t.completedAt as number, USER_TIME_ZONE, dayStartHour),
      estimateLockedMin: t.estimateLockedMin as number,
      estimateMin: t.estimateMin,
      estimateSource: t.estimateSource ?? null,
      actualAccruedMin: t.actualAccruedMin,
      categoryId: t.categoryId,
      area: areaOf(t.categoryId ? catOf.get(t.categoryId) : null),
      backfilled: t.backfilled === true,
      reflection: t.reflection ?? null,
      parts: rollupParts(tasks, t.id),
    }))
    .filter((p) => p.day >= range.from && p.day <= range.to)
    .sort((a, b) => a.day.localeCompare(b.day));
}

// --- Backfill ----------------------------------------------------------------
export interface BackfillTaskInput {
  id: string;
  actualMin: number; // the real minutes — required, never a default
  estimateMin?: number | null; // required when the task has none; else a revision, as complete_task
  completedDay: string; // YYYY-MM-DD, the app day it shipped; never after today
}
export type BackfillOutcome = 'done' | 'skipped'; // skipped: already done and backfilled (a rerun)
export interface BackfillResult {
  id: string;
  outcome: BackfillOutcome;
  task: Task;
}
export const BACKFILL_MAX = 100;
// Noon of the day: inside the app day whatever the day-start hour, and never near a DST edge.
export const BACKFILL_HOUR = '12:00';

const minutesOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

// Why a task can't be backfilled through the batch, or null when it can. Only plain tasks: the other shapes
// carry side effects (a parent's rollup, an errand's check-off, a Roll rep's sitting, a recurring
// occurrence's series, a calendar block) — complete_task, then the mark through update_task, covers them.
function notPlain(task: Task, tasks: Task[]): string | null {
  if (hasParts(tasks, task.id)) return 'it has parts';
  if (task.parentId) return 'it is a part';
  if (!isCalibrated(task)) return 'it is an errand';
  if (task.rollId) return 'it is a Roll rep';
  if (task.seriesId) return 'it is a recurring occurrence';
  if (task.gcalEventId) return 'it has a calendar event';
  return null;
}

// The whole batch's writes, checked before any of them: one bad row throws, naming it, and nothing lands.
// `tasks` is every alive task (the parts check reads it); `today` the user's app day. Each `next` is the task
// done the way complete_task would leave it — started (the lock freezes on what it said then), the
// estimate if given, the actual, the done gate — then dated to `completedDay` and marked.
export function planBackfill(
  tasks: Task[],
  inputs: BackfillTaskInput[],
  today: string,
  now: number,
): { id: string; next: Task | null; task: Task }[] {
  if (!Array.isArray(inputs) || inputs.length === 0)
    throw new Error('backfill needs at least one task');
  if (inputs.length > BACKFILL_MAX)
    throw new Error(`backfill takes at most ${BACKFILL_MAX} tasks at once (got ${inputs.length})`);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  return inputs.map((input, i) => {
    const at = `Row ${i + 1} (${String(input?.id)})`;
    const task = byId.get(input?.id);
    if (!task) throw new Error(`${at}: not found`);
    if (seen.has(task.id)) throw new Error(`${at}: listed twice`);
    seen.add(task.id);
    if (!minutesOk(input.actualMin))
      throw new Error(`${at}: actualMin must be a whole number of minutes, at least 1`);
    const est = input.estimateMin ?? null;
    if (est !== null && !minutesOk(est))
      throw new Error(`${at}: estimateMin must be a whole number of minutes, at least 1`);
    if (typeof input.completedDay !== 'string' || !isDayKey(input.completedDay))
      throw new Error(`${at}: completedDay must be a date (YYYY-MM-DD)`);
    if (input.completedDay > today)
      throw new Error(`${at}: completedDay ${input.completedDay} is after today (${today})`);
    if (task.status === 'done' && task.backfilled) return { id: task.id, next: null, task };
    if (task.status === 'done')
      throw new Error(
        `${at}: already done — mark it with update_task backfilled: true instead of closing it again`,
      );
    if (task.status === 'cancelled') throw new Error(`${at}: it is cancelled`);
    const why = notPlain(task, tasks);
    if (why)
      throw new Error(
        `${at}: ${why} — close it with complete_task, then update_task backfilled: true`,
      );
    let t = task.status === 'in_progress' ? task : taskTransition(task, 'in_progress', now);
    if (est !== null) t = withEstimate(t, est, t.bufferMin, now);
    if (needsEstimate(t))
      throw new Error(`${at}: it has no estimate — pass estimateMin (what it would have been)`);
    t = taskTransition({ ...t, actualAccruedMin: input.actualMin }, 'done', now);
    const completedAt = zonedEpoch(input.completedDay, BACKFILL_HOUR, USER_TIME_ZONE);
    const startedAt = Math.min(t.startedAt ?? completedAt, completedAt);
    return { id: task.id, next: { ...t, completedAt, startedAt, backfilled: true }, task };
  });
}

export const BACKFILL_MARK_ERROR =
  'Only a done task that is a calibration point carries the backfilled mark';

// Set or clear the mark on a task already done (closed by hand or complete_task). A parent's rollup is never
// scored anyway, so it takes no mark; nothing else about the task moves, its completion day included.
export function withBackfilled(task: Task, tasks: Task[], backfilled: boolean, now: number): Task {
  if (typeof backfilled !== 'boolean') throw new Error('backfilled must be true or false');
  if ((task.backfilled === true) === backfilled) return task;
  if (backfilled && (!contributesCalibration(task) || hasParts(tasks, task.id)))
    throw new Error(BACKFILL_MARK_ERROR);
  return { ...task, backfilled, updatedAt: now };
}
