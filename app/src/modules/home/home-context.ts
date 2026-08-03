import { createContext, useContext } from 'react';
import type { HomeMode } from '../../styles/theme';

export interface HomeModeContextValue {
  mode: HomeMode; // what the home is showing (override if set, else clock)
  autoMode: HomeMode; // what the clock alone implies
  isAuto: boolean; // true when following the clock (no manual override)
  setOverride: (mode: HomeMode | null) => void; // null → back to auto
}

export const HomeModeContext = createContext<HomeModeContextValue | null>(null);

export function useHomeMode(): HomeModeContextValue {
  const ctx = useContext(HomeModeContext);
  if (!ctx) throw new Error('useHomeMode must be used within HomeModeProvider');
  return ctx;
}
