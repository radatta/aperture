import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { resolveTheme, type Theme } from '../styles/theme';
import { ThemeContext } from './theme-context';

function prefersDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

// Applies data-theme to <html>. "auto" tracks the OS today; once the home-mode provider lands
// (Phase 4) it will call setTheme(themeForMode(mode)) so the app tints with the time of day.
// Settings.theme override wiring arrives with the data hooks (Phase 3); default is "auto".
export function ThemeProvider({ children, initial = 'auto' }: { children: ReactNode; initial?: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(theme, systemDark);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
}
