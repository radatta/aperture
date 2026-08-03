// Theme model. `Theme` is the stored preference (settings.theme); `ResolvedTheme` is what
// actually paints. "auto" follows the OS now and, once the home-mode provider exists (Phase 4),
// will follow the mode instead (morning/day = light, night = dark).

export type Theme = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type HomeMode = 'morning' | 'day' | 'night';

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'auto') return prefersDark ? 'dark' : 'light';
  return theme;
}

export function themeForMode(mode: HomeMode): ResolvedTheme {
  return mode === 'night' ? 'dark' : 'light';
}
