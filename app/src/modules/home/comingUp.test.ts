import { describe, expect, it } from 'vitest';
import { addDays } from '@aperture/shared';
import type { Task, TaskStatus } from '@aperture/shared';
import { comingUp, RADAR_CAP } from './comingUp';

const TODAY = '2026-06-15';

function mkTask(id: string, dueOffset: number | null, status: TaskStatus = 'backlog'): Task {
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
    dueDay: dueOffset === null ? null : addDays(TODAY, dueOffset),
    notes: null,
    estimateMin: null,
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

describe('comingUp', () => {
  it('shows soonest-due first with overdue leading, capped', () => {
    const cu = comingUp(
      [mkTask('far', 10), mkTask('overdue', -2), mkTask('today', 0), mkTask('soon', 1), mkTask('mid', 4)],
      TODAY,
      new Set(),
    );
    expect(cu.items.map((t) => t.id)).toEqual(['overdue', 'today', 'soon']);
    expect(cu.items.length).toBe(RADAR_CAP);
  });

  it('excludes undated, done, cancelled, and excluded ids', () => {
    const cu = comingUp(
      [mkTask('undated', null), mkTask('done', 1, 'done'), mkTask('cancelled', 1, 'cancelled'), mkTask('planned-today', 1), mkTask('keep', 2)],
      TODAY,
      new Set(['planned-today']),
    );
    expect(cu.items.map((t) => t.id)).toEqual(['keep']);
  });

  it('counts the overflow split into this-week vs later', () => {
    const cu = comingUp(
      [mkTask('a', 0), mkTask('b', 1), mkTask('c', 2), mkTask('d', 5), mkTask('e', 6), mkTask('f', 20)],
      TODAY,
      new Set(),
    );
    expect(cu.items.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(cu.moreThisWeek).toBe(2); // d(+5), e(+6)
    expect(cu.moreLater).toBe(1); // f(+20)
  });

  it('does not mutate its input', () => {
    const input = [mkTask('a', 3), mkTask('b', 1)];
    const before = input.map((t) => t.id);
    comingUp(input, TODAY, new Set());
    expect(input.map((t) => t.id)).toEqual(before);
  });
});
