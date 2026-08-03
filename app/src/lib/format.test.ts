import { describe, it, expect } from 'vitest';
import { fmtClock, fmtDuration } from './format';

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
