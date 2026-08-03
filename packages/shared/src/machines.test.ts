import { describe, it, expect } from 'vitest';
import {
  canTransitionTask,
  contributesCalibration,
  heartbeatSession,
  resolveStaleSession,
  taskTransition,
  withEstimate,
} from './machines';
import type { PomodoroSession, Task } from './types';

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
    seriesId: null,
    estimateMin: 60,
    bufferMin: 15,
    estimateLockedMin: null,
    actualAccruedMin: 0,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...over,
  };
}

describe('taskTransition — estimate freeze', () => {
  it('locks the estimate and stamps startedAt on first exit from planning', () => {
    const started = taskTransition(baseTask(), 'in_progress', 1000);
    expect(started.estimateLockedMin).toBe(60);
    expect(started.startedAt).toBe(1000);
  });

  it('freezes the estimate against further edits once work starts', () => {
    const started = taskTransition(baseTask(), 'in_progress', 1000);
    expect(() => withEstimate(started, 120, 0, 2000)).toThrow();
  });

  it('rejects illegal transitions', () => {
    expect(canTransitionTask('done', 'in_progress')).toBe(false);
    expect(() => taskTransition(baseTask({ status: 'done' }), 'in_progress', 1)).toThrow();
  });

  it('rollover (in_progress → backlog) is allowed; a still-planned task stays editable', () => {
    const rolled = taskTransition(baseTask({ status: 'in_progress', estimateLockedMin: 60 }), 'backlog', 1000);
    expect(rolled.status).toBe('backlog');
    const planned = baseTask();
    expect(withEstimate(planned, 90, 10, 2000).estimateMin).toBe(90);
  });

  it('only done + locked tasks contribute calibration', () => {
    expect(contributesCalibration(baseTask({ status: 'done', estimateLockedMin: 60 }))).toBe(true);
    expect(contributesCalibration(baseTask({ status: 'cancelled', estimateLockedMin: 60 }))).toBe(false);
    expect(contributesCalibration(baseTask({ status: 'done', estimateLockedMin: null }))).toBe(false);
  });
});

describe('sessions — heartbeat lifecycle', () => {
  function running(over: Partial<PomodoroSession> = {}): PomodoroSession {
    return {
      id: 's1',
      userId: 'u',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      taskId: 't1',
      categoryId: 'c1',
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
});
