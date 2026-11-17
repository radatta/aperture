import { describe, expect, it } from 'vitest';
import { zonedEpoch } from './dates';
import { resolveSpoken, spokenTimeIn, withoutRelative } from './spokenTime';

const LA = 'America/Los_Angeles';
const MON = '2026-11-16'; // a Monday
const at = (day: string, hhmm: string) => zonedEpoch(day, hhmm, LA);
// What a line resolves to at a wall-clock moment in LA; `modelDay` is the day the model read (null: none).
// The app's today follows the 4am day start, as the server's would.
function said(line: string, nowDay: string, nowHHMM: string, modelDay: string | null = null) {
  const spoken = spokenTimeIn(line);
  if (!spoken) return null;
  const today = nowHHMM < '04:00' ? '2026-11-15' : nowDay;
  const r = resolveSpoken(spoken, modelDay, { now: at(nowDay, nowHHMM), today });
  return `${r.day} ${r.time}`;
}

describe('spokenTimeIn', () => {
  it('finds nothing in a line with no time', () => {
    for (const line of [
      'call mum',
      'buy 5 apples',
      'do it at once',
      'read chapter 12',
      'at the store',
    ])
      expect(spokenTimeIn(line)).toBeNull();
  });

  it('takes relative first, then a stated clock, then a bare hour, then a day-part', () => {
    expect(spokenTimeIn('call mum in 20 minutes at 5')).toEqual({ kind: 'relative', minutes: 20 });
    expect(spokenTimeIn('call mum at 9 am tonight')).toEqual({ kind: 'clock', hhmm: '09:00' });
    expect(spokenTimeIn('call mum at 8 tonight')).toEqual({
      kind: 'bare',
      hour: 8,
      minute: 0,
      part: 'tonight',
    });
    expect(spokenTimeIn('call mum tonight')).toEqual({ kind: 'part', part: 'tonight' });
  });

  it('reads the relative phrases Siri writes', () => {
    const mins = (line: string) => {
      const s = spokenTimeIn(line);
      return s?.kind === 'relative' ? s.minutes : null;
    };
    expect(mins('in 20 minutes')).toBe(20);
    expect(mins('in twenty minutes')).toBe(20);
    expect(mins('in 5 mins')).toBe(5);
    expect(mins('in an hour')).toBe(60);
    expect(mins('in a minute')).toBe(1);
    expect(mins('in half an hour')).toBe(30);
    expect(mins('in 2 hours')).toBe(120);
    expect(mins('in 1.5 hours')).toBe(90);
    expect(mins('in an hour and a half')).toBe(90);
    expect(mins('in forty five minutes')).toBe(45);
  });

  it('reads stated clocks: am/pm in any spelling, 24-hour, noon, midnight', () => {
    const clock = (line: string) => {
      const s = spokenTimeIn(line);
      return s?.kind === 'clock' ? s.hhmm : null;
    };
    expect(clock('at 5 PM')).toBe('17:00');
    expect(clock('at 5 p.m.')).toBe('17:00');
    expect(clock('9am')).toBe('09:00');
    expect(clock('at 9:30 am')).toBe('09:30');
    expect(clock('at 12 am')).toBe('00:00');
    expect(clock('at 12 pm')).toBe('12:00');
    expect(clock('at five pm')).toBe('17:00');
    expect(clock('at 17:00')).toBe('17:00');
    expect(clock('at 09:30')).toBe('09:30');
    expect(clock('lunch at noon')).toBe('12:00');
    expect(clock('by midnight')).toBe('00:00');
  });

  it("reads bare hours: at N, N o'clock, at N:MM, number words", () => {
    const bare = (line: string) => {
      const s = spokenTimeIn(line);
      return s?.kind === 'bare' ? `${s.hour}:${s.minute}` : null;
    };
    expect(bare('call mum at 5')).toBe('5:0');
    expect(bare('call mum at five')).toBe('5:0');
    expect(bare("call mum at 5 o'clock")).toBe('5:0');
    expect(bare('call mum five o’clock')).toBe('5:0');
    expect(bare('call mum at 5:30')).toBe('5:30');
    expect(bare('call mum at 13')).toBeNull();
  });

  it('withoutRelative drops the delay so it never reads as an estimate', () => {
    expect(withoutRelative('call mum in 20 minutes')).toBe('call mum');
    expect(withoutRelative('stretch 20 minutes in an hour')).toBe('stretch 20 minutes');
  });
});

describe('resolveSpoken — the voice rules', () => {
  it('relative: now + N, rounded up to the minute, on whatever day that lands', () => {
    expect(said('in 20 minutes', MON, '14:10')).toBe('2026-11-16 14:30');
    const r = resolveSpoken({ kind: 'relative', minutes: 20 }, null, {
      now: at(MON, '14:10') + 30_000,
      today: MON,
    });
    expect(r).toEqual({ day: MON, time: '14:31' });
    expect(said('in 2 hours', MON, '23:00')).toBe('2026-11-17 01:00');
    // A named day doesn't move a relative time.
    expect(said('in an hour', MON, '14:10', '2026-11-20')).toBe('2026-11-16 15:10');
  });

  it('a bare hour is the next N o’clock, wrapping (decision 1)', () => {
    expect(said('at 5', MON, '02:00')).toBe('2026-11-16 05:00');
    expect(said('at 5', MON, '06:00')).toBe('2026-11-16 17:00');
    expect(said("five o'clock", MON, '06:00')).toBe('2026-11-16 17:00');
    expect(said('at 5', MON, '18:00')).toBe('2026-11-17 05:00');
    expect(said('at 5:30', MON, '06:00')).toBe('2026-11-16 17:30');
    expect(said('at 12', MON, '06:00')).toBe('2026-11-16 12:00');
    expect(said('at 12', MON, '13:00')).toBe('2026-11-17 00:00');
  });

  it('the minute edge: a time equal to now is past', () => {
    expect(said('at 5', MON, '16:59')).toBe('2026-11-16 17:00');
    expect(said('at 5', MON, '17:00')).toBe('2026-11-17 05:00');
    expect(said('at 5 pm', MON, '17:00')).toBe('2026-11-17 17:00');
  });

  it('a stated time already past rolls to its next occurrence (decision 2)', () => {
    expect(said('at 9 am', MON, '15:00')).toBe('2026-11-17 09:00');
    expect(said('at 9 am', MON, '08:00')).toBe('2026-11-16 09:00');
    // "today" is not a named day: it rolls too.
    expect(said('today at 9 am', MON, '15:00', MON)).toBe('2026-11-17 09:00');
    expect(said('lunch at noon', MON, '13:00')).toBe('2026-11-17 12:00');
    expect(said('by midnight', MON, '22:00')).toBe('2026-11-17 00:00');
    expect(said('at 17:00', MON, '18:00')).toBe('2026-11-17 17:00');
  });

  it('in the small hours "today" means the calendar date, and the app day isn’t named either', () => {
    // 01:00 Monday: the app's today is still Sunday; neither counts as a named day.
    expect(said('at 9 am', MON, '01:00', '2026-11-15')).toBe('2026-11-16 09:00');
    expect(said('at 9 am', MON, '01:00', MON)).toBe('2026-11-16 09:00');
  });

  it('morning is 9 AM and tonight 8 PM (decision 3), each rolling when past', () => {
    expect(said('tonight', MON, '15:00')).toBe('2026-11-16 20:00');
    expect(said('tonight', MON, '21:00')).toBe('2026-11-17 20:00');
    expect(said('this morning', MON, '10:00')).toBe('2026-11-17 09:00');
    expect(said('in the morning', MON, '06:00')).toBe('2026-11-16 09:00');
    expect(said('tomorrow morning', MON, '15:00', '2026-11-17')).toBe('2026-11-17 09:00');
  });

  it('a day-part picks AM or PM for a bare hour', () => {
    expect(said('at 8 tonight', MON, '10:00')).toBe('2026-11-16 20:00');
    expect(said('at 8 in the morning', MON, '10:00')).toBe('2026-11-17 08:00');
    expect(said('at 8 in the morning', MON, '06:00')).toBe('2026-11-16 08:00');
    expect(said('tomorrow at 7 in the morning', MON, '06:00', '2026-11-17')).toBe(
      '2026-11-17 07:00',
    );
  });

  it('a named day keeps its day; a bare hour on it is the daytime one (07:00–18:59)', () => {
    const FRI = '2026-11-20';
    expect(said('friday at 5', MON, '10:00', FRI)).toBe('2026-11-20 17:00');
    expect(said('friday at 9', MON, '10:00', FRI)).toBe('2026-11-20 09:00');
    expect(said('friday at 12', MON, '10:00', FRI)).toBe('2026-11-20 12:00');
    expect(said('friday at 6:30', MON, '10:00', FRI)).toBe('2026-11-20 18:30');
    expect(said('friday at 7', MON, '10:00', FRI)).toBe('2026-11-20 07:00');
    expect(said('friday at 5 am', MON, '10:00', FRI)).toBe('2026-11-20 05:00');
    expect(said('friday morning', MON, '10:00', FRI)).toBe('2026-11-20 09:00');
  });

  it('DST: spring-forward and fall-back days resolve on the wall clock', () => {
    // 2026-03-08 springs forward at 2am: an hour from 1:30 is 3:30.
    expect(said('in an hour', '2026-03-08', '01:30')).toBe('2026-03-08 03:30');
    expect(said('at 5', '2026-03-08', '01:00')).toBe('2026-03-08 05:00');
    // 2026-11-01 falls back at 2am: 1:30 happens twice; an hour from the first is the second.
    expect(said('in an hour', '2026-11-01', '01:30')).toBe('2026-11-01 01:30');
    expect(said('at 5', '2026-11-01', '01:00')).toBe('2026-11-01 05:00');
  });
});
