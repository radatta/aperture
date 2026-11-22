import { describe, expect, it } from 'vitest';
import {
  appendNote,
  normalizeNote,
  normalizeNotes,
  normalizeReflection,
  setReflectionArg,
  TASK_NOTES_MAX,
  TASK_REFLECTION_MAX,
} from './taskNotes';

describe('normalizeNotes', () => {
  it('trims, and turns empty/whitespace/absent into null', () => {
    expect(normalizeNotes('  hi\n')).toBe('hi');
    expect(normalizeNotes('   \n ')).toBeNull();
    expect(normalizeNotes('')).toBeNull();
    expect(normalizeNotes(null)).toBeNull();
    expect(normalizeNotes(undefined)).toBeNull();
  });

  it('normalizes CRLF to LF', () => {
    expect(normalizeNotes('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('accepts exactly the cap and rejects one over', () => {
    expect(normalizeNotes('x'.repeat(TASK_NOTES_MAX))).toHaveLength(TASK_NOTES_MAX);
    expect(() => normalizeNotes('x'.repeat(TASK_NOTES_MAX + 1))).toThrow(/5,000/);
  });

  it('measures the cap after trimming', () => {
    expect(normalizeNotes(` ${'x'.repeat(TASK_NOTES_MAX)} `)).toHaveLength(TASK_NOTES_MAX);
  });

  it('rejects a non-string', () => {
    expect(() => normalizeNotes(42 as unknown as string)).toThrow(/text/);
  });
});

describe('normalizeReflection', () => {
  it('trims, normalizes CRLF, and turns empty/absent into null', () => {
    expect(normalizeReflection('  went fine\r\n')).toBe('went fine');
    expect(normalizeReflection('a\r\nb')).toBe('a\nb');
    expect(normalizeReflection('  ')).toBeNull();
    expect(normalizeReflection(null)).toBeNull();
    expect(normalizeReflection(undefined)).toBeNull();
  });

  it('accepts exactly its own cap and rejects one over, by name', () => {
    expect(normalizeReflection('x'.repeat(TASK_REFLECTION_MAX))).toHaveLength(TASK_REFLECTION_MAX);
    expect(() => normalizeReflection('x'.repeat(TASK_REFLECTION_MAX + 1))).toThrow(
      'Reflection is limited to 1,000 characters',
    );
  });

  it('rejects a non-string', () => {
    expect(() => normalizeReflection(42 as unknown as string)).toThrow(/Reflection must be text/);
  });
});

describe('setReflectionArg', () => {
  it('treats a missing value as an error, never a clear; null clears', () => {
    expect(() => setReflectionArg(undefined)).toThrow(/required/);
    expect(setReflectionArg(null)).toBeNull();
    expect(setReflectionArg(' kept ')).toBe('kept');
  });
});

describe('appendNote / normalizeNote', () => {
  it('appends after a blank line, or is the whole notes when there are none', () => {
    expect(appendNote('Scoped it.', 'Shipped it.')).toBe('Scoped it.\n\nShipped it.');
    for (const none of [null, undefined, ''])
      expect(appendNote(none, 'Shipped it.')).toBe('Shipped it.');
  });

  it('a note takes the notes rules under its own name', () => {
    expect(normalizeNote('  hi\r\n')).toBe('hi');
    expect(normalizeNote('  ')).toBeNull();
    expect(() => normalizeNote('x'.repeat(TASK_NOTES_MAX + 1))).toThrow(
      /^note is limited to 5,000/,
    );
  });
});
