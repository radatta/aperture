// Split — one task becomes two (docs/areas/tasks/split.md). The ONE place the split + family rules live,
// so the stub and the Lambda can't drift. A split never cancels: the original finishes ('done') or keeps
// going ('keep'), and the remaining work becomes a new task with its own estimate.
//
// A FAMILY is the original plus every part split off it once a frozen baseline existed: the root's
// estimateLockedMin covers the whole job, so the family is calibrated as one (root lock vs combined
// actual). Until that lands, no family member is a calibration point on its own — a done part measured
// against the whole job's lock would read as "overestimated".
//
// NB: pre-existing tasks predate `splitFromId` and read back undefined — compare `!t.splitFromId`.

import type { SplitTaskInput } from './api';
import {
  canTransitionTask,
  contributesCalibration,
  taskTransition,
  withEstimate,
} from './machines';
import { ROLL_PLAN_FALLBACK_MIN } from './rolls';
import type { BaseEntity, Task, TaskPlan } from './types';

// A part links to the task it was split from only when a frozen baseline exists upstream — the task's own
// lock, or (an unstarted part) its own link. So a task with linked children always has a lock predating
// all of them. Splitting an unstarted task makes two independent fresh estimates, not a family.
export function linksToFamily(task: Task): boolean {
  return task.estimateLockedMin != null || !!task.splitFromId;
}

export function splitChildren(tasks: Task[], id: string): Task[] {
  return tasks.filter((t) => t.splitFromId === id);
}

// Walks splitFromId up to the original. A missing parent (deleted) ends the walk at the last one found.
export function splitRoot(tasks: Task[], task: Task): Task {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  let cur = task;
  while (cur.splitFromId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.splitFromId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

// The root and every part descended from it.
export function splitFamily(tasks: Task[], rootId: string): Task[] {
  const out: Task[] = [];
  const queue = tasks.filter((t) => t.id === rootId);
  const seen = new Set<string>();
  while (queue.length) {
    const t = queue.shift()!;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    queue.push(...splitChildren(tasks, t.id));
  }
  return out;
}

export function inSplitFamily(task: Task, tasks: Task[]): boolean {
  return !!task.splitFromId || tasks.some((t) => t.splitFromId === task.id);
}

// The interim calibration rule: a done, locked task — unless it belongs to a split family.
export function isCalibrationPoint(task: Task, tasks: Task[]): boolean {
  return contributesCalibration(task) && !inSplitFamily(task, tasks);
}

// Where the follow-up lands: the latest day the original is planned on (pass its alive plan rows), or
// null → backlog. A past day self-heals — getDay(today)'s stale sweep moves it back to backlog.
export function followUpPlanDay(plans: TaskPlan[], taskId: string): string | null {
  let day: string | null = null;
  for (const p of plans) if (p.taskId === taskId && (day === null || p.day > day)) day = p.day;
  return day;
}

// The follow-up's plan-row minutes — the useAddToDay rule (estimate + buffer, else the fallback).
export function followUpPlanMinutes(estimateMin: number | null, bufferMin: number | null): number {
  return (estimateMin ?? 0) + (bufferMin ?? 0) || ROLL_PLAN_FALLBACK_MIN;
}

// The original's half: validates the whole input (throws before any write), then applies the edits
// (title, estimate, actual) and the finish. Calendar pointers are the caller's — they depend on the event.
export function splitOriginal(task: Task, input: SplitTaskInput, now: number): Task {
  if (task.status === 'done' || task.status === 'cancelled')
    throw new Error(`Can't split a finished task (status: ${task.status})`);
  if (input.finish !== 'done' && input.finish !== 'keep')
    throw new Error(`Invalid split finish: ${String(input.finish)}`);
  if (input.finish === 'done' && !canTransitionTask(task.status, 'done'))
    throw new Error(`Only a started task can finish a part (status: ${task.status})`);
  if (!input.followUp?.title?.trim()) throw new Error('Follow-up title is required');
  if (input.title !== undefined && !input.title.trim()) throw new Error('Title is required');
  let next: Task = { ...task, updatedAt: now };
  if (input.title !== undefined) next.title = input.title.trim();
  if (input.estimateMin !== undefined || input.bufferMin !== undefined)
    next = withEstimate(
      next,
      input.estimateMin !== undefined ? input.estimateMin : next.estimateMin,
      input.bufferMin !== undefined ? input.bufferMin : next.bufferMin,
      now,
    );
  if (input.finish === 'done') {
    if (input.actualMin !== undefined) next.actualAccruedMin = input.actualMin;
    next = taskTransition(next, 'done', now);
  }
  return next;
}

// The follow-up half: a fresh task for the remaining work, with its own UNLOCKED estimate (a new
// prediction — the original's frozen value is never reused). Returns the non-identity fields; the caller
// stamps a BaseEntity and, for a timed done split, moves the original's event link onto it.
export function splitFollowUp(
  original: Task,
  followUp: SplitTaskInput['followUp'],
  planned: boolean,
): Omit<Task, keyof BaseEntity> {
  return {
    title: followUp.title.trim(),
    status: planned ? 'planned' : 'backlog',
    categoryId: original.categoryId,
    dueDay: original.dueDay, // a split changes scope, not the deadline — carry it (like categoryId)
    dueTime: original.dueTime ?? null,
    notes: original.notes ?? null, // the remaining scope keeps its context
    seriesId: null,
    rollId: original.rollId, // finishing the split-off remainder tomorrow is honestly a rep tomorrow
    estimateMin: followUp.estimateMin,
    bufferMin: followUp.bufferMin ?? null,
    estimateLockedMin: null,
    splitFromId: linksToFamily(original) ? original.id : null,
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
