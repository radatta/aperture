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
