// lib/coach.js: the resubmit note's rules and the config event — pure, on a given clock.
import { describe, expect, it } from 'vitest';
import { coachMarkOf, normalizeSittingEvents } from '@aperture/shared';
import { lib } from './load';

const coach = lib('coach');
const ulid = lib('ulid');
const ON = coach.settingsOf(null);
let n = 0;
const mint = () => `id${n++}`;

describe('settings', () => {
  it('reads the note’s switch as on unless stored false, or a saved submit: null; the retired card’s switches change nothing', () => {
    expect(ON).toEqual({ nudge: true });
    expect(coach.settingsOf({})).toEqual(ON);
    expect(coach.settingsOf({ coachNudge: 0 })).toEqual(ON); // only `false` turns it off
    expect(coach.settingsOf({ coachNudge: false })).toEqual({ nudge: false });
    expect(coach.settingsOf({ coachTrace: true, coachHold: true })).toEqual(ON);
    // The retired `submit: null` (the note off before 2.2.1) still reads as off until Options carries it over.
    expect(coach.settingsOf({ selectors: { submit: null } })).toEqual({ nudge: false });
    expect(coach.settingsOf({ selectors: { submit: '#s' } })).toEqual(ON);
    expect(coach.settingsOf({ selectors: '{"submit": null}' })).toEqual(ON); // only a stored object counts
    expect(coach.KEYS).toEqual({ nudge: 'coachNudge' });
    expect(coach.RETIRED_KEYS).toEqual(['coachTrace', 'coachHold']);
  });
  it('config says whether the note is on, and nothing else', () => {
    expect(coach.configPayload(ON)).toEqual({ kind: 'config', nudge: true });
    expect(coach.configPayload(coach.settingsOf({ coachNudge: false })).nudge).toBe(false);
  });
  it('wraps a payload as a coach event', () => {
    expect(coach.event({ kind: 'nudge-shown', gapMs: 1 }, mint, 42)).toMatchObject({
      type: 'coach',
      at: 42,
      payload: { kind: 'nudge-shown', gapMs: 1 },
    });
  });
  it('has no card left', () => {
    for (const gone of ['cardPayload', 'shouldHold', 'traceInputs', 'FIELDS', 'INPUT_MAX'])
      expect(coach[gone]).toBeUndefined();
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

// What the extension makes, through the server's own rules (packages/shared): accepted, and read as meant.
describe('against the shared contract', () => {
  it('both coach payloads it still sends pass the events normalizer and its head-row read', () => {
    const payloads = [coach.configPayload(ON), { kind: 'nudge-shown', gapMs: 30_000 }];
    const events = payloads.map((p, i) => coach.event(p, ulid.ulid, 1_800_000_000_000 + i));
    expect(() => normalizeSittingEvents({ sittingId: ulid.ulid(), events })).not.toThrow();
    expect(payloads.map((p) => coachMarkOf(p))).toEqual([
      { kind: 'config', config: { nudge: true } },
      { kind: 'nudge-shown', config: null },
    ]);
  });
});
