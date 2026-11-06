import { createContext, useContext } from 'react';
import type { PomodoroSession } from '@aperture/shared';

// One running timer, with its derived display state. Several run concurrently (parallel focus).
export interface RunningTimer {
  session: PomodoroSession;
  paused: boolean;
  remaining: number; // seconds left in the current block (0 once done)
  done: boolean; // reached target — holding for stop/extend (no auto-break)
  activeSec: number; // live active seconds worked (count-up), incl. time since the last heartbeat, held at the target on Done
  error: string | null; // the last action on this timer failed (stop, resume, extend) — said on its row
  syncFailed: boolean; // two heartbeats in a row failed: the server isn't hearing this timer
}

export interface StartFocusInput {
  taskId?: string | null;
  label?: string | null; // freeform name for ad-hoc parallel work
}

export interface PomodoroContextValue {
  timers: RunningTimer[]; // all running timers (work + break), newest last
  stale: PomodoroSession[]; // sessions left running when the app closed — awaiting keep/discard
  staleErrors: Record<string, string>; // a keep/discard that failed, by session id
  adoptFailed: boolean; // the on-load read of running sessions failed — never shown as "none running"
  retryAdopt: () => void;
  startError: string | null; // the last start failed
  // Add a concurrent work block (dedups per task). Resolves true once it runs, false when the server
  // refused (startError set) — never rejects, so a caller may ignore it or wait on it.
  startFocus: (input?: StartFocusInput) => Promise<boolean>;
  startBreak: () => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  extend: (id: string) => void; // give a done timer one more block
  // Resolves after accrual persists; rejects when the stop didn't land (the timer stays, its row says so).
  stop: (id: string, status?: 'completed' | 'discarded') => Promise<void>;
  keepStale: (id: string) => void;
  discardStale: (id: string) => void;
}

export const PomodoroContext = createContext<PomodoroContextValue | null>(null);

export function usePomodoro(): PomodoroContextValue {
  const ctx = useContext(PomodoroContext);
  if (!ctx) throw new Error('usePomodoro must be used within PomodoroProvider');
  return ctx;
}
