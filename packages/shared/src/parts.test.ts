import { describe, expect, it } from 'vitest';
import {
  assertCanBePart,
  assertParentCompletable,
  becomeParent,
  calibrationTasks,
  cancelParent,
  completeParent,
  deadlineOf,
  freezeParentLock,
  hasParts,
  parentOf,
  partIndex,
  partOpenError,
  partsOf,
  partsSummary,
} from './parts';
import type { Task } from './types';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't',
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    title: 'thing',
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
  };
}

const P = task({ id: 'p', title: 'P2', dueDay: '2026-10-13', dueTime: '23:59' });
const part = (id: string, over: Partial<Task> = {}) =>
  task({ id, title: id, parentId: 'p', createdAt: Number(id.slice(1)) || 0, ...over });

describe('lookups', () => {
  it('partsOf lists a parent’s parts oldest first; hasParts and parentOf follow the link', () => {
    const b = part('a2');
    const a = part('a1');
    const all = [P, b, a, task({ id: 'x' })];
    expect(partsOf(all, 'p').map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(hasParts(all, 'p')).toBe(true);
    expect(hasParts(all, 'x')).toBe(false);
    expect(parentOf(all, a)?.id).toBe('p');
    expect(parentOf(all, P)).toBeUndefined();
    expect(partIndex(b, partsOf(all, 'p'))).toBe(2);
    expect(partIndex(P, partsOf(all, 'p'))).toBe(0);
  });
});

describe('partsSummary', () => {
  it('counts done of the parts not dropped, sums their estimates and logged time', () => {
    const s = partsSummary([
      part('a1', { status: 'done', estimateMin: 45, actualAccruedMin: 50 }),
      part('a2', { status: 'in_progress', estimateMin: 60, actualAccruedMin: 10 }),
      part('a3', { estimateMin: null }),
      part('a4', { status: 'cancelled', estimateMin: 90, actualAccruedMin: 5 }),
    ]);
    expect(s).toMatchObject({ total: 3, done: 1, estimateMin: 105, unscoped: 1, actualMin: 60 });
    expect(s.open.map((t) => t.id)).toEqual(['a2', 'a3']);
    expect(s.allDone).toBe(false);
  });

  it('allDone once nothing kept is open; never for no parts; no estimate reads null', () => {
    expect(
      partsSummary([part('a1', { status: 'done' }), part('a2', { status: 'cancelled' })]),
    ).toMatchObject({ allDone: true, total: 1, done: 1, estimateMin: null });
    expect(partsSummary([]).allDone).toBe(false);
    expect(partsSummary([part('a1', { status: 'cancelled' })]).allDone).toBe(false);
  });
});

describe('marking a parent done', () => {
  it('is a hard block naming every open part', () => {
    expect(partOpenError([{ title: 'Part 3' }])).toBe(
      'Part 3 isn’t finished — complete, drop or delete it first',
    );
    expect(partOpenError([{ title: 'A' }, { title: 'B' }, { title: 'C' }])).toBe(
      'A, B and C aren’t finished — complete, drop or delete them first',
    );
    const parts = [part('a1', { status: 'done' }), part('a2', { title: 'Part 2' })];
    expect(() => assertParentCompletable(P, parts)).toThrow(/^Part 2 isn’t finished/);
    expect(() => completeParent(P, parts, 9)).toThrow(/Part 2/);
  });

  it('goes straight to done, stamping what its done parts took; the lock is untouched', () => {
    const parent = { ...P, estimateLockedMin: 180 };
    const out = completeParent(
      parent,
      [
        part('a1', { status: 'done', actualAccruedMin: 50 }),
        part('a2', { status: 'done', actualAccruedMin: 70.5 }),
        part('a3', { status: 'cancelled', actualAccruedMin: 12 }),
      ],
      9,
    );
    expect(out).toMatchObject({
      status: 'done',
      completedAt: 9,
      actualAccruedMin: 120.5,
      estimateLockedMin: 180,
    });
  });

  it('refuses an already finished parent', () => {
    expect(() => completeParent({ ...P, status: 'cancelled' }, [], 1)).toThrow(/already/);
  });
});

describe('cancelParent', () => {
  it('drops the parent and its open parts; done and dropped parts are left as they are', () => {
    const { parent, parts } = cancelParent(
      P,
      [
        part('a1', { status: 'done' }),
        part('a2', { status: 'in_progress' }),
        part('a3', { status: 'planned' }),
        part('a4', { status: 'cancelled' }),
      ],
      9,
    );
    expect(parent).toMatchObject({ status: 'cancelled', cancelledAt: 9 });
    expect(parts.map((t) => [t.id, t.status])).toEqual([
      ['a2', 'cancelled'],
      ['a3', 'cancelled'],
    ]);
  });
});

describe('freezeParentLock', () => {
  it('nothing to freeze until a part leaves planning', () => {
    expect(freezeParentLock(P, [part('a1', { estimateMin: 30 })], 1)).toBeNull();
  });

  it('freezes Σ parts (lock, else working estimate) over the parts not dropped, once', () => {
    const parts = [
      part('a1', { status: 'in_progress', startedAt: 5, estimateMin: 40, estimateLockedMin: 45 }),
      part('a2', { estimateMin: 60 }),
      part('a3', { estimateMin: null }),
      part('a4', { status: 'cancelled', estimateMin: 90 }),
    ];
    const out = freezeParentLock(P, parts, 9);
    expect(out).toMatchObject({ estimateLockedMin: 105, updatedAt: 9 });
    expect(freezeParentLock(out!, parts, 10)).toBeNull();
  });

  it('a started task attached later freezes it too; nothing scoped writes nothing', () => {
    expect(freezeParentLock(P, [part('a1', { estimateLockedMin: 20 })], 1)).toMatchObject({
      estimateLockedMin: 20,
    });
    expect(freezeParentLock(P, [part('a1', { startedAt: 3 })], 1)).toBeNull();
  });

  it('a split’s parent already carries the original’s lock', () => {
    expect(
      freezeParentLock({ ...P, estimateLockedMin: 60 }, [part('a1', { startedAt: 1 })], 1),
    ).toBeNull();
  });
});

describe('becomeParent', () => {
  it('clears its estimate and leaves its plan', () => {
    expect(
      becomeParent(task({ status: 'planned', estimateMin: 60, bufferMin: 10 }), 3),
    ).toMatchObject({ status: 'backlog', estimateMin: null, bufferMin: null, updatedAt: 3 });
    expect(becomeParent(task({ status: 'backlog' }), 3).status).toBe('backlog');
  });
});

describe('assertCanBePart', () => {
  it('one level, both ways', () => {
    const a1 = part('a1');
    const all = [P, a1, task({ id: 'x' })];
    expect(() => assertCanBePart(null, a1, all)).toThrow(/one level/);
    expect(() => assertCanBePart(P, task({ id: 'x' }), all)).toThrow(/one level/);
    expect(() => assertCanBePart(task({ id: 'x' }), P, all)).not.toThrow();
    expect(() => assertCanBePart(null, P, all)).not.toThrow();
  });

  it('not itself, not a finished parent, not a task already worked on', () => {
    const x = task({ id: 'x' });
    expect(() => assertCanBePart(x, x, [x])).toThrow(/itself/);
    expect(() => assertCanBePart(null, { ...x, status: 'done' }, [x])).toThrow(/done/);
    expect(() => assertCanBePart(null, { ...x, status: 'in_progress' }, [x])).toThrow(/split/);
    expect(() => assertCanBePart(null, { ...x, startedAt: 1 }, [x])).toThrow(/split/);
    expect(() => assertCanBePart(null, { ...x, actualAccruedMin: 5 }, [x])).toThrow(/split/);
  });

  it('an existing parent with history (a split’s) still takes more parts', () => {
    const parent = task({ id: 'p', estimateLockedMin: 60 });
    expect(() => assertCanBePart(null, parent, [parent, part('a1')])).not.toThrow();
  });
});

describe('deadlineOf', () => {
  it('a part answers to its parent’s deadline; anything else to its own', () => {
    const a1 = part('a1', { dueDay: '2026-10-12', dueTime: '15:00' });
    expect(deadlineOf(a1, [P, a1])).toEqual({
      dueDay: '2026-10-13',
      dueTime: '23:59',
      status: 'backlog',
    });
    expect(deadlineOf(P, [P, a1])).toMatchObject({ dueDay: '2026-10-13', dueTime: '23:59' });
    const orphan = part('a2', { parentId: 'gone', dueDay: '2026-10-01' });
    expect(deadlineOf(orphan, [orphan]).dueDay).toBe('2026-10-01');
  });
});

describe('calibrationTasks', () => {
  it('every done, locked task is a point — parts and a done parent alike', () => {
    const list = [
      part('a1', { status: 'done', estimateLockedMin: 45 }),
      { ...P, status: 'done' as const, estimateLockedMin: 180 },
      task({ id: 'open', estimateLockedMin: 30 }),
      task({ id: 'nolock', status: 'done' }),
    ];
    expect(calibrationTasks(list).map((t) => t.id)).toEqual(['a1', 'p']);
  });
});
