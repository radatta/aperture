import { createContext, useContext } from 'react';
import type { PomodoroSession } from '@aperture/shared';

export interface PomodoroContextValue {
  session: PomodoroSession | null; // the running session (null when idle)
  paused: boolean;
  stale: PomodoroSession | null; // a session left running when the app closed — awaiting keep/discard
  remaining: number; // seconds left in the current block
  start: (taskId: string | null) => void; // start a work block (switches focus if one's running)
  startBreak: () => void;
  pause: () => void;
  resume: () => void;
  stop: (status: 'completed' | 'discarded') => void;
  keepStale: () => void;
  discardStale: () => void;
}

export const PomodoroContext = createContext<PomodoroContextValue | null>(null);

export function usePomodoro(): PomodoroContextValue {
  const ctx = useContext(PomodoroContext);
  if (!ctx) throw new Error('usePomodoro must be used within PomodoroProvider');
  return ctx;
}
