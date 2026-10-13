import { beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@aperture/shared';
import { InMemoryDoc } from './DocClient';
import { Repo } from './repo';
import { liveWrites, noopWrites } from './writes';

const U = 'user-1';
const task = (over: Partial<Task>): Task => ({
  id: 't1',
  userId: U,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  title: 'x',
  status: 'backlog',
  categoryId: null,
  dueDay: null,
  dueTime: null,
  notes: null,
  seriesId: null,
  rollId: null,
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
  ...over,
});

function repo() {
  const doc = new InMemoryDoc();
  return { doc, repo: new Repo(doc, liveWrites(doc), U) };
}

describe('Repo persistence', () => {
  let r: Repo;
  beforeEach(() => {
    ({ repo: r } = repo());
  });

  it('round-trips a task and strips key attributes from the domain object', async () => {
    await r.putTask(task({ id: 'a', title: 'hello' }));
    const got = await r.getTask('a');
    expect(got?.title).toBe('hello');
    expect(got as unknown as { PK?: string }).not.toHaveProperty('PK');
    expect(got as unknown as { SK?: string }).not.toHaveProperty('SK');
  });

  it('list filters soft-deleted rows (alive semantics)', async () => {
    await r.putTask(task({ id: 'a' }));
    await r.putTask(task({ id: 'b', deletedAt: 123 }));
    const live = await r.listTasks();
    expect(live.map((t) => t.id)).toEqual(['a']);
    expect(await r.getTask('b')).toBeNull(); // tombstoned reads as absent
  });

  it('only done tasks land in the calibration window, ordered by completion', async () => {
    await r.putTask(task({ id: 'open', status: 'in_progress' }));
    await r.putTask(task({ id: 'd1', status: 'done', completedAt: 300, estimateLockedMin: 30 }));
    await r.putTask(task({ id: 'd2', status: 'done', completedAt: 100, estimateLockedMin: 30 }));

    const window = await r.doneTasksInWindow(0, 1000);
    expect(window.map((t) => t.id)).toEqual(['d2', 'd1']); // 100 then 300
    const narrow = await r.doneTasksInWindow(200, 1000);
    expect(narrow.map((t) => t.id)).toEqual(['d1']);
  });

  it('re-completing a task that was reopened drops it from the calibration index', async () => {
    await r.putTask(task({ id: 'a', status: 'done', completedAt: 100, estimateLockedMin: 30 }));
    expect((await r.doneTasksInWindow(0, 1000)).map((t) => t.id)).toEqual(['a']);
    await r.putTask(task({ id: 'a', status: 'in_progress', completedAt: null })); // reopened
    expect(await r.doneTasksInWindow(0, 1000)).toEqual([]);
  });

  it('moving a plan to a new order does not leave the old row behind', async () => {
    const base = {
      id: 'p1',
      userId: U,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      taskId: 't1',
      day: '2026-08-04',
    };
    const atOne = { ...base, plannedMinutes: 30, order: 1 };
    await r.putPlan(atOne);
    await r.putPlan({ ...base, plannedMinutes: 30, order: 5 }, atOne);
    const plans = await r.listPlans('2026-08-04');
    expect(plans).toHaveLength(1);
    expect(plans[0]!.order).toBe(5);
  });

  it('noopWrites makes writes a no-op (the smoke-test guarantee)', async () => {
    const doc2 = new InMemoryDoc();
    const smoke = new Repo(doc2, noopWrites(), U);
    await smoke.putTask(task({ id: 'a' }));
    expect(await smoke.listTasks()).toEqual([]);
    expect(doc2.size).toBe(0);
  });

  it('habit checks read/delete by composite (date, habitId) with no scan', async () => {
    const check = {
      id: 'c1',
      userId: U,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      habitId: 'h1',
      date: '2026-08-04',
    };
    await r.putCheck(check, '2026-08-04', 'h1');
    expect((await r.getCheck('2026-08-04', 'h1'))?.id).toBe('c1');
    await r.deleteCheck('2026-08-04', 'h1');
    expect(await r.getCheck('2026-08-04', 'h1')).toBeNull();
  });
});
