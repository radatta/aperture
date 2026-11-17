import { describe, expect, it } from 'vitest';
import { fmtPastDay, parseFilters, parsePattern, parseView, reSolveText } from './progressHelpers';

const TODAY = '2026-11-17';
const st = (o: object) => ({
  state: 'clean' as const,
  done: true,
  dueSince: null,
  nextDue: null,
  graduated: false,
  ...o,
});

describe('progress helpers', () => {
  it('parses the URL state, falling back on anything unknown', () => {
    expect(parseView(null)).toBe('map');
    expect(parseView('trends')).toBe('trends');
    expect(parseView('bogus')).toBe('map');
    expect(parsePattern('graphs')).toBe('graphs');
    expect(parsePattern('other')).toBeNull();
    expect(parsePattern('nope')).toBeNull();
    expect(parseFilters(new URLSearchParams('pattern=other&status=due&difficulty=Hard'))).toEqual({
      pattern: 'other',
      status: 'due',
      difficulty: 'Hard',
    });
    expect(parseFilters(new URLSearchParams('status=great&difficulty=hard'))).toEqual({
      pattern: null,
      status: null,
      difficulty: null,
    });
  });
  it('says a past day as a person would, naming another year', () => {
    expect(fmtPastDay(TODAY, TODAY)).toBe('today');
    expect(fmtPastDay('2026-11-16', TODAY)).toBe('yesterday');
    expect(fmtPastDay('2026-10-02', TODAY)).toBe('October 2');
    expect(fmtPastDay('2024-03-01', TODAY)).toBe('March 1, 2024');
  });
  it('the re-solve line: due, next, graduated, out of the queue, none', () => {
    expect(reSolveText(st({ dueSince: TODAY }), TODAY)).toBe('Re-solve due today');
    expect(reSolveText(st({ dueSince: '2026-11-14' }), TODAY)).toBe(
      'Re-solve due since November 14',
    );
    expect(reSolveText(st({ nextDue: '2026-11-18' }), TODAY)).toBe('Next re-solve tomorrow');
    expect(reSolveText(st({ graduated: true }), TODAY)).toBe('Graduated: no more re-solves');
    expect(reSolveText(st({ state: 'earlier' }), TODAY)).toBe('Not in the re-solve queue');
    expect(reSolveText(st({ state: 'untried', done: false }), TODAY)).toBeNull();
  });
});
