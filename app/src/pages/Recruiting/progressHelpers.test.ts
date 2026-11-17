import { describe, expect, it } from 'vitest';
import type { ProblemRecord } from '@aperture/shared';
import {
  firstTryText,
  triesText,
  parseFilters,
  parsePattern,
  parseView,
  reSolveText,
} from './progressHelpers';

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
  it('tries count every try; the first try is none after a history-only solve', () => {
    const t = (day: string, outcome: 'clean' | 'solved' | 'failed', historical = false) => ({
      day,
      outcome,
      help: 'none' as const,
      cause: null,
      minutes: null,
      note: null,
      historical,
      sittingIds: [],
      attemptIds: [],
    });
    const rec = (tries: ReturnType<typeof t>[]) => {
      const old = tries.filter((x) => x.historical);
      return {
        tries,
        historical: old.length
          ? { tries: old.length, firstDay: old[0]!.day, lastDay: old[old.length - 1]!.day }
          : null,
      } as unknown as ProblemRecord;
    };
    const historyFirst = rec([t('2025-01-01', 'solved', true), t('2026-11-10', 'clean')]);
    expect(triesText(historyFirst)).toBe('2 tries');
    expect(firstTryText(historyFirst)).toBe('–');
    const liveFirst = rec([t('2026-11-01', 'clean'), t('2026-11-16', 'solved', true)]);
    expect(firstTryText(liveFirst)).toBe('clean');
    expect(triesText(rec([t('2025-01-01', 'solved', true)]))).toBe('before the coach');
    expect(firstTryText(rec([t('2026-11-01', 'failed')]))).toBe('not yet');
  });
});
