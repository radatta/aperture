import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { HomeMode } from '../../styles/theme';
import { useSettings } from '../../data/hooks/useSettings';
import { HomeModeContext } from './home-context';
import { homeModeForHour } from './homeMode';

// Derives the home mode from the wall clock (morning/day/night), with a manual override that the
// user can set for the session. The override is intentionally NOT persisted — reopening the app in
// the morning should show morning, not last night's pin. Re-derives every minute and whenever the
// tab becomes visible again (the realistic "reopen it later" path).
export function HomeModeProvider({ children }: { children: ReactNode }) {
  const { data: settings } = useSettings();
  const dayStartHour = settings?.dayStartHour ?? 4;

  const [now, setNow] = useState(() => Date.now());
  const [override, setOverride] = useState<HomeMode | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, 60_000);
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const autoMode = homeModeForHour(new Date(now).getHours(), dayStartHour);
  const mode = override ?? autoMode;

  const value = useMemo(
    () => ({ mode, autoMode, isAuto: override === null, setOverride }),
    [mode, autoMode, override],
  );

  return <HomeModeContext value={value}>{children}</HomeModeContext>;
}
