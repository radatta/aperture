import type { PomodoroSession, SessionKind } from '@aperture/shared';
import type { RunningTimer } from './pomodoro-context';

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

// What the block has worked, as the count-up and the Actual prefill show it: the live count, held at the
// target once it reaches Done, since the wait there isn't work (the capped stop credits the same). Minutes
// already persisted past the target stand.
export function workedSec(
  session: PomodoroSession,
  targetSec: number,
  paused: boolean,
  now: number,
): number {
  const held = Math.min(activeSec(session, paused, now), targetSec);
  return Math.max(session.activeMinutes * 60, held);
}

export function remainingSec(
  session: PomodoroSession,
  targetSec: number,
  paused: boolean,
  now: number,
): number {
  return Math.max(0, Math.round(targetSec - activeSec(session, paused, now)));
}

// What a stop may still credit beyond what's persisted (stopSession's capMin): a paused timer nothing (its
// pause beat captured the worked time), a timer on "done" what's left to its target (the wait since isn't
// work), a running one everything since its last beat (undefined = uncapped).
export function stopCapMin(
  timer: Pick<RunningTimer, 'session' | 'paused' | 'done'>,
  targetSec: number,
): number | undefined {
  if (timer.paused) return 0;
  if (timer.done) return Math.max(0, targetSec / 60 - timer.session.activeMinutes);
  return undefined;
}

export function isStale(session: PomodoroSession, now: number): boolean {
  return now - session.lastHeartbeatAt > STALE_MS;
}

// A block that has reached its target holds at "done" (chime + wait for stop/extend) rather than
// auto-rolling into a break. Derived, so every concurrent timer resolves it independently.
export function isDone(
  session: PomodoroSession,
  targetSec: number,
  paused: boolean,
  now: number,
): boolean {
  return remainingSec(session, targetSec, paused, now) <= 0;
}
