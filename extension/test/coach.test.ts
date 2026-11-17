// lib/coach.js: the trace card's rules, the hold, the resubmit note — pure, on a given clock.
import { describe, expect, it } from 'vitest';
import { lib } from './load';

const coach = lib('coach');
const ON = coach.settingsOf(null);
let n = 0;
const mint = () => `id${n++}`;

describe('settings', () => {
  it('reads each switch as on unless stored false; the hold needs the card', () => {
    expect(ON).toEqual({ trace: true, hold: true, nudge: true });
    expect(coach.settingsOf({})).toEqual(ON);
    expect(coach.settingsOf({ coachTrace: 'no', coachHold: 0 })).toEqual(ON); // only `false` turns one off
    expect(coach.settingsOf({ coachHold: false })).toEqual({ trace: true, hold: false, nudge: true });
    expect(coach.settingsOf({ coachTrace: false })).toEqual({ trace: false, hold: false, nudge: true });
    expect(coach.settingsOf({ coachNudge: false }).nudge).toBe(false);
    expect(coach.configPayload(coach.settingsOf({ coachTrace: false }))).toEqual({
      kind: 'config',
      trace: false,
      hold: false,
      nudge: true,
    });
  });
});

describe('the card', () => {
  it('sends the three traces trimmed and clipped at 300; blank fields are null', () => {
    const p = coach.cardPayload(
      { empty: '  [] -> []  ', boundary: 'x'.repeat(400), normal: '   ', extra: 'ignored' },
      1234.6,
    );
    expect(p).toEqual({
      kind: 'trace',
      inputs: { empty: '[] -> []', boundary: 'x'.repeat(300), normal: null },
      ms: 1235,
    });
  });
  it('a trace with nothing typed is a skip; a bad time is 0', () => {
    expect(coach.cardPayload({ empty: ' ', boundary: '', normal: null }, 900)).toEqual({
      kind: 'trace-skip',
      ms: 900,
    });
    expect(coach.cardPayload(null, Number.NaN)).toEqual({ kind: 'trace-skip', ms: 0 });
    expect(coach.cardPayload({ empty: 7 }, -5)).toEqual({ kind: 'trace-skip', ms: 0 });
  });
  it('wraps a payload as a coach event', () => {
    expect(coach.event({ kind: 'untraced-submit' }, mint, 42)).toMatchObject({
      type: 'coach',
      at: 42,
      payload: { kind: 'untraced-submit' },
    });
  });
});

describe('the hold', () => {
  const base = { settings: ON, trusted: true, active: true, coach: {} };
  it('holds the first real Submit in an open sitting', () => {
    expect(coach.shouldHold(base)).toBe(true);
    expect(coach.shouldHold({ ...base, coach: null })).toBe(true); // a binding from before the coach
  });
  it('never holds a page script’s click, outside a sitting, with the hold off, or twice', () => {
    expect(coach.shouldHold({ ...base, trusted: false })).toBe(false);
    expect(coach.shouldHold({ ...base, active: false })).toBe(false);
    expect(coach.shouldHold({ ...base, settings: coach.settingsOf({ coachHold: false }) })).toBe(
      false,
    );
    expect(coach.shouldHold({ ...base, settings: coach.settingsOf({ coachTrace: false }) })).toBe(
      false,
    );
    expect(coach.shouldHold({ ...base, coach: { held: true } })).toBe(false);
    for (const trace of ['traced', 'skipped', 'untraced'])
      expect(coach.shouldHold({ ...base, coach: { trace } })).toBe(false);
  });
});

describe('the resubmit note', () => {
  const failed = { at: 1_000_000, verdict: 'failed' };
  it('reads only LeetCode’s raw status code: 10 is Accepted, any other number failed', () => {
    expect(coach.verdictOf({ result: { state: 'SUCCESS', status_code: 10 } })).toBe('accepted');
    expect(coach.verdictOf({ result: { state: 'SUCCESS', status_code: 11 } })).toBe('failed');
    expect(coach.verdictOf({ result: { status_code: 20 } })).toBe('failed');
    expect(coach.verdictOf({ result: { pending: true } })).toBeNull();
    expect(coach.verdictOf({ result: { status_code: '10' } })).toBeNull();
    expect(coach.verdictOf({ result: null })).toBeNull();
    expect(coach.verdictOf(null)).toBeNull();
  });
  it('shows at 30 s after a failed verdict, not at 90 s, never after Accepted', () => {
    const gap = (last: unknown, now: number, settings = ON) =>
      coach.nudgeGap({ settings, last, now });
    expect(gap(failed, failed.at + 30_000)).toBe(30_000);
    expect(gap(failed, failed.at + 60_000)).toBe(60_000);
    expect(gap(failed, failed.at + 90_000)).toBeNull();
    expect(gap({ ...failed, verdict: 'accepted' }, failed.at + 30_000)).toBeNull();
    expect(gap(null, failed.at)).toBeNull();
    expect(gap(failed, failed.at - 1)).toBeNull(); // a clock step back
    expect(gap(failed, failed.at + 30_000, coach.settingsOf({ coachNudge: false }))).toBeNull();
  });
});
