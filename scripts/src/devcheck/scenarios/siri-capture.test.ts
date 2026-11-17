import { describe, expect, it } from 'vitest';
import {
  SAY_KEYS,
  SHARED_FUNCTIONS,
  SHARED_NUMBERS,
  aheadClock,
  laClock,
  loadShared,
  rollClock,
  untilLaMidnight,
  untilUtcMidnight,
  wrapHour,
} from './siri-capture';

// The time rows' lines, checked against the shared resolver at every LA hour and both ends of an hour: the
// wrap line always wraps 10–12 h on, the roll line always lands tomorrow, the ahead line never rolls — so a
// dev row can only fail on what the server did, never on when the run happened.
describe('siri-capture’s spoken lines', () => {
  const day = '2026-11-16'; // PST all day
  const at = (hour: number, minute: number) =>
    Date.parse(
      `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-08:00`,
    );

  it('reads the LA wall clock', () => {
    expect(laClock(at(0, 7))).toEqual({ hour: 0, minute: 7 });
    expect(laClock(at(23, 59))).toEqual({ hour: 23, minute: 59 });
  });

  it('every hour: the bare hour wraps, the past clock rolls to tomorrow, the clock ahead stays ahead', async () => {
    const S = await loadShared();
    const resolve = (text: string, now: number) => {
      const spoken = S.spokenTimeIn(text);
      expect(spoken, text).not.toBeNull();
      const r = S.resolveSpoken(spoken!, null, { now, today: day });
      return { ...r, at: S.zonedEpoch(r.day, r.time, S.USER_TIME_ZONE) };
    };
    for (let hour = 0; hour < 24; hour++)
      for (const minute of [0, 1, 30, 54, 55, 59]) {
        const now = at(hour, minute) + 1_000;
        const wrap = resolve(`devcheck n1 water the plants at ${wrapHour(hour, minute)}`, now);
        expect(wrap.at - now, `wrap ${hour}:${minute}`).toBeGreaterThan(10 * 3_600_000);
        expect(wrap.at - now, `wrap ${hour}:${minute}`).toBeLessThanOrEqual(12 * 3_600_000);
        const roll = resolve(`devcheck n1 call the bank at ${rollClock(hour)}`, now);
        expect(roll.day, `roll ${hour}:${minute}`).toBe(S.addDays(day, 1));
        const ahead = resolve(`devcheck n1 call the plumber at ${aheadClock(hour)}`, now);
        expect(ahead.at - now, `ahead ${hour}:${minute}`).toBeGreaterThan(2 * 3_600_000);
        expect(ahead.at - now, `ahead ${hour}:${minute}`).toBeLessThan(3 * 3_600_000);
      }
  });

  it('the nonce never reads as a time', async () => {
    const S = await loadShared();
    // A full run's nonce: the run id's digits and its tier (pipeline.ts).
    expect(S.spokenTimeIn('devcheck 172300full stretch')).toBeNull();
    expect(S.spokenTimeIn('devcheck 0900000all water the plants')).toBeNull();
  });

  it('loads every say, number and rule the scenario reads from shared', async () => {
    const S = (await loadShared()) as unknown as Record<string, unknown>;
    const say = S.CAPTURE_SAY as Record<string, unknown>;
    for (const k of SAY_KEYS) expect(typeof say[k], `CAPTURE_SAY.${k}`).toBe('string');
    for (const k of SHARED_NUMBERS) expect(Number.isInteger(S[k]), k).toBe(true);
    for (const k of SHARED_FUNCTIONS) expect(typeof S[k], k).toBe('function');
    expect(S.USER_TIME_ZONE).toBe('America/Los_Angeles');
  });

  it('counts down to LA’s and UTC’s midnights', () => {
    expect(untilLaMidnight(at(23, 59) + 30_000)).toBe(30_000);
    expect(untilLaMidnight(at(0, 0))).toBe(24 * 3_600_000);
    expect(untilUtcMidnight(Date.parse('2026-11-16T23:58:30Z'))).toBe(90_000);
  });
});
