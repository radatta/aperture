import { describe, expect, it } from 'vitest';
import { tokenAtCaret } from '@aperture/shared';
import {
  applySuggestion,
  categorySuggestions,
  dueSuggestions,
  estimateSuggestions,
} from './suggestions';

const CATS = [
  { id: 'a', label: 'Admin' },
  { id: 'd', label: 'Deep Work' },
  { id: 'q', label: 'Say "hi"' },
];
const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

describe('categorySuggestions', () => {
  it('empty partial offers every writable label', () => {
    expect(labels(categorySuggestions('', CATS))).toEqual(['Admin', 'Deep Work']);
  });
  it('matches word-starts, case-insensitively', () => {
    expect(labels(categorySuggestions('AD', CATS))).toEqual(['Admin']);
    expect(labels(categorySuggestions('work', CATS))).toEqual(['Deep Work']);
    expect(labels(categorySuggestions('deep w', CATS))).toEqual(['Deep Work']);
    expect(categorySuggestions('ee', CATS)).toEqual([]);
  });
  it('quotes a multi-word label', () => {
    expect(categorySuggestions('deep', CATS)[0]!.insert).toBe('#"Deep Work"');
    expect(categorySuggestions('ad', CATS)[0]!.insert).toBe('#Admin');
  });
});

describe('estimateSuggestions', () => {
  it('filters presets by digit prefix', () => {
    expect(labels(estimateSuggestions('1'))).toEqual(['15m', '2h']);
    expect(estimateSuggestions('7')).toEqual([]);
    expect(estimateSuggestions('')).toHaveLength(6);
  });
});

describe('dueSuggestions', () => {
  it('inserts concrete ISO dates, filtered by what was typed', () => {
    const all = dueSuggestions('', '2026-09-30');
    expect(all[2]).toMatchObject({ label: 'Fri', insert: 'due:2026-10-02' });
    expect(labels(dueSuggestions('2026-10-0', '2026-09-30'))).toEqual([
      'Tomorrow',
      'Fri',
      'Mon',
      'Tue',
      'Oct 7',
    ]);
  });
});

describe('applySuggestion', () => {
  it('at the end, replaces the token and adds a space', () => {
    const text = 'memo | #ad';
    const tok = tokenAtCaret(text, text.length)!;
    expect(applySuggestion(text, tok, categorySuggestions('ad', CATS)[0]!)).toEqual({
      text: 'memo | #Admin ',
      caret: 14,
    });
  });
  it('mid-line, reuses the following space', () => {
    const text = 'memo | #ad ~30';
    const tok = tokenAtCaret(text, 10)!;
    expect(applySuggestion(text, tok, categorySuggestions('ad', CATS)[0]!)).toEqual({
      text: 'memo | #Admin ~30',
      caret: 14,
    });
  });
});
