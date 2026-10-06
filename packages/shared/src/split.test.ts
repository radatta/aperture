import { describe, it, expect } from 'vitest';
import {
  calibrationTasks,
  followUpPlanDay,
  followUpPlanMinutes,
  inSplitFamily,
  isCalibrationPoint,
  linksToFamily,
  rescopedPlanMinutes,
  splitFamily,
  splitFollowUp,
  splitOriginal,
  splitRoot,
} from './split';
import { ROLL_PLAN_FALLBACK_MIN } from './rolls';
import type { Task, TaskPlan } from './types';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    title: 'thing',
    status: 'in_progress',
    categoryId: 'c',
    dueDay: null,
    dueTime: null,
    notes: null,
    seriesId: null,
    rollId: null,
    estimateMin: 60,
    bufferMin: 0,
    estimateLockedMin: 60,
    splitFromId: null,
    actualAccruedMin: 20,
    startedAt: 1,
    completedAt: null,
    cancelledAt: null,
    gcalAccountId: null,
    gcalCalendarId: null,
    gcalEventId: null,
    gcalSyncError: null,
    ...over,
  };
}

function plan(taskId: string, day: string): TaskPlan {
  const base = { userId: 'u', createdAt: 0, updatedAt: 0, deletedAt: null };
  return { ...base, id: `${taskId}-${day}`, taskId, day, plannedMinutes: 30, order: 0 };
}

const followUp = { title: ' rest ', estimateMin: 40 };

describe('linksToFamily', () => {
  it('needs a frozen baseline upstream — its own lock, or its own link', () => {
    expect(linksToFamily(task())).toBe(true);
    expect(linksToFamily(task({ status: 'backlog', estimateLockedMin: null }))).toBe(false);
    expect(linksToFamily(task({ estimateLockedMin: null, splitFromId: 'root' }))).toBe(true);
  });
});

describe('family walks', () => {
  const a = task({ id: 'a', status: 'done' });
  const b = task({ id: 'b', splitFromId: 'a', estimateLockedMin: null, status: 'backlog' });
  const c = task({ id: 'c', splitFromId: 'b', status: 'done' });
  const lone = task({ id: 'x', status: 'done' });
  const all = [a, b, c, lone];

  it('walks up to the root and down to every descendant', () => {
    expect(splitRoot(all, c).id).toBe('a');
    expect(splitRoot(all, lone).id).toBe('x');
    expect(splitFamily(all, 'a').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('stops at a missing parent and survives a cycle', () => {
    expect(splitRoot([b], b).id).toBe('b');
    const p = task({ id: 'p', splitFromId: 'q' });
    const q = task({ id: 'q', splitFromId: 'p' });
    expect(['p', 'q']).toContain(splitRoot([p, q], p).id);
  });

  it('excludes every family member from calibration, but not a lone task', () => {
    expect(inSplitFamily(a, all)).toBe(true);
    expect(isCalibrationPoint(a, all)).toBe(false);
    expect(isCalibrationPoint(c, all)).toBe(false);
    expect(isCalibrationPoint(lone, all)).toBe(true);
  });

  it('calibrationTasks is isCalibrationPoint over the list, in one pass', () => {
    const legacy = task({ id: 'old', status: 'done' });
    delete (legacy as { splitFromId?: unknown }).splitFromId;
    const list = [...all, legacy, task({ id: 'open' })];
    expect(calibrationTasks(list).map((t) => t.id)).toEqual(
      list.filter((t) => isCalibrationPoint(t, list)).map((t) => t.id),
    );
    expect(calibrationTasks(list).map((t) => t.id)).toEqual(['x', 'old']);
  });

  it('reads a pre-splitFromId row (undefined) as unlinked', () => {
    const legacy = task({ id: 'old', status: 'done' });
    delete (legacy as { splitFromId?: unknown }).splitFromId;
    expect(inSplitFamily(legacy, [legacy])).toBe(false);
    expect(isCalibrationPoint(legacy, [legacy])).toBe(true);
  });
});

describe('follow-up placement', () => {
  it('lands on the latest day the original is planned on', () => {
    const plans = [plan('a', '2026-10-04'), plan('a', '2026-10-05'), plan('z', '2026-10-09')];
    expect(followUpPlanDay(plans, 'a')).toBe('2026-10-05');
    expect(followUpPlanDay(plans, 'nope')).toBeNull();
  });

  it('plans estimate + buffer, else the fallback', () => {
    expect(followUpPlanMinutes(40, 5)).toBe(45);
    expect(followUpPlanMinutes(null, null)).toBe(ROLL_PLAN_FALLBACK_MIN);
  });
});

describe('rescopedPlanMinutes', () => {
  it('a done part takes its actual; a kept-going one its new size only when rescoped', () => {
    const t = task({ estimateMin: 30, bufferMin: 5, actualAccruedMin: 40.4 });
    expect(rescopedPlanMinutes({ finish: 'keep', estimateMin: 30, followUp }, t)).toBe(35);
    expect(rescopedPlanMinutes({ finish: 'keep', followUp }, t)).toBeNull();
    expect(rescopedPlanMinutes({ finish: 'done', actualMin: 40, followUp }, t)).toBe(40);
  });
});

describe('splitOriginal', () => {
  it('done: applies the edits and the actual, then finishes — the lock never moves', () => {
    const out = splitOriginal(
      task(),
      { finish: 'done', title: ' part 1 ', estimateMin: 30, actualMin: 25, followUp },
      9,
    );
    expect(out).toMatchObject({
      status: 'done',
      title: 'part 1',
      estimateMin: 30,
      estimateLockedMin: 60,
      actualAccruedMin: 25,
      completedAt: 9,
    });
  });

  it('keep: the status stays, the edits apply, and omitted fields are kept', () => {
    const out = splitOriginal(
      task({ bufferMin: 5 }),
      { finish: 'keep', estimateMin: 30, followUp },
      9,
    );
    expect(out).toMatchObject({
      status: 'in_progress',
      title: 'thing',
      estimateMin: 30,
      bufferMin: 5,
    });
  });

  it('rejects before any write: finished task, unstarted done, empty titles', () => {
    expect(() =>
      splitOriginal(task({ status: 'done' }), { finish: 'keep', followUp }, 1),
    ).toThrow();
    expect(() =>
      splitOriginal(task({ status: 'backlog' }), { finish: 'done', followUp }, 1),
    ).toThrow(/started/);
    expect(() =>
      splitOriginal(task(), { finish: 'keep', followUp: { title: ' ', estimateMin: null } }, 1),
    ).toThrow(/Follow-up title/);
    expect(() => splitOriginal(task(), { finish: 'keep', title: '  ', followUp }, 1)).toThrow();
  });
});

describe('splitFollowUp', () => {
  it('a fresh unlocked task carrying category, due, notes and roll, linked when started', () => {
    const f = splitFollowUp(
      task({ dueDay: '2026-10-09', dueTime: '17:00', notes: 'ctx', rollId: 'r' }),
      followUp,
      true,
    );
    expect(f).toMatchObject({
      title: 'rest',
      status: 'planned',
      estimateMin: 40,
      bufferMin: null,
      estimateLockedMin: null,
      splitFromId: 't1',
      categoryId: 'c',
      dueDay: '2026-10-09',
      dueTime: '17:00',
      notes: 'ctx',
      rollId: 'r',
      gcalEventId: null,
    });
  });

  it('an unstarted original makes an independent backlog task; legacy notes read null', () => {
    const legacy = task({ status: 'backlog', estimateLockedMin: null });
    delete (legacy as { notes?: unknown }).notes;
    const f = splitFollowUp(legacy, followUp, false);
    expect(f.status).toBe('backlog');
    expect(f.splitFromId).toBeNull();
    expect(f.notes).toBeNull();
  });
});
