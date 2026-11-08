process.env.TZ = 'America/Los_Angeles';
import { describe, expect, it } from 'vitest';
import { fit, rpad, spread, strip, width } from './ansi.ts';
import { age, countdown, gib, hhmm, parseTime, wall } from './fmt.ts';

describe('fmt', () => {
  const t = Date.parse('2026-11-08T06:10:00Z');
  it('local clock, GiB, countdowns, ages, walls', () => {
    expect(hhmm(t)).toBe('22:10');
    expect(gib(4860)).toBe('4.7G');
    expect([
      countdown(t + 35 * 60000, t),
      countdown(t + 65 * 60000, t),
      countdown(t - 3 * 60000, t),
    ]).toEqual(['35m', '1h05m', '-3m']);
    expect([age(5), age(600), age(7200), age(3 * 86400)]).toEqual(['5s', '10m', '2h', '3d']);
    expect([wall(0.4), wall(61.9), wall(663)]).toEqual(['0.4s', '62s', '11m03s']);
    expect([parseTime('2026-11-08T06:10:00Z'), parseTime('x'), parseTime(3)]).toEqual([
      t,
      null,
      null,
    ]);
  });
});

describe('ansi', () => {
  const red = '\x1b[38;2;191;97;106mred\x1b[38;2;216;222;233m';
  it('measures and cuts without breaking an escape', () => {
    expect(width(red + 'xx')).toBe(5);
    expect(strip(fit(red + 'xxxx', 5))).toBe('redx…');
    expect(fit(red, 5)).toBe(red + '  ');
    expect(width(fit('⣿⣿⣿', 2))).toBe(2);
    expect(strip(spread('left side', 'right', 12))).toBe('left … right');
    expect(rpad(red, 5)).toBe('  ' + red);
  });
});
