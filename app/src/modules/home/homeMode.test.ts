import { describe, it, expect } from 'vitest';
import { homeModeForHour, homeModeMeta, HOME_MODES } from './homeMode';

describe('homeModeForHour (dayStartHour=4)', () => {
  const cases: Array<[number, string]> = [
    [0, 'night'], // small hours, before the day flips
    [3, 'night'],
    [4, 'morning'], // day-start → morning begins
    [8, 'morning'],
    [11, 'morning'],
    [12, 'day'], // noon
    [15, 'day'],
    [17, 'day'],
    [18, 'night'], // evening
    [22, 'night'],
    [23, 'night'],
  ];
  it.each(cases)('hour %i → %s', (hour, mode) => {
    expect(homeModeForHour(hour, 4)).toBe(mode);
  });
});

describe('homeModeForHour respects a custom dayStartHour', () => {
  it('a 6am start keeps 5am as night', () => {
    expect(homeModeForHour(5, 6)).toBe('night');
    expect(homeModeForHour(6, 6)).toBe('morning');
  });
});

describe('mode metadata', () => {
  it('covers every mode with a label + tagline', () => {
    for (const m of HOME_MODES) {
      expect(homeModeMeta[m].label).toBeTruthy();
      expect(homeModeMeta[m].tagline).toBeTruthy();
    }
  });
});
