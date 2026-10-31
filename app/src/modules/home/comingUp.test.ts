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
    dueTime: null,
    notes: null,
    estimateMin: null,
    bufferMin: null,
    estimateLockedMin: null,
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

describe('comingUp', () => {
  it('shows soonest-due first with overdue leading, capped', () => {
    const cu = comingUp(
      [mkTask('far', 10), mkTask('overdue', -2), mkTask('today', 0), mkTask('soon', 1), mkTask('mid', 4)],
      TODAY,
      new Set(),
      4,
    );
    expect(cu.items.map((t) => t.id)).toEqual(['overdue', 'today', 'soon']);
    expect(cu.items.length).toBe(RADAR_CAP);
  });

  it('excludes undated, done, cancelled, and excluded ids', () => {
    const cu = comingUp(
      [mkTask('undated', null), mkTask('done', 1, 'done'), mkTask('cancelled', 1, 'cancelled'), mkTask('planned-today', 1), mkTask('keep', 2)],
      TODAY,
      new Set(['planned-today']),
      4,
    );
    expect(cu.items.map((t) => t.id)).toEqual(['keep']);
  });

  it('leaves parts off the radar — the deadline is the parent’s, which is on it', () => {
    const part = { ...mkTask('part', 1), parentId: 'parent' };
    const cu = comingUp([mkTask('parent', 3), part], TODAY, new Set(), 4);
    expect(cu.items.map((t) => t.id)).toEqual(['parent']);
  });

  it('counts the overflow split into this-week vs later', () => {
    const cu = comingUp(
      [mkTask('a', 0), mkTask('b', 1), mkTask('c', 2), mkTask('d', 5), mkTask('e', 6), mkTask('f', 20)],
      TODAY,
      new Set(),
      4,
    );
    expect(cu.items.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(cu.moreThisWeek).toBe(2); // d(+5), e(+6)
    expect(cu.moreLater).toBe(1); // f(+20)
  });

  it('does not mutate its input', () => {
    const input = [mkTask('a', 3), mkTask('b', 1)];
    const before = input.map((t) => t.id);
    comingUp(input, TODAY, new Set(), 4);
    expect(input.map((t) => t.id)).toEqual(before);
  });

  it('a timed task due today+7 at 00:30 is this week’s — its deadline’s app day is today+6', () => {
    const night = { ...mkTask('night', 7), dueTime: '00:30' };
    const fill = [mkTask('a', 0), mkTask('b', 1), mkTask('c', 2)];
    const cu = comingUp([...fill, night], TODAY, new Set(), 4);
    expect(cu).toMatchObject({ moreThisWeek: 1, moreLater: 0 });
    expect(comingUp([...fill, night], TODAY, new Set(), 0)).toMatchObject({ moreLater: 1 });
  });
});
