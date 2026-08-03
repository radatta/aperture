import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { themeForMode, type ResolvedTheme } from '../styles/theme';
import { useSettings } from '../data/hooks/useSettings';
import { useHomeMode } from '../modules/home/home-context';
import { ThemeContext } from './theme-context';

// Owns the `data-theme` attribute on <html> — the single writer. The palette follows the home mode
// (morning/day = light, night = dark) unless settings.theme pins an explicit light/dark override.
// So the app tints with the time of day, reinforcing the ritual. Must sit under HomeModeProvider.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { mode } = useHomeMode();
  const { data: settings } = useSettings();
  const pref = settings?.theme ?? 'auto';
  const resolved: ResolvedTheme = pref === 'auto' ? themeForMode(mode) : pref;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const value = useMemo(() => ({ resolved }), [resolved]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}
