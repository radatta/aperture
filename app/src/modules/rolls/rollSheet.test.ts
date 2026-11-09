import { describe, expect, it } from 'vitest';
import { CONTACT_WEEKS, contactSheet, fmtLastRep } from './rollSheet';

describe('contactSheet', () => {
  const today = '2026-09-21'; // a Monday

  it('lays out CONTACT_WEEKS rows of 7 Mon…Sun cells ending at today', () => {
    const s = contactSheet(new Map(), today);
    expect(s.rows).toHaveLength(CONTACT_WEEKS);
    expect(s.rows.every((r) => r.length === 7)).toBe(true);
    // The last row's last real (non-future) day includes today.
    const flat = s.rows.flat();
    expect(flat.some((c) => c.date === today && !c.future)).toBe(true);
  });

  it('flags future cells and fills only days with reps', () => {
    const reps = new Map([
      ['2026-09-16', 1],
      ['2026-09-17', 2],
    ]);
    const s = contactSheet(reps, today);
    const flat = s.rows.flat();
    expect(flat.find((c) => c.date === '2026-09-16')?.reps).toBe(1);
    expect(flat.find((c) => c.date === '2026-09-17')?.reps).toBe(2);
    expect(flat.find((c) => c.date === '2026-09-15')?.reps).toBe(0); // a gap, not a reset
    expect(flat.find((c) => c.date === '2026-09-22')?.future).toBe(true); // tomorrow
    expect(flat.find((c) => c.date === today)?.future).toBe(false);
  });

  it('counts ALL-TIME reps, including days older than the window', () => {
    const old = '2026-01-01'; // far before the 5-week window
    const s = contactSheet(
      new Map([
        [old, 3],
        ['2026-09-20', 2],
      ]),
      today,
    );
    expect(s.total).toBe(5); // the out-of-window 3 still counts
    expect(s.rows.flat().some((c) => c.date === old)).toBe(false); // but isn't drawn
  });

  it('reports the most recent rep day and ignores zero-count entries', () => {
    const s = contactSheet(
      new Map([
        ['2026-09-10', 1],
        ['2026-09-18', 0],
        ['2026-09-15', 2],
      ]),
      today,
    );
    expect(s.lastRepDay).toBe('2026-09-15');
    expect(s.total).toBe(3); // the 0 doesn't count
  });

  it('is empty and last-less with no reps', () => {
    const s = contactSheet(new Map(), today);
    expect(s.total).toBe(0);
    expect(s.lastRepDay).toBeNull();
  });
});

describe('fmtLastRep', () => {
  const today = '2026-09-21';
  it('phrases recent days relatively and older ones as a date', () => {
    expect(fmtLastRep('2026-09-21', today)).toBe('today');
    expect(fmtLastRep('2026-09-20', today)).toBe('yesterday');
    expect(fmtLastRep('2026-09-15', today)).toBe(fmtLastRep('2026-09-15', today)); // stable
    expect(fmtLastRep('2026-09-15', today)).toMatch(/Sep/);
  });
});
