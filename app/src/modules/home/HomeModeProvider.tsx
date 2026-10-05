import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { HomeMode } from '../../styles/theme';
import { useSettings } from '../../data/hooks/useSettings';
import { useNow } from '../../lib/useNow';
import { HomeModeContext } from './home-context';
import { homeModeForHour } from './homeMode';

// Derives the home mode from the wall clock (morning/day/night), with a manual override that the
// user can set for the session. The override is intentionally NOT persisted — reopening the app in
// the morning should show morning, not last night's pin. Re-derives every minute and whenever the
// tab becomes visible again (the realistic "reopen it later" path).
export function HomeModeProvider({ children }: { children: ReactNode }) {
  const { data: settings } = useSettings();
  const dayStartHour = settings?.dayStartHour ?? 4;

  const now = useNow();
  const [override, setOverride] = useState<HomeMode | null>(null);

  const autoMode = homeModeForHour(new Date(now).getHours(), dayStartHour);
  const mode = override ?? autoMode;

  const value = useMemo(
    () => ({ mode, autoMode, isAuto: override === null, setOverride }),
    [mode, autoMode, override],
  );

  return <HomeModeContext value={value}>{children}</HomeModeContext>;
}
