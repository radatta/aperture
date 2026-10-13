// Split — when work turns out bigger (docs/areas/tasks/split.md, parts.md). Split always yields parent +
// parts: a standalone task becomes Part 1 under a NEW parent that takes its title, deadline and lock (so the
// parent's rollup covers the whole job), and a part just gains a sibling. A split never cancels: this part
// finishes ('done') or keeps going ('keep'), and the remaining work becomes a new part with its own estimate.
// A roll rep or a recurring occurrence isn't split (parts.md D11). Parent rules (who can be one, the
// rollup) live in parts.ts; this file is the split mechanics.

import type { SplitTaskInput } from './api';
import { canTransitionTask, taskTransition, withEstimate } from './machines';
import { isRep } from './parts';
import { ROLL_PLAN_FALLBACK_MIN } from './rolls';
import type { BaseEntity, Task, TaskPlan } from './types';

// A standalone original's title once it's the first part (the form prefills it; any title can be typed).
export const STANDALONE_PART_TITLE = 'Part 1';

export const REP_NO_SPLIT_ERROR =
  'A roll rep or a recurring task isn’t split — it’s one rep of a repeating thing. Rescope it or finish it.';

// The editor's "Split…" gate: open, and not a rep (splitting one would leave two reps on one day). The
// caller hides it on a parent too (PARENT_NO_SPLIT_ERROR).
export const canSplit = (task: Task): boolean =>
  task.status !== 'done' && task.status !== 'cancelled' && !isRep(task);

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

// The original's row on the landing day after a split, so the day's planned total counts the job once
// (its row + the follow-up's) instead of the old size on top. Done: the part's actual — what it really
// took. Keep, rescoped: the new estimate + buffer. Null → leave the row (a kept-going original whose
// estimate didn't change is as planned).
export function rescopedPlanMinutes(input: SplitTaskInput, original: Task): number | null {
  if (input.finish === 'done') return Math.round(original.actualAccruedMin);
  if (input.estimateMin === undefined && input.bufferMin === undefined) return null;
  return followUpPlanMinutes(original.estimateMin, original.bufferMin);
}

// The original's half: validates the whole input (throws before any write), then applies the edits
// (title, estimate, actual) and the finish. `standalone` = it isn't a part yet, so it becomes Part 1 (an
// omitted title defaults to STANDALONE_PART_TITLE); an untimed one's day was its deadline, which is the
// parent's now, so it goes (a timed one keeps it — its time is its block's end). The caller refuses a parent first (PARENT_NO_SPLIT_ERROR)
// and owns the calendar pointers — they depend on the event.
export function splitOriginal(
  task: Task,
  input: SplitTaskInput,
  now: number,
  standalone: boolean,
): Task {
  if (task.status === 'done' || task.status === 'cancelled')
    throw new Error(`Can't split a finished task (status: ${task.status})`);
  if (isRep(task)) throw new Error(REP_NO_SPLIT_ERROR);
  if (input.finish !== 'done' && input.finish !== 'keep')
    throw new Error(`Invalid split finish: ${String(input.finish)}`);
  if (input.finish === 'done' && !canTransitionTask(task.status, 'done'))
    throw new Error(`Only a started task can finish a part (status: ${task.status})`);
  if (!input.followUp?.title?.trim()) throw new Error('Follow-up title is required');
  if (input.title !== undefined && !input.title.trim()) throw new Error('Title is required');
  if (input.parentTitle !== undefined && (!standalone || !input.parentTitle.trim()))
    throw new Error(
      standalone ? 'Parent title is required' : 'A part’s parent already has its title',
    );
  // Minutes feed the plan and (actual) calibration — a negative or non-number is never stored.
  const nums = {
    actualMin: input.actualMin,
    estimateMin: input.estimateMin,
    bufferMin: input.bufferMin,
    'followUp.estimateMin': input.followUp.estimateMin,
    'followUp.bufferMin': input.followUp.bufferMin,
  };
  for (const [k, v] of Object.entries(nums)) {
    const nullable = k !== 'actualMin';
    if (v === undefined || (v === null && nullable)) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      throw new Error(`${k} must be a non-negative number of minutes`);
  }
  let next: Task = { ...task, updatedAt: now };
  if (input.title !== undefined) next.title = input.title.trim();
  else if (standalone) next.title = STANDALONE_PART_TITLE;
  if (standalone && !task.dueTime) next.dueDay = null;
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

// A standalone split's new parent: the deliverable the original was. It takes the title (unless renamed),
// category, deadline and notes (copied — the original keeps its own), and the original's lock, so the
// rollup's baseline predates every part. No estimate (Σ parts), no plan, no roll, no calendar event.
export function newParentFrom(original: Task, input: SplitTaskInput): Omit<Task, keyof BaseEntity> {
  return {
    title: input.parentTitle?.trim() || original.title,
    status: 'backlog',
    categoryId: original.categoryId,
    dueDay: original.dueDay,
    dueTime: original.dueTime ?? null,
    notes: original.notes ?? null,
    seriesId: null,
    rollId: null,
    estimateMin: null,
    bufferMin: null,
    estimateLockedMin: original.estimateLockedMin,
    parentId: null,
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

// The follow-up half: a new part of `parentId` for the remaining work, with its own UNLOCKED estimate (a
// new prediction — the original's frozen value is never reused). It keeps a timed original's time (dueDay/
// dueTime — for a part, when its block ends) so a timed split's work stays on the calendar; an untimed day
// is a deadline (the parent's) or that part's own, never the new part's. Returns the
// non-identity fields; the caller stamps a BaseEntity and, for a timed done split, moves the event onto it.
export function splitFollowUp(
  original: Task,
  followUp: SplitTaskInput['followUp'],
  planned: boolean,
  parentId: string,
): Omit<Task, keyof BaseEntity> {
  return {
    title: followUp.title.trim(),
    status: planned ? 'planned' : 'backlog',
    categoryId: original.categoryId,
    dueDay: original.dueTime ? original.dueDay : null,
    dueTime: original.dueTime ?? null,
    notes: original.notes ?? null, // the remaining scope keeps its context
    seriesId: null,
    rollId: null, // a rep is never split (splitOriginal), so a part never carries a roll
    estimateMin: followUp.estimateMin,
    bufferMin: followUp.bufferMin ?? null,
    estimateLockedMin: null,
    parentId,
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
