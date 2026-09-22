import { describe, it, expect } from 'vitest';
import { findOpenRollTask, repDays, rollRepFields } from './rolls';
import type { Roll, Task } from './types';

function baseRoll(over: Partial<Roll> = {}): Roll {
  return {
    id: 'r1',
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    name: 'LeetCode daily',
    categoryId: 'c-learn',
    estimateMin: 30,
    active: true,
    ...over,
  };
}

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    title: 'thing',
    status: 'done',
    categoryId: null,
    seriesId: null,
    rollId: 'r1',
    dueDay: null,
    estimateMin: 30,
    bufferMin: null,
    estimateLockedMin: 30,
    actualAccruedMin: 25,
    startedAt: null,
    completedAt: 1_700_000_000_000,
    cancelledAt: null,
    gcalAccountId: null,
    gcalCalendarId: null,
    gcalEventId: null,
    ...over,
  };
}

describe('rollRepFields', () => {
  it('produces a planned, unlocked task carrying the roll name/category/estimate', () => {
    const f = rollRepFields(baseRoll());
    expect(f.title).toBe('LeetCode daily');
    expect(f.status).toBe('planned');
    expect(f.categoryId).toBe('c-learn');
    expect(f.estimateMin).toBe(30);
    expect(f.rollId).toBe('r1');
    expect(f.estimateLockedMin).toBeNull(); // unlocked — the estimate freezes when work starts
    expect(f.seriesId).toBeNull(); // a Roll is not a recurring series
    expect(f.dueDay).toBeNull(); // deadline-free
  });

  it('carries a null estimate through (the plan applies its own fallback)', () => {
    expect(rollRepFields(baseRoll({ estimateMin: null })).estimateMin).toBeNull();
  });
});

describe('findOpenRollTask', () => {
  it('returns a live rep and ignores done/cancelled ones', () => {
    const done = baseTask({ id: 'd', status: 'done' });
    const cancelled = baseTask({ id: 'x', status: 'cancelled' });
    const planned = baseTask({ id: 'p', status: 'planned' });
    expect(findOpenRollTask([done, cancelled, planned], 'r1')?.id).toBe('p');
  });

  it('ignores tasks tagged with other rolls (or untagged)', () => {
    const other = baseTask({ id: 'o', status: 'planned', rollId: 'r2' });
    const untagged = baseTask({ id: 'u', status: 'planned', rollId: null });
    expect(findOpenRollTask([other, untagged], 'r1')).toBeUndefined();
  });

  it('finds in_progress and backlog reps', () => {
    expect(findOpenRollTask([baseTask({ status: 'in_progress' })], 'r1')?.id).toBe('t1');
    expect(findOpenRollTask([baseTask({ status: 'backlog' })], 'r1')?.id).toBe('t1');
  });
});

describe('repDays', () => {
  const dayStart = 4;
  // 2023-11-14T22:13:20Z — well after 4am, so it buckets on the 14th.
  const nov14 = 1_700_000_000_000;
  const day = 86_400_000;

  it('counts done reps per completion day, and two in a day count 2', () => {
    const tasks = [
      baseTask({ id: 'a', completedAt: nov14 }),
      baseTask({ id: 'b', completedAt: nov14 + 60_000 }), // same day, second problem
      baseTask({ id: 'c', completedAt: nov14 + day }), // next day
    ];
    const m = repDays(tasks, 'r1', dayStart);
    expect(m.get('2023-11-14')).toBe(2);
    expect(m.get('2023-11-15')).toBe(1);
  });

  it('ignores non-done, other-roll, untagged, and completedAt-less tasks', () => {
    const tasks = [
      baseTask({ id: 'a', completedAt: nov14 }), // counts
      baseTask({ id: 'b', status: 'in_progress', completedAt: null }),
      baseTask({ id: 'c', status: 'cancelled', completedAt: nov14 }),
      baseTask({ id: 'd', rollId: 'r2', completedAt: nov14 }),
      baseTask({ id: 'e', rollId: null, completedAt: nov14 }),
    ];
    const m = repDays(tasks, 'r1', dayStart);
    expect(m.get('2023-11-14')).toBe(1);
    expect(m.size).toBe(1);
  });

  it('is empty when there are no reps', () => {
    expect(repDays([], 'r1', dayStart).size).toBe(0);
  });
});
