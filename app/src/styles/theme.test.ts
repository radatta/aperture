import { describe, it, expect } from 'vitest';
import { resolveTheme, themeForMode } from './theme';

describe('resolveTheme', () => {
  it('auto follows the system preference', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
  });
  it('an explicit choice overrides the system', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('themeForMode', () => {
  it('night is dark; morning and day are light', () => {
    expect(themeForMode('night')).toBe('dark');
    expect(themeForMode('morning')).toBe('light');
    expect(themeForMode('day')).toBe('light');
  });
});

// The theme is `data-theme` on <html> (ThemeProvider), and `color-scheme` follows it (tokens.css).
// Tailwind's `dark:` keys on the OS instead (prefers-color-scheme), so it disagrees with the app at
// night on a light-mode phone — it once put a light date picker on the dark app. Keep it out.
describe('one theme mechanism', () => {
  it('no Tailwind dark: variant in app source', () => {
    const sources = import.meta.glob<string>(['../**/*.tsx', '../**/*.ts', '!../**/*.test.*'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders = Object.entries(sources)
      .filter(([, src]) => /(^|[\s'"`])dark:/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
