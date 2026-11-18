import { describe, expect, it } from 'vitest';
import { zonedEpoch } from './dates';
import { dueClock, resolveSpoken, spokenTimeIn, withoutRelative } from './spokenTime';

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

  it('reads half past, quarter past and quarter to with the am/pm of the hour named', () => {
    const clock = (line: string) => {
      const t = spokenTimeIn(line);
      return t?.kind === 'clock' ? [t.hhmm, t.said] : t;
    };
    expect(clock('call mum at half past five pm')).toEqual(['17:30', 'half past five pm']);
    expect(clock('call mum at half past 5 p.m.')).toEqual(['17:30', 'half past 5 p.m.']);
    expect(clock('stretch quarter past 9 am')).toEqual(['09:15', 'quarter past 9 am']);
    expect(clock('call the bank quarter to six PM')).toEqual(['17:45', 'quarter to six PM']);
    expect(clock('quarter to 12 pm')).toEqual(['11:45', 'quarter to 12 pm']);
    expect(clock('quarter to 12 am')).toEqual(['23:45', 'quarter to 12 am']);
    expect(clock('half past 12 am')).toEqual(['00:30', 'half past 12 am']);
    // Without am/pm the grammar still has nothing to read: the model's clock takes over (quickParse.ts).
    expect(spokenTimeIn('call mum at half past five')).toBeNull();
    expect(said('call mum at half past five pm', MON, '15:00')).toBe('2026-11-16 17:30');
  });

  it('takes relative first, then a stated clock, then a bare hour, then a day-part', () => {
    expect(spokenTimeIn('call mum in 20 minutes at 5')).toEqual({
      said: 'in 20 minutes',
      kind: 'relative',
      minutes: 20,
    });
    expect(spokenTimeIn('call mum at 9 am tonight')).toEqual({
      said: '9 am',
      kind: 'clock',
      hhmm: '09:00',
    });
    expect(spokenTimeIn('call mum at 8 tonight')).toEqual({
      said: 'at 8',
      kind: 'bare',
      hour: 8,
      minute: 0,
      part: 'tonight',
    });
    expect(spokenTimeIn('call mum tonight')).toEqual({
      said: 'tonight',
      kind: 'part',
      part: 'tonight',
    });
  });

  it("a bare hour's day-part: beside it in any form, or anywhere as a time phrase — never a noun elsewhere", () => {
    const part = (line: string) => {
      const t = spokenTimeIn(line);
      return t?.kind === 'bare' ? t.part : `not bare: ${JSON.stringify(t)}`;
    };
    expect(part('remind me at 5 to send the morning report')).toBeNull();
    expect(part('at 9 book the night bus')).toBeNull();
    expect(part('remind me tomorrow morning to go for a run at 6')).toBe('morning');
    expect(part('remind me tonight to call mum at 9')).toBe('tonight');
    // "<day> night" is tonight's part, so the small-hours rule holds ("at 1 friday night" is after Friday).
    expect(part('call mum at 1 friday night')).toBe('tonight');
    expect(part('call mum friday night at 9')).toBe('tonight');
    expect(part('call mum tomorrow morning at 9')).toBe('morning');
    expect(part('call mum at 9 friday morning')).toBe('morning');
    expect(part('call mum at 9 on friday morning')).toBe('morning');
    expect(part('call mum tonight at 9')).toBe('tonight');
    expect(part("call mum at 8 o'clock tonight")).toBe('tonight');
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
    // "at 5 o'clock" is said whole, o'clock and all.
    expect(spokenTimeIn("call mum at 5 o'clock")?.said).toBe("at 5 o'clock");
    expect(spokenTimeIn('call mum at five oclock today')?.said).toBe('at five oclock');
    expect(bare('call mum at 5:30')).toBe('5:30');
    expect(bare('call mum at 13')).toBeNull();
    // A minute the grammar can't read: no time at all, so the model's clock takes over.
    expect(spokenTimeIn('call mum at five twenty pm')).toBeNull();
    expect(spokenTimeIn('call mum at 5 20')).toBeNull();
    expect(bare("call mum at five o'clock one more time")).toBe('5:0');
    expect(bare("call mum at 5 o'clock 2 times")).toBe('5:0');
    expect(spokenTimeIn('call mum at seven forty')).toBeNull();
    expect(bare('call mum at five thirty')).toBe('5:30');
    expect(bare('call mum at 8 forty five')).toBe('8:45');
    const s = spokenTimeIn('call mum at five thirty pm');
    expect(s).toMatchObject({ kind: 'clock', hhmm: '17:30', said: 'five thirty pm' });
  });

  it('withoutRelative drops the delay so it never reads as an estimate', () => {
    expect(withoutRelative('call mum in 20 minutes')).toBe('call mum');
    expect(withoutRelative('stretch 20 minutes in an hour')).toBe('stretch 20 minutes');
  });
});

describe('resolveSpoken — the voice rules', () => {
  it('relative: now + N, rounded up to the minute, on whatever day that lands', () => {
    expect(said('in 20 minutes', MON, '14:10')).toBe('2026-11-16 14:30');
    const r = resolveSpoken({ said: 'in 20 minutes', kind: 'relative', minutes: 20 }, null, {
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

  it('"at 12 tonight" is midnight and 1–3 tonight the small hours; 4–11 tonight the evening', () => {
    expect(said('call mum at 12 tonight', MON, '21:00')).toBe('2026-11-17 00:00');
    expect(said('call mum at 1 tonight', MON, '21:00')).toBe('2026-11-17 01:00');
    expect(said('call mum at 11 tonight', MON, '21:00')).toBe('2026-11-16 23:00');
    expect(said('friday at 1 tonight', MON, '10:00', '2026-11-20')).toBe('2026-11-21 01:00');
  });

  it('a past day from the model is not a named day: the time rolls forward', () => {
    expect(said('call mum monday at 9 am', MON, '15:00', '2026-11-09')).toBe('2026-11-17 09:00');
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

describe('dueClock — a stated clock phrased as a due', () => {
  const said = (line: string) => spokenTimeIn(line)!.said;
  const strip = (line: string, title = line) => dueClock(line, title, said(line))?.title ?? null;
  it('at / by / due at / due by, any case and spacing, takes the phrase out of the title', () => {
    expect(strip('call the bank at 1 am')).toBe('call the bank');
    expect(strip('call the bank at 1am')).toBe('call the bank');
    expect(strip('call the bank AT 1 AM')).toBe('call the bank');
    expect(strip('call the bank by 5 p.m.')).toBe('call the bank');
    expect(strip('call the bank at 1 am.')).toBe('call the bank');
    expect(strip('pay rent due by midnight, then sleep')).toBe('pay rent, then sleep');
    expect(strip('At noon, call mum')).toBe('call mum');
    expect(strip('submit at 17:30')).toBe('submit');
    // The model wrote the clock its own way: the line decides, the title strips what it can.
    expect(strip('call the bank at 1am', 'call the bank at 1 am')).toBe('call the bank');
    expect(strip('call the bank at 1 am', 'call the bank')).toBe('call the bank');
    expect(strip('call the bank at 5 p.m.', 'call the bank at 5 PM')).toBe('call the bank');
    expect(strip('call the bank at 5pm', 'call the bank at 5 p.m.')).toBe('call the bank');
    // A title the model already cleaned is left exactly as it wrote it.
    expect(strip('.env cleanup at 5pm', '.env cleanup')).toBe('.env cleanup');
    expect(strip('--force flag docs by noon', '--force flag docs ,')).toBe('--force flag docs ,');
    // Words kept: only the join is tidied, never the title's own leading punctuation.
    expect(strip('.env cleanup at 5pm')).toBe('.env cleanup');
    expect(strip('--force flag docs by noon')).toBe('--force flag docs');
    expect(strip('-- call the bank, at 1 am, then lunch')).toBe('-- call the bank, then lunch');
    expect(strip('fix login - by 5pm')).toBe('fix login');
    expect(strip('At 5pm - call mum')).toBe('call mum');
  });
  it('a clock not after at/by is not a due; a phrase that is the whole title leaves it whole', () => {
    expect(strip('watch 9pm show')).toBeNull();
    expect(strip('email the team about the 3pm meeting')).toBeNull();
    expect(strip('move the 3pm to 5pm')).toBeNull();
    expect(strip('the cat 1 am wake-up')).toBeNull();
    // A second stated clock: which is the due is the model's call.
    expect(strip('move standup at 3pm to 5pm')).toBeNull();
    expect(strip('call at 9am about the 3pm meeting')).toBeNull();
    expect(strip('at 9am')).toBe('at 9am');
  });
});
