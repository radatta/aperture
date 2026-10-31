import { describe, expect, it } from 'vitest';
import { addDays, dayKey } from '@aperture/shared';
import type { Task, TaskPlan, TaskStatus } from '@aperture/shared';
import { rowMinutes, todayRows } from './todayRows';

const START = 4;
const NOW = new Date(2026, 5, 15, 14, 0).getTime();
const TODAY = dayKey(NOW, START);

const mkTask = (id: string, status: TaskStatus = 'backlog', over: Partial<Task> = {}): Task =>
  ({
    id,
    title: id,
    status,
    createdAt: 0,
    dueDay: null,
    dueTime: null,
    parentId: null,
    estimateMin: null,
    bufferMin: null,
    completedAt: status === 'done' ? NOW : null,
    ...over,
  }) as Task;
const mkPlan = (taskId: string, order: number, plannedMinutes = 30, day = TODAY): TaskPlan =>
  ({ id: `p-${taskId}-${day}`, taskId, day, plannedMinutes, order }) as TaskPlan;
const timedAt = (id: string, dueTime: string, over: Partial<Task> = {}) =>
  mkTask(id, 'backlog', { dueDay: TODAY, dueTime, ...over });

describe('todayRows', () => {
  it('timed tasks due today come first, by clock; then the plan in its order', () => {
    const tasks = [
      timedAt('t15', '15:00'),
      mkTask('p1', 'planned'),
      timedAt('t09', '09:00'),
      mkTask('p0', 'planned'),
    ];
    const rows = todayRows([mkPlan('p0', 0), mkPlan('p1', 1)], tasks, TODAY, START);
    expect(rows.map((r) => [r.task.id, r.byTime])).toEqual([
      ['t09', true],
      ['t15', true],
      ['p0', false],
      ['p1', false],
    ]);
  });

  it('a legacy row on a timed task due today shows it once, by time, carrying the row’s minutes', () => {
    const t = timedAt('t', '10:00');
    const rows = todayRows([mkPlan('t', 0, 75)], [t], TODAY, START);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ byTime: true, plan: { plannedMinutes: 75 } });
    expect(rowMinutes(rows[0]!)).toBe(75);
  });

  it('a timed task due another day is not on today, even with a row today', () => {
    const t = mkTask('t', 'planned', { dueDay: addDays(TODAY, 1), dueTime: '10:00' });
    expect(todayRows([mkPlan('t', 0)], [t], TODAY, START)).toEqual([]);
  });

  it('a deadline before day start is tonight’s — after 23:00, by instant; 04:00 is tomorrow’s', () => {
    const tomorrow = addDays(TODAY, 1);
    const late = timedAt('late', '23:00');
    const night = mkTask('night', 'backlog', { dueDay: tomorrow, dueTime: '00:30' });
    const next = mkTask('next', 'backlog', { dueDay: tomorrow, dueTime: '04:00' });
    expect(todayRows([], [night, next, late], TODAY, START).map((r) => r.task.id)).toEqual([
      'late',
      'night',
    ]);
    expect(todayRows([], [night], TODAY, 0)).toEqual([]);
  });

  it('a timed parent is never a row — its deadline is its marker', () => {
    const p = timedAt('p', '23:59');
    const part = mkTask('a', 'backlog', { parentId: 'p' });
    expect(todayRows([], [p, part], TODAY, START)).toEqual([]);
  });

  it('a timed task finished today stays (capacity counts it); one finished before today is gone', () => {
    const doneToday = timedAt('d1', '09:00', { status: 'done', completedAt: NOW });
    const doneBefore = timedAt('d0', '09:00', {
      status: 'done',
      completedAt: NOW - 3 * 86_400_000,
    });
    const dropped = timedAt('x', '09:00', { status: 'cancelled' });
    const rows = todayRows([], [doneToday, doneBefore, dropped], TODAY, START);
    expect(rows.map((r) => r.task.id)).toEqual(['d1']);
  });

  it('rowMinutes: a plan row’s minutes, else the block’s length (estimate + buffer, else 30)', () => {
    expect(rowMinutes({ task: timedAt('a', '9:00'), plan: null, byTime: true })).toBe(30);
    const scoped = timedAt('b', '9:00', { estimateMin: 40, bufferMin: 10 });
    expect(rowMinutes({ task: scoped, plan: null, byTime: true })).toBe(50);
  });
});
