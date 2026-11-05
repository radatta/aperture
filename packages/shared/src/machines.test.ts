import { describe, it, expect } from 'vitest';
import {
  accruesTime,
  canTransitionTask,
  contributesCalibration,
  heartbeatSession,
  isTimed,
  placedByTime,
  timedDay,
  resolveStaleSession,
  resumeSession,
  stalePlannedMoves,
  taskTransition,
  withEstimate,
} from './machines';
import type { PomodoroSession, Task, TaskPlan } from './types';

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    title: 'thing',
    status: 'planned',
    categoryId: null,
    dueDay: null,
    dueTime: null,
    notes: null,
    reflection: null,
    seriesId: null,
    rollId: null,
    estimateMin: 60,
    bufferMin: 15,
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

describe('taskTransition — estimate freeze', () => {
  it('locks the estimate and stamps startedAt on first exit from planning', () => {
    const started = taskTransition(baseTask(), 'in_progress', 1000);
    expect(started.estimateLockedMin).toBe(60);
    expect(started.startedAt).toBe(1000);
  });

  it('a started task takes a new working estimate, and the lock never moves', () => {
    const started = taskTransition(baseTask(), 'in_progress', 1000);
    const rescoped = withEstimate(started, 120, 0, 2000);
    expect(rescoped.estimateMin).toBe(120);
    expect(rescoped.estimateLockedMin).toBe(60);
    expect(taskTransition(rescoped, 'done', 3000).estimateLockedMin).toBe(60);
  });

  it("a finished task's estimate is history", () => {
    expect(() => withEstimate(baseTask({ status: 'done' }), 90, 0, 1)).toThrow();
    expect(() => withEstimate(baseTask({ status: 'cancelled' }), 90, 0, 1)).toThrow();
  });

  it('rejects illegal transitions', () => {
    expect(canTransitionTask('done', 'in_progress')).toBe(false);
    expect(() => taskTransition(baseTask({ status: 'done' }), 'in_progress', 1)).toThrow();
  });

  it('rollover (in_progress → backlog) is allowed; a still-planned task stays editable', () => {
    const rolled = taskTransition(
      baseTask({ status: 'in_progress', estimateLockedMin: 60 }),
      'backlog',
      1000,
    );
    expect(rolled.status).toBe('backlog');
    const planned = baseTask();
    expect(withEstimate(planned, 90, 10, 2000).estimateMin).toBe(90);
  });

  it('only done + locked tasks contribute calibration', () => {
    expect(contributesCalibration(baseTask({ status: 'done', estimateLockedMin: 60 }))).toBe(true);
    expect(contributesCalibration(baseTask({ status: 'cancelled', estimateLockedMin: 60 }))).toBe(
      false,
    );
    expect(contributesCalibration(baseTask({ status: 'done', estimateLockedMin: null }))).toBe(
      false,
    );
  });

  it('an errand (a placed task) never contributes, even with a lock', () => {
    const errand = baseTask({ status: 'done', estimateLockedMin: 5, place: 'safeway' });
    expect(contributesCalibration(errand)).toBe(false);
  });
});

describe('sessions — heartbeat lifecycle', () => {
  it('a work session accrues only to an open task — an errand included, never a done or cancelled one', () => {
    for (const status of ['backlog', 'planned', 'in_progress'] as const)
      expect(accruesTime(baseTask({ status }))).toBe(true);
    expect(accruesTime(baseTask({ status: 'in_progress', place: 'safeway' }))).toBe(true);
    expect(accruesTime(baseTask({ status: 'done', estimateLockedMin: 60 }))).toBe(false);
    expect(accruesTime(baseTask({ status: 'cancelled' }))).toBe(false);
  });

  function running(over: Partial<PomodoroSession> = {}): PomodoroSession {
    return {
      id: 's1',
      userId: 'u',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      taskId: 't1',
      categoryId: 'c1',
      label: null,
      wasWork: true,
      kind: 'work',
      startedAt: 0,
      endedAt: null,
      day: '2026-06-07',
      activeMinutes: 0,
      status: 'running',
      lastHeartbeatAt: 0,
      ...over,
    };
  }

  it('accrues only the elapsed active minutes since the last beat', () => {
    const beat = heartbeatSession(running(), 5 * 60_000);
    expect(beat.activeMinutes).toBe(5);
    expect(beat.lastHeartbeatAt).toBe(5 * 60_000);
  });

  it('keep on a stale session caps accrual at the last heartbeat (dark gap discarded)', () => {
    const s = running({ activeMinutes: 12, lastHeartbeatAt: 12 * 60_000 });
    const kept = resolveStaleSession(s, 'keep', 999 * 60_000);
    expect(kept.status).toBe('completed');
    expect(kept.endedAt).toBe(12 * 60_000);
    expect(kept.activeMinutes).toBe(12);
  });

  it('pause → resume excludes the paused gap from accrued time', () => {
    // Work 10 min, then pause (a final heartbeat captures it).
    const paused = heartbeatSession(running(), 10 * 60_000);
    expect(paused.activeMinutes).toBe(10);
    // Sit paused for 30 min, then resume — resume just resets the clock, no accrual.
    const resumed = resumeSession(paused, 40 * 60_000);
    expect(resumed.activeMinutes).toBe(10); // gap not credited
    expect(resumed.lastHeartbeatAt).toBe(40 * 60_000);
    // Work 5 more min: only post-resume time counts.
    const after = heartbeatSession(resumed, 45 * 60_000);
    expect(after.activeMinutes).toBe(15);
  });
});

describe('stalePlannedMoves', () => {
  const plan = (taskId: string, day: string): TaskPlan => ({
    id: `p-${taskId}-${day}`,
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    taskId,
    day,
    plannedMinutes: 30,
    order: 1,
  });

  it('drops a superseded occurrence, but backlogs one that carries a calendar event', () => {
    const old = baseTask({ id: 'old', seriesId: 's' });
    const oldWithEvent = baseTask({ id: 'ev', seriesId: 's', gcalEventId: 'e1' });
    const fresh = baseTask({ id: 'new', seriesId: 's' });
    const moves = stalePlannedMoves(
      [old, oldWithEvent, fresh],
      [plan('old', '2026-08-03'), plan('ev', '2026-08-03'), plan('new', '2026-08-04')],
      '2026-08-04',
    );
    expect(moves.map((m) => [m.task.id, m.to])).toEqual([
      ['old', 'cancelled'],
      ['ev', 'backlog'],
    ]);
  });

  it('a timed planned task goes back to backlog whatever its rows — today’s, or a later day’s', () => {
    const today = baseTask({ id: 'a', dueDay: '2026-08-06', dueTime: '15:00' });
    const later = baseTask({ id: 'b', dueDay: '2026-08-06', dueTime: '15:00' });
    const moves = stalePlannedMoves(
      [today, later],
      [plan('a', '2026-08-04'), plan('b', '2026-08-05')],
      '2026-08-04',
    );
    expect(moves.map((m) => [m.task.id, m.to])).toEqual([
      ['a', 'backlog'],
      ['b', 'backlog'],
    ]);
  });

  it('an untimed planned task with a row ahead is left alone', () => {
    const t = baseTask({ id: 'u', dueDay: '2026-08-06' });
    expect(stalePlannedMoves([t], [plan('u', '2026-08-05')], '2026-08-04')).toEqual([]);
  });

  it('a timed occurrence with its own row today goes to backlog, never dropped as its own copy', () => {
    const occ = baseTask({ id: 'o', seriesId: 's', dueDay: '2026-08-04', dueTime: '09:00' });
    const moves = stalePlannedMoves([occ], [plan('o', '2026-08-04')], '2026-08-04');
    expect(moves.map((m) => [m.task.id, m.to])).toEqual([['o', 'backlog']]);
  });

  it('ignores anything not planned', () => {
    const started = baseTask({ id: 'x', status: 'in_progress' });
    expect(stalePlannedMoves([started], [], '2026-08-04')).toEqual([]);
  });
});

describe('option 3: a time decides the day', () => {
  it('isTimed needs both a day and a time', () => {
    expect(isTimed({ dueDay: '2026-08-04', dueTime: '15:00' })).toBe(true);
    expect(isTimed({ dueDay: '2026-08-04', dueTime: null })).toBe(false);
    expect(isTimed({ dueDay: null, dueTime: null })).toBe(false);
  });

  it('placedByTime: timed and its deadline falls on this app day', () => {
    const t = { dueDay: '2026-08-04', dueTime: '15:00' };
    expect(placedByTime(t, '2026-08-04', 4)).toBe(true);
    expect(placedByTime(t, '2026-08-05', 4)).toBe(false);
    expect(placedByTime({ dueDay: '2026-08-04', dueTime: null }, '2026-08-04', 4)).toBe(false);
  });

  it('timedDay: the deadline instant’s app day — before day start it is still the night before', () => {
    const at = (dueTime: string) => ({ dueDay: '2026-08-05', dueTime });
    expect(timedDay(at('00:00'), 4)).toBe('2026-08-04');
    expect(timedDay(at('03:59'), 4)).toBe('2026-08-04');
    expect(timedDay(at('04:00'), 4)).toBe('2026-08-05');
    expect(timedDay(at('00:00'), 0)).toBe('2026-08-05');
    expect(timedDay({ dueDay: '2026-08-05', dueTime: null }, 4)).toBeNull();
    expect(placedByTime(at('00:30'), '2026-08-04', 4)).toBe(true);
  });
});
