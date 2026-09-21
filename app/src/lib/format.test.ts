import { describe, it, expect } from 'vitest';
import { fmtClock, fmtDateTime, fmtDuration, fmtTime } from './format';

describe('fmtDuration', () => {
  it('renders sub-hour as minutes', () => expect(fmtDuration(45)).toBe('45m'));
  it('renders exact hours without minutes', () => expect(fmtDuration(120)).toBe('2h'));
  it('renders mixed hours and minutes', () => expect(fmtDuration(78)).toBe('1h 18m'));
});

describe('fmtClock', () => {
  it('pads seconds', () => expect(fmtClock(1500)).toBe('25:00'));
  it('handles sub-minute', () => expect(fmtClock(9)).toBe('0:09'));
  it('clamps negatives to zero', () => expect(fmtClock(-5)).toBe('0:00'));
});

describe('fmtDateTime', () => {
  // Epochs built from LOCAL components so the assertion holds in any runner timezone; delegates the
  // time half to fmtTime so it's locale-agnostic too.
  it('is calendar day · time', () => {
    const ms = new Date(2026, 8, 20, 9, 42).getTime();
    expect(fmtDateTime(ms)).toBe(`Sep 20 · ${fmtTime(ms)}`);
  });
  it('uses the calendar day for an early-morning time, not the logical day', () => {
    const ms = new Date(2026, 0, 5, 1, 15).getTime();
    expect(fmtDateTime(ms)).toBe(`Jan 5 · ${fmtTime(ms)}`);
  });
});
