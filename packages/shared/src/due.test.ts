import { describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_MIN, dueUrgency, eventWindow, normalizeDue } from './due';
import type { DueEpoch } from './due';

// A fixed epoch so the tests are timezone-free: day D at HH:MM = D*day + minutes.
const DAY = 86_400_000;
const epoch: DueEpoch = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return Number(day.slice(-2)) * DAY + (h * 60 + m) * 60_000;
};
const H = 3_600_000;

describe('normalizeDue', () => {
  it('a cleared day clears the time; a time needs a day', () => {
    expect(normalizeDue(null, undefined, '16:00')).toEqual({ dueDay: null, dueTime: null });
    expect(normalizeDue(null, null)).toEqual({ dueDay: null, dueTime: null });
    expect(() => normalizeDue(null, '16:00')).toThrow(/requires dueDay/);
  });
  it('omitted time keeps the current one; null clears it', () => {
    expect(normalizeDue('2026-10-05', undefined, '16:00').dueTime).toBe('16:00');
    expect(normalizeDue('2026-10-05', null, '16:00').dueTime).toBeNull();
    expect(normalizeDue('2026-10-05', undefined, undefined as unknown as null).dueTime).toBeNull();
  });
  it('rejects a malformed day or time', () => {
    expect(() => normalizeDue('2026-2-5', null)).toThrow(/dueDay/);
    expect(() => normalizeDue('2026-10-05', '4pm')).toThrow(/dueTime/);
  });
});

describe('eventWindow', () => {
  it('ends at the deadline and is as long as the estimate (default when none)', () => {
    const end = epoch('2026-10-05', '16:00');
    expect(eventWindow({ dueDay: '2026-10-05', dueTime: '16:00', estimateMin: 45 }, epoch)).toEqual(
      {
        startMs: end - 45 * 60_000,
        endMs: end,
      },
    );
    expect(
      eventWindow({ dueDay: '2026-10-05', dueTime: '16:00', estimateMin: null }, epoch)!.startMs,
    ).toBe(end - DEFAULT_EVENT_MIN * 60_000);
  });
  it('an estimate of 0 gets the default length, not a zero-length block', () => {
    const w = eventWindow({ dueDay: '2026-10-05', dueTime: '16:00', estimateMin: 0 }, epoch)!;
    expect(w.endMs - w.startMs).toBe(DEFAULT_EVENT_MIN * 60_000);
  });
  it('is null for an untimed task', () => {
    expect(eventWindow({ dueDay: '2026-10-05', dueTime: null, estimateMin: 30 }, epoch)).toBeNull();
  });
});

describe('dueUrgency — the boundaries', () => {
  const task = { dueDay: '2026-10-05', dueTime: '16:00', status: 'backlog' as const };
  const due = epoch('2026-10-05', '16:00');
  const at = (msBefore: number) => dueUrgency(task, due - msBefore, epoch);
  it('none beyond 6h, soon inside 6h, imminent inside 1h, past from the moment it passes', () => {
    expect(at(6 * H + 1)).toBe('none');
    expect(at(6 * H)).toBe('soon');
    expect(at(H + 1)).toBe('soon');
    expect(at(H)).toBe('imminent');
    expect(at(1)).toBe('imminent');
    expect(at(0)).toBe('past');
    expect(at(-3 * DAY)).toBe('past'); // persists across days
  });
  it('untimed and finished tasks never colour', () => {
    expect(dueUrgency({ ...task, dueTime: null }, due, epoch)).toBe('none');
    expect(dueUrgency({ ...task, dueDay: null }, due, epoch)).toBe('none');
    expect(dueUrgency({ ...task, status: 'done' }, due + H, epoch)).toBe('none');
    expect(dueUrgency({ ...task, status: 'cancelled' }, due + H, epoch)).toBe('none');
    expect(dueUrgency({ ...task, status: 'in_progress' }, due + H, epoch)).toBe('past');
  });
});
