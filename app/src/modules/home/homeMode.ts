import type { HomeMode } from '../../styles/theme';

export const HOME_MODES = ['morning', 'day', 'night'] as const;

// The three faces of the home. `tagline` is the mode's job, shown under the date in the header.
export const homeModeMeta: Record<HomeMode, { label: string; tagline: string }> = {
  morning: { label: 'Morning', tagline: 'plan the day' },
  day: { label: 'Daytime', tagline: 'do & capture' },
  night: { label: 'Night', tagline: 'log & reflect' },
};

// Clock windows (local hour). Night wraps midnight: anything before the day-start hour is still the
// previous night. Morning starts at dayStartHour so a 4am start doesn't flip to "morning" too early.
export const MORNING_END = 12; // noon
export const DAY_END = 18; // 6pm

// Which mode the clock implies. dayStartHour (default 4) is where night → morning flips.
export function homeModeForHour(hour: number, dayStartHour: number): HomeMode {
  if (hour < dayStartHour) return 'night';
  if (hour < MORNING_END) return 'morning';
  if (hour < DAY_END) return 'day';
  return 'night';
}
