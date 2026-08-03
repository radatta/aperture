import { createContext, useContext } from 'react';
import type { ResolvedTheme, Theme } from '../styles/theme';

export interface ThemeContextValue {
  theme: Theme; // stored preference
  resolved: ResolvedTheme; // what actually paints
  setTheme: (t: Theme) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
