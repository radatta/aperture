import type { PomodoroSession, SessionKind } from '@aperture/shared';

// A running session with no heartbeat for this long means the app was closed mid-timer → stale,
// prompt keep/discard rather than silently resuming a timer that "ran" while the tab was gone.
export const STALE_MS = 90_000;

interface Durations {
  pomodoroWorkMin: number;
  pomodoroBreakMin: number;
}

export function targetSecFor(kind: SessionKind, settings: Durations | undefined): number {
  const workMin = settings?.pomodoroWorkMin ?? 25;
  const breakMin = settings?.pomodoroBreakMin ?? 5;
  return (kind === 'work' ? workMin : breakMin) * 60;
}

// Live active seconds: the persisted activeMinutes plus the not-yet-persisted time since the last
// heartbeat (only while running — paused time is frozen at the persisted value).
export function activeSec(session: PomodoroSession, paused: boolean, now: number): number {
  const base = session.activeMinutes * 60;
  if (paused) return base;
  return base + Math.max(0, (now - session.lastHeartbeatAt) / 1000);
}

export function remainingSec(
  session: PomodoroSession,
  targetSec: number,
  paused: boolean,
  now: number,
): number {
  return Math.max(0, Math.round(targetSec - activeSec(session, paused, now)));
}

export function isStale(session: PomodoroSession, now: number): boolean {
  return now - session.lastHeartbeatAt > STALE_MS;
}
