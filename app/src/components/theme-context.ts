import { createContext, useContext } from 'react';
import type { ResolvedTheme } from '../styles/theme';

export interface ThemeContextValue {
  resolved: ResolvedTheme; // what actually paints (light | dark)
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
