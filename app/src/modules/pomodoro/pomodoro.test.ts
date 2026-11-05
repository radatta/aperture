import { describe, it, expect } from 'vitest';
import type { PomodoroSession } from '@aperture/shared';
import { activeSec, isDone, isStale, remainingSec, stopCapMin, targetSecFor, STALE_MS } from './pomodoro';

const session = (over: Partial<PomodoroSession>): PomodoroSession => ({
  id: 's',
  userId: 'local',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  taskId: null,
  categoryId: null,
  label: null,
  wasWork: true,
  kind: 'work',
  startedAt: 0,
  endedAt: null,
  day: '2026-08-03',
  activeMinutes: 0,
  status: 'running',
  lastHeartbeatAt: 0,
  ...over,
});

describe('targetSecFor', () => {
  it('defaults to 25/5 and reads settings when present', () => {
    expect(targetSecFor('work', undefined)).toBe(1500);
    expect(targetSecFor('break', undefined)).toBe(300);
    expect(targetSecFor('work', { pomodoroWorkMin: 50, pomodoroBreakMin: 10 })).toBe(3000);
  });
});

describe('activeSec — paused time is frozen', () => {
  it('adds live time since the last beat while running', () => {
    const s = session({ activeMinutes: 10, lastHeartbeatAt: 1000 });
    expect(activeSec(s, false, 1000 + 30_000)).toBeCloseTo(10 * 60 + 30);
  });
  it('freezes at the persisted value while paused (the gap never counts)', () => {
    const s = session({ activeMinutes: 10, lastHeartbeatAt: 1000 });
    expect(activeSec(s, true, 1000 + 5 * 60_000)).toBe(600);
  });
});

describe('remainingSec', () => {
  it('counts down from the target as active time accrues', () => {
    const s = session({ activeMinutes: 5, lastHeartbeatAt: 0 });
    expect(remainingSec(s, 1500, false, 0)).toBe(1500 - 300);
  });
  it('floors at 0 when the timer is spent', () => {
    const s = session({ activeMinutes: 30, lastHeartbeatAt: 0 });
    expect(remainingSec(s, 1500, false, 0)).toBe(0);
  });
});

describe('isStale', () => {
  it('is stale only past the threshold', () => {
    expect(isStale(session({ lastHeartbeatAt: 0 }), STALE_MS - 1)).toBe(false);
    expect(isStale(session({ lastHeartbeatAt: 0 }), STALE_MS + 1)).toBe(true);
  });
});

describe('isDone — the chime & hold trigger', () => {
  it('is done only once active time reaches the block target', () => {
    const almost = session({ activeMinutes: 24, lastHeartbeatAt: 0 });
    expect(isDone(almost, 1500, false, 0)).toBe(false);
    const spent = session({ activeMinutes: 25, lastHeartbeatAt: 0 });
    expect(isDone(spent, 1500, false, 0)).toBe(true);
  });
  it('resolves independently per timer (a longer block is not yet done at the same time)', () => {
    const s = session({ activeMinutes: 25, lastHeartbeatAt: 0 });
    expect(isDone(s, 1500, false, 0)).toBe(true); // 1 block
    expect(isDone(s, 3000, false, 0)).toBe(false); // extended to 2 blocks
  });
});

describe('stopCapMin — what a stop may still credit', () => {
  const session = (activeMinutes: number): PomodoroSession => ({
    id: 's',
    userId: 'u',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    taskId: null,
    categoryId: null,
    wasWork: true,
    kind: 'work',
    label: null,
    startedAt: 0,
    endedAt: null,
    day: '2026-01-01',
    activeMinutes,
    status: 'running',
    lastHeartbeatAt: 0,
  });
  it('paused → 0, done → what is left to the target, running → uncapped', () => {
    expect(stopCapMin({ session: session(10), paused: true, done: false }, 25 * 60)).toBe(0);
    expect(stopCapMin({ session: session(24.5), paused: false, done: true }, 25 * 60)).toBeCloseTo(0.5);
    expect(stopCapMin({ session: session(25.5), paused: false, done: true }, 25 * 60)).toBe(0); // never negative
    expect(stopCapMin({ session: session(10), paused: false, done: false }, 25 * 60)).toBeUndefined();
  });
});
