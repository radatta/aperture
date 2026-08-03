import { describe, it, expect } from 'vitest';
import type { PomodoroSession } from '@aperture/shared';
import { activeSec, isStale, remainingSec, targetSecFor, STALE_MS } from './pomodoro';

const session = (over: Partial<PomodoroSession>): PomodoroSession => ({
  id: 's',
  userId: 'local',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  taskId: null,
  categoryId: null,
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
