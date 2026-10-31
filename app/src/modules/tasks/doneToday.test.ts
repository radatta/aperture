import { describe, expect, it } from 'vitest';
import { dayKey } from '@aperture/shared';
import type { Task, TaskPlan, TaskStatus } from '@aperture/shared';
import { doneToday } from './doneToday';

const START = 4;
const NOW = new Date(2026, 5, 15, 14, 0).getTime(); // 2pm local
const TODAY = dayKey(NOW, START);
const HOUR = 3_600_000;

function mkTask(id: string, status: TaskStatus, over: Partial<Task> = {}): Task {
  return {
    id,
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    title: id,
    status,
    categoryId: null,
    seriesId: null,
    rollId: null,
    dueDay: null,
    dueTime: null,
    notes: null,
    estimateMin: 30,
    bufferMin: null,
    estimateLockedMin: null,
    parentId: null,
    actualAccruedMin: 0,
    startedAt: null,
    completedAt: status === 'done' ? NOW : null,
    cancelledAt: status === 'cancelled' ? NOW : null,
    gcalAccountId: null,
    gcalCalendarId: null,
    gcalEventId: null,
    gcalSyncError: null,
    ...over,
  };
}

function mkPlan(taskId: string, order: number): TaskPlan {
  return {
    id: `plan-${taskId}-${order}`,
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    taskId,
    day: TODAY,
    plannedMinutes: 30,
    order,
  };
}

const rows = (...tasks: Task[]) =>
  tasks.map((task, i) => ({ plan: mkPlan(task.id, i), task, byTime: false }));
const ids = (ts: { id: string }[]) => ts.map((t) => t.id);

describe('doneToday', () => {
  it('keeps open rows in plan order and moves done ones to the group, also in plan order', () => {
    const plan = rows(
      mkTask('a', 'done'),
      mkTask('b', 'planned'),
      mkTask('c', 'in_progress'),
      mkTask('d', 'done'),
      mkTask('e', 'backlog'),
    );
    const { open, done } = doneToday(
      plan,
      plan.map((r) => r.task),
      TODAY,
      START,
    );
    expect(open.map((r) => r.task.id)).toEqual(['b', 'c', 'e']);
    expect(ids(done)).toEqual(['a', 'd']);
  });

  it('adds tasks finished today off the plan after the plan ones, oldest first', () => {
    const plan = rows(mkTask('p', 'done'));
    const late = mkTask('late', 'done', { completedAt: NOW });
    const early = mkTask('early', 'done', { completedAt: NOW - 2 * HOUR });
    const { done } = doneToday(plan, [plan[0]!.task, late, early], TODAY, START);
    expect(ids(done)).toEqual(['p', 'early', 'late']);
  });

  it('leaves out off-plan tasks finished on another day, and open off-plan tasks', () => {
    const yesterday = mkTask('y', 'done', { completedAt: NOW - 24 * HOUR });
    const beforeDayStart = mkTask('night', 'done', {
      completedAt: new Date(2026, 5, 15, 3, 0).getTime(), // 3am belongs to yesterday (day starts 4am)
    });
    const open = mkTask('o', 'in_progress');
    const { done } = doneToday([], [yesterday, beforeDayStart, open], TODAY, START);
    expect(done).toEqual([]);
  });

  it('a done task on today’s plan counts by its row, even if it finished before day start', () => {
    const plan = rows(mkTask('n', 'done', { completedAt: new Date(2026, 5, 15, 3, 0).getTime() }));
    expect(ids(doneToday(plan, [plan[0]!.task], TODAY, START).done)).toEqual(['n']);
  });

  it('a dropped task on today’s plan is in neither list', () => {
    const plan = rows(mkTask('x', 'cancelled'), mkTask('b', 'planned'));
    const { open, done } = doneToday(
      plan,
      plan.map((r) => r.task),
      TODAY,
      START,
    );
    expect(open.map((r) => r.task.id)).toEqual(['b']);
    expect(done).toEqual([]);
  });

  it('a task with two rows today is listed once', () => {
    const t = mkTask('twice', 'done');
    const plan = [
      { plan: mkPlan('twice', 0), task: t, byTime: false },
      { plan: mkPlan('twice', 1), task: t, byTime: false },
    ];
    expect(ids(doneToday(plan, [t], TODAY, START).done)).toEqual(['twice']);
  });
});

describe('doneToday — a timed task finished today', () => {
  it('lands in Done today once, even with a legacy row today', () => {
    const t = mkTask('timed', 'done', { dueDay: TODAY, dueTime: '09:00' });
    const r = [{ task: t, plan: mkPlan('timed', 0), byTime: true }];
    expect(doneToday(r, [t], TODAY, START).done.map((x) => x.id)).toEqual(['timed']);
  });
});
