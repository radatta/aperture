import { describe, expect, it } from 'vitest';
import { normalizeNotes, TASK_NOTES_MAX } from './taskNotes';

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
