// Rolls — deadline-free ongoing efforts (see the Roll type). The ONE place the "rep" rule lives, so
// the stub and the Lambda can't drift: a rep is a completed Task tagged with the roll, and momentum is
// DERIVED from those done tasks — never a stored counter or streak.
//
// NB: pre-existing tasks predate `rollId` and read back as `undefined`, so every check here compares
// `=== rollId` / `!t.rollId`, never `=== null`.

import type { BaseEntity, Roll, Task } from './types';
import { dayKey } from './dates';

// A picked Roll with no estimate still needs a plannable duration — the same fallback PlanSection uses.
export const ROLL_PLAN_FALLBACK_MIN = 30;

// The non-identity fields of a fresh rep task for a roll — a planned, unlocked task carrying the roll's
// category + estimate. The caller stamps a BaseEntity (mirrors machines.splitFollowUp).
export function rollRepFields(roll: Roll): Omit<Task, keyof BaseEntity> {
  return {
    title: roll.name,
    status: 'planned',
    categoryId: roll.categoryId,
    seriesId: null,
    rollId: roll.id,
    dueDay: null, // a Roll has no deadline — that's the whole point
    estimateMin: roll.estimateMin,
    bufferMin: null,
    estimateLockedMin: null,
    actualAccruedMin: 0,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    gcalAccountId: null,
    gcalCalendarId: null,
    gcalEventId: null,
  };
}

export function isRep(task: Task, rollId: string): boolean {
  return task.rollId === rollId;
}

// The live rep task for a roll, if one is already open (backlog|planned|in_progress). Picking reuses it
// instead of spawning a duplicate — so yesterday's unfinished LeetCode re-plans onto today. Done and
// cancelled reps are history and never block a fresh pick.
export function findOpenRollTask(tasks: Task[], rollId: string): Task | undefined {
  return tasks.find(
    (t) =>
      t.rollId === rollId &&
      (t.status === 'backlog' || t.status === 'planned' || t.status === 'in_progress'),
  );
}

// Reps per day for a roll: a Map of day-key → count of done reps completed that day. The contact sheet
// is built from this. A day with two finished problems counts 2; bucketed by the completion time under
// the day-start offset (a 2am finish lands on the prior day).
export function repDays(tasks: Task[], rollId: string, dayStartHour: number): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const t of tasks) {
    if (t.rollId !== rollId || t.status !== 'done' || t.completedAt == null) continue;
    const key = dayKey(t.completedAt, dayStartHour);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  return byDay;
}
