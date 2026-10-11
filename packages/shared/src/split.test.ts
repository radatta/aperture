import { describe, it, expect } from 'vitest';
import {
  STANDALONE_PART_TITLE,
  followUpPlanDay,
  followUpPlanMinutes,
  newParentFrom,
  rescopedPlanMinutes,
  splitFollowUp,
  splitOriginal,
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
    parentId: null,
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
      true,
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
      false,
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
      splitOriginal(task({ status: 'done' }), { finish: 'keep', followUp }, 1, false),
    ).toThrow();
    expect(() =>
      splitOriginal(task({ status: 'backlog' }), { finish: 'done', followUp }, 1, false),
    ).toThrow(/started/);
    expect(() =>
      splitOriginal(
        task(),
        { finish: 'keep', followUp: { title: ' ', estimateMin: null } },
        1,
        false,
      ),
    ).toThrow(/Follow-up title/);
    expect(() =>
      splitOriginal(task(), { finish: 'keep', title: '  ', followUp }, 1, false),
    ).toThrow();
    expect(() =>
      splitOriginal(task(), { finish: 'keep', parentTitle: ' ', followUp }, 1, true),
    ).toThrow(/Parent title/);
    // A part's parent already exists — there's no new one to title.
    expect(() =>
      splitOriginal(task(), { finish: 'keep', parentTitle: 'P', followUp }, 1, false),
    ).toThrow(/already has its title/);
  });

  it('a standalone original becomes Part 1 unless a title is typed; a part keeps its title', () => {
    expect(splitOriginal(task(), { finish: 'keep', followUp }, 1, true).title).toBe(
      STANDALONE_PART_TITLE,
    );
    expect(
      splitOriginal(task(), { finish: 'keep', title: ' read ', followUp }, 1, true).title,
    ).toBe('read');
    expect(splitOriginal(task(), { finish: 'keep', followUp }, 1, false).title).toBe('thing');
  });

  it('an untimed standalone original’s day is the parent’s deadline, so Part 1 drops it', () => {
    const untimed = task({ dueDay: '2026-10-13' });
    expect(splitOriginal(untimed, { finish: 'keep', followUp }, 1, true).dueDay).toBeNull();
    // A timed one keeps its time (its block's end); a part's own untimed day is its own.
    const timed = task({ dueDay: '2026-10-13', dueTime: '17:00' });
    expect(splitOriginal(timed, { finish: 'keep', followUp }, 1, true)).toMatchObject({
      dueDay: '2026-10-13',
      dueTime: '17:00',
    });
    expect(splitOriginal(untimed, { finish: 'keep', followUp }, 1, false).dueDay).toBe(
      '2026-10-13',
    );
  });
});

describe('newParentFrom', () => {
  it('takes the title, category, deadline, notes and lock — no estimate, roll, plan or event', () => {
    const a = task({
      dueDay: '2026-10-09',
      dueTime: '17:00',
      notes: 'ctx',
      rollId: 'r',
      seriesId: 's',
      gcalEventId: 'ev',
    });
    expect(newParentFrom(a, { finish: 'keep', followUp })).toMatchObject({
      title: 'thing',
      status: 'backlog',
      categoryId: 'c',
      dueDay: '2026-10-09',
      dueTime: '17:00',
      notes: 'ctx',
      estimateMin: null,
      bufferMin: null,
      estimateLockedMin: 60,
      actualAccruedMin: 0,
      parentId: null,
      rollId: null,
      seriesId: null,
      gcalEventId: null,
    });
  });

  it('a typed parent title wins; an unstarted original gives an unlocked parent', () => {
    const p = newParentFrom(task({ status: 'backlog', estimateLockedMin: null }), {
      finish: 'keep',
      parentTitle: ' The essay ',
      followUp,
    });
    expect(p.title).toBe('The essay');
    expect(p.estimateLockedMin).toBeNull();
  });
});

describe('splitFollowUp', () => {
  it('a fresh unlocked part of the parent carrying category, time, notes and roll', () => {
    const f = splitFollowUp(
      task({ dueDay: '2026-10-09', dueTime: '17:00', notes: 'ctx', rollId: 'r' }),
      followUp,
      true,
      'p1',
    );
    expect(f).toMatchObject({
      title: 'rest',
      status: 'planned',
      estimateMin: 40,
      bufferMin: null,
      estimateLockedMin: null,
      parentId: 'p1',
      categoryId: 'c',
      dueDay: '2026-10-09',
      dueTime: '17:00',
      notes: 'ctx',
      rollId: 'r',
      gcalEventId: null,
    });
  });

  it('never inherits an untimed day — that’s a deadline or the original part’s own', () => {
    expect(splitFollowUp(task({ dueDay: '2026-10-13' }), followUp, false, 'p1').dueDay).toBeNull();
  });

  it('an unplanned original makes a backlog part; legacy notes read null', () => {
    const legacy = task({ status: 'backlog', estimateLockedMin: null });
    delete (legacy as { notes?: unknown }).notes;
    const f = splitFollowUp(legacy, followUp, false, 'p1');
    expect(f.status).toBe('backlog');
    expect(f.parentId).toBe('p1');
    expect(f.notes).toBeNull();
  });
});
