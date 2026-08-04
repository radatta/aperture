import { createContext, useContext } from 'react';
import type { PomodoroSession } from '@aperture/shared';

// One running timer, with its derived display state. Several run concurrently (parallel focus).
export interface RunningTimer {
  session: PomodoroSession;
  paused: boolean;
  remaining: number; // seconds left in the current block (0 once done)
  done: boolean; // reached target — holding for stop/extend (no auto-break)
}

export interface StartFocusInput {
  taskId?: string | null;
  label?: string | null; // freeform name for ad-hoc parallel work
}

export interface PomodoroContextValue {
  timers: RunningTimer[]; // all running timers (work + break), newest last
  stale: PomodoroSession[]; // sessions left running when the app closed — awaiting keep/discard
  startFocus: (input?: StartFocusInput) => void; // add a concurrent work block (dedups per task)
  startBreak: () => void;
  pause: (id: string) => void;
  resume: (id: string) => void;
  extend: (id: string) => void; // give a done timer one more block
  stop: (id: string, status?: 'completed' | 'discarded') => void;
  keepStale: (id: string) => void;
  discardStale: (id: string) => void;
}

export const PomodoroContext = createContext<PomodoroContextValue | null>(null);

export function usePomodoro(): PomodoroContextValue {
  const ctx = useContext(PomodoroContext);
  if (!ctx) throw new Error('usePomodoro must be used within PomodoroProvider');
  return ctx;
}
