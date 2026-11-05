import { describe, expect, it } from 'vitest';
import type { PomodoroSession, Task, TaskPlan, TaskStatus } from '@aperture/shared';
import type { RunningTimer } from '../pomodoro/pomodoro-context';
import { FOCUS_CAP, liveElapsedMin, promote, rightNow } from './rightNow';

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
    place: null,
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

function mkPlan(taskId: string, order: number): TaskPlan {
  return {
    id: `plan-${taskId}`,
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    taskId,
    day: '2026-06-15',
    plannedMinutes: 30,
    order,
  };
}

function rows(...tasks: Task[]) {
  return tasks.map((task, i) => ({ plan: mkPlan(task.id, i), task, byTime: false }));
}

function mkTimer(taskId: string | null, kind: 'work' | 'break', activeSec: number): RunningTimer {
  const session = { id: `s-${taskId}-${kind}`, taskId, kind } as unknown as PomodoroSession;
  return {
    session,
    paused: false,
    remaining: 60,
    done: false,
    activeSec,
    error: null,
    syncFailed: false,
  };
}

describe('rightNow', () => {
  it('splits the plan into Big 3 + Also-today by order', () => {
    const rn = rightNow(
      rows(
        mkTask('a', 'planned'),
        mkTask('b', 'planned'),
        mkTask('c', 'planned'),
        mkTask('d', 'planned'),
        mkTask('e', 'planned'),
      ),
      [],
    );
    expect(rn.focus.map((r) => r.task.id)).toEqual(['a', 'b', 'c']);
    expect(rn.alsoToday.map((r) => r.task.id)).toEqual(['d', 'e']);
    expect(rn.focus.length).toBe(FOCUS_CAP);
  });

  it('keeps a done task in its Focus slot — no promotion of #4', () => {
    const rn = rightNow(
      rows(
        mkTask('a', 'done'),
        mkTask('b', 'planned'),
        mkTask('c', 'planned'),
        mkTask('d', 'planned'),
      ),
      [],
    );
    expect(rn.focus.map((r) => r.task.id)).toEqual(['a', 'b', 'c']);
    expect(rn.alsoToday.map((r) => r.task.id)).toEqual(['d']);
    expect(rn.focusDoneCount).toBe(1);
  });

  it('drops cancelled tasks from the plane', () => {
    const rn = rightNow(
      rows(
        mkTask('a', 'cancelled'),
        mkTask('b', 'planned'),
        mkTask('c', 'planned'),
        mkTask('d', 'planned'),
      ),
      [],
    );
    expect(rn.focus.map((r) => r.task.id)).toEqual(['b', 'c', 'd']);
    expect(rn.alsoToday).toEqual([]);
  });

  it('surfaces an in-progress task not on the plan in Also-today, flagged unplanned', () => {
    const off = mkTask('x', 'in_progress');
    const rn = rightNow(rows(mkTask('a', 'planned')), [mkTask('a', 'planned'), off]);
    expect(rn.alsoToday).toEqual([{ plan: null, task: off, unplanned: true }]);
  });

  it('heroes the in-progress Big-3 task, preferring focus over off-plan', () => {
    const rn = rightNow(
      rows(mkTask('a', 'planned'), mkTask('b', 'in_progress'), mkTask('c', 'planned')),
      [mkTask('b', 'in_progress'), mkTask('z', 'in_progress')],
    );
    expect(rn.hero?.id).toBe('b');
  });

  it('falls back to an off-plan in-progress task for the hero', () => {
    const off = mkTask('z', 'in_progress');
    const rn = rightNow(rows(mkTask('a', 'planned')), [mkTask('a', 'planned'), off]);
    expect(rn.hero?.id).toBe('z');
  });

  it('has no hero when nothing is in progress', () => {
    const rn = rightNow(rows(mkTask('a', 'planned'), mkTask('b', 'planned')), []);
    expect(rn.hero).toBeNull();
  });

  it('derives the next-prompt matrix (no auto-advance)', () => {
    const pick = rightNow(rows(mkTask('a', 'planned'), mkTask('b', 'planned')), []);
    expect(pick.nextPrompt).toBe('pick');

    const next = rightNow(rows(mkTask('a', 'done'), mkTask('b', 'planned')), []);
    expect(next.nextPrompt).toBe('next');

    const allDone = rightNow(rows(mkTask('a', 'done'), mkTask('b', 'done')), []);
    expect(allDone.nextPrompt).toBe('all-done');

    const empty = rightNow([], []);
    expect(empty.nextPrompt).toBeNull();

    const running = rightNow(rows(mkTask('a', 'in_progress')), [mkTask('a', 'in_progress')]);
    expect(running.nextPrompt).toBeNull();
  });
});

describe('liveElapsedMin', () => {
  it('adds only this task’s running work timers to the accrued minutes', () => {
    const task = mkTask('a', 'in_progress', { actualAccruedMin: 12 });
    const timers = [
      mkTimer('a', 'work', 180), // +3m
      mkTimer('a', 'break', 600), // ignored (break)
      mkTimer('b', 'work', 999), // ignored (other task)
    ];
    expect(liveElapsedMin(task, timers)).toBeCloseTo(15, 5);
  });

  it('is just the accrued minutes when no timer runs', () => {
    expect(liveElapsedMin(mkTask('a', 'in_progress', { actualAccruedMin: 8 }), [])).toBe(8);
  });
});

describe('promote', () => {
  it('moves an Also-today row into the last Focus slot and renumbers', () => {
    const r = rows(
      mkTask('a', 'planned'),
      mkTask('b', 'planned'),
      mkTask('c', 'planned'),
      mkTask('d', 'planned'),
      mkTask('e', 'planned'),
    );
    const ups = promote(r, 'e'); // e is at index 4 → goes to index 2
    // c (2→3), d (3→4), e (4→2) change; a,b keep 0,1.
    const byTask = Object.fromEntries(ups.map((u) => [u.taskId, u.order]));
    expect(byTask).toEqual({ e: 2, c: 3, d: 4 });
  });

  it('returns nothing when the task is already in Focus or missing', () => {
    const r = rows(
      mkTask('a', 'planned'),
      mkTask('b', 'planned'),
      mkTask('c', 'planned'),
      mkTask('d', 'planned'),
    );
    expect(promote(r, 'b')).toEqual([]); // already focus
    expect(promote(r, 'zzz')).toEqual([]); // missing
  });
});

describe('rightNow — option 3 (a time decides the day)', () => {
  const byTime = (task: Task) => ({ task, plan: null, byTime: true });

  it('the Big 3 are the chosen plan; timed rows are their own tier, by clock, never a focus', () => {
    const t = mkTask('timed', 'backlog', { dueTime: '09:00' });
    const a = mkTask('a', 'planned');
    const rn = rightNow([byTime(t), ...rows(a)], [t, a]);
    expect(rn.focus.map((r) => r.task.id)).toEqual(['a']);
    expect(rn.byTime.map((r) => r.task.id)).toEqual(['timed']);
    expect(rn.alsoToday).toEqual([]);
  });

  it('promote moves only plan rows — a timed row has no slot to take', () => {
    const [p0, p1, p2, p3] = ['0', '1', '2', '3'].map((id) => mkTask(id, 'planned'));
    const t = mkTask('t', 'backlog', { dueTime: '09:00' });
    const r = [byTime(t), ...rows(p0!, p1!, p2!, p3!)];
    expect(promote(r, 't')).toEqual([]);
    expect(promote(r, '3').map((u) => u.taskId)).toEqual(['3', '2']);
  });

  it('a started timed task is the hero when no focus is running', () => {
    const t = mkTask('t', 'in_progress', { dueTime: '09:00' });
    const a = mkTask('a', 'planned');
    expect(rightNow([byTime(t), ...rows(a)], [t, a]).hero?.id).toBe('t');
  });
});
