import { describe, expect, it } from 'vitest';
import type { ExerciseEvent } from '@aperture/shared/flux';
import { type CueState, initialCueState, reduceCue } from './cues';

// Fold events at explicit timestamps, collecting the spoken texts.
function speak(events: { e: ExerciseEvent; t: number }[]): string[] {
  let state: CueState = initialCueState;
  const out: string[] = [];
  for (const { e, t } of events) {
    const r = reduceCue(state, e, t);
    state = r.state;
    if (r.utterance) out.push(r.utterance.text);
  }
  return out;
}

const rep = (count: number, reachedTarget = false, holdReached = false): ExerciseEvent => ({
  type: 'repCompleted',
  side: 'single',
  peakDeg: 40,
  reachedTarget,
  holdReached,
  count,
});
const holdUp = (count: number): ExerciseEvent => ({ type: 'holdReached', count });
const SET_DONE: ExerciseEvent = { type: 'setCompleted', summary: { count: 10 } };

describe('reduceCue', () => {
  it('speaks the first eligible event', () => {
    const r = reduceCue(initialCueState, rep(1), 0);
    expect(r.utterance?.text).toBe('One');
  });

  it('counts reps in words whether or not they reached the target, digits past twenty', () => {
    expect(reduceCue(initialCueState, rep(7, true), 0).utterance?.text).toBe('Seven');
    expect(reduceCue(initialCueState, rep(20), 0).utterance?.text).toBe('Twenty');
    expect(reduceCue(initialCueState, rep(21), 0).utterance?.text).toBe('21');
  });

  it('never drops a count, however close together', () => {
    const out = speak([
      { e: rep(1), t: 0 },
      { e: rep(2), t: 200 },
      { e: rep(3), t: 400 },
    ]);
    expect(out).toEqual(['One', 'Two', 'Three']);
  });

  it('a count right after another cue is still spoken', () => {
    const out = speak([
      { e: { type: 'driftWarning', axis: 'yaw', deg: 15 }, t: 0 },
      { e: rep(1), t: 100 },
    ]);
    expect(out).toEqual(['Head still', 'One']);
  });

  it('the final count and Set complete both speak, queued rather than interrupting', () => {
    let state: CueState = initialCueState;
    const out = [rep(10), SET_DONE].map((e) => {
      const r = reduceCue(state, e, 0);
      state = r.state;
      return r.utterance;
    });
    expect(out).toEqual([
      { text: 'Ten', priority: 'always' },
      { text: 'Set complete. Well done.', priority: 'always' },
    ]);
  });

  it('speaks the count when the hold is up and stays quiet on the paired return', () => {
    const out = speak([
      { e: holdUp(3), t: 0 },
      { e: rep(3, true, true), t: 2000 },
    ]);
    expect(out).toEqual(['Three']);
  });

  it('an early return (hold not reached) is still counted aloud', () => {
    expect(reduceCue(initialCueState, rep(4, false, false), 0).utterance?.text).toBe('Four');
  });

  it('a hold-reached count bypasses the gates', () => {
    const r1 = reduceCue(initialCueState, { type: 'driftWarning', axis: 'yaw', deg: 15 }, 0);
    const r2 = reduceCue(r1.state, holdUp(3), 100);
    expect(r2.utterance).toEqual({ text: 'Three', priority: 'always' });
  });

  it('the last count at the hold, then Set complete on the return', () => {
    const out = speak([
      { e: holdUp(20), t: 0 },
      { e: rep(20, true, true), t: 1500 },
      { e: SET_DONE, t: 1500 },
    ]);
    expect(out).toEqual(['Twenty', 'Set complete. Well done.']);
  });

  it('says Back into position after a broken hold, on a 3 s cooldown', () => {
    const broken: ExerciseEvent = { type: 'holdBroken', heldSec: 1.2 };
    const out = speak([
      { e: broken, t: 0 },
      { e: broken, t: 2000 }, // past the 1.2 s dedup, inside the cooldown → dropped by the cooldown
      { e: broken, t: 3500 }, // past the cooldown (and 1.5 s after t 2000, so dedup alone would not drop it)
    ]);
    expect(out).toEqual(['Back into position', 'Back into position']);
  });

  it('And release is never dropped — not by the gap, not by its own repeat', () => {
    expect(
      speak([
        { e: { type: 'positionReached' }, t: 0 },
        { e: { type: 'holdCompleted', index: 0, durationSec: 4 }, t: 100 },
      ]),
    ).toEqual(['Hold it there', 'And release']);
    expect(
      speak([
        { e: { type: 'holdCompleted', index: 0, durationSec: 4 }, t: 0 },
        { e: { type: 'holdCompleted', index: 1, durationSec: 4 }, t: 200 },
      ]),
    ).toEqual(['And release', 'And release']);
  });

  it('is silent for posture warnings (the panel shows them)', () => {
    const r = reduceCue(initialCueState, { type: 'postureWarning', axis: 'roll', deg: 25 }, 0);
    expect(r.utterance).toBeNull();
  });

  it('is silent for cycleCompleted and positionLost', () => {
    expect(
      reduceCue(initialCueState, { type: 'cycleCompleted', amplitudeDeg: 40, cadenceHz: 0.8 }, 0)
        .utterance,
    ).toBeNull();
    expect(reduceCue(initialCueState, { type: 'positionLost' }, 0).utterance).toBeNull();
  });

  it('always speaks setCompleted, even right after another utterance', () => {
    const out = speak([
      { e: { type: 'holdCompleted', index: 0, durationSec: 4 }, t: 0 },
      { e: SET_DONE, t: 50 },
    ]);
    expect(out).toEqual(['And release', 'Set complete. Well done.']);
  });

  it('still gates the other phrases: a second Hold inside the gap is dropped', () => {
    const out = speak([
      { e: { type: 'holdStarted', index: 0 }, t: 0 },
      { e: { type: 'holdStarted', index: 1 }, t: 300 },
      { e: { type: 'holdStarted', index: 2 }, t: 1500 },
    ]);
    expect(out).toEqual(['Hold', 'Hold']);
  });

  it('enforces the driftWarning cooldown', () => {
    const drift: ExerciseEvent = { type: 'driftWarning', axis: 'yaw', deg: 15 };
    const out = speak([
      { e: drift, t: 0 }, // speak
      { e: drift, t: 1000 }, // within 4s cooldown → drop
      { e: drift, t: 5000 }, // after cooldown → speak
    ]);
    expect(out).toEqual(['Head still', 'Head still']);
  });

  it('does not let a dropped candidate reset the cooldown clock', () => {
    const drift: ExerciseEvent = { type: 'driftWarning', axis: 'yaw', deg: 15 };
    const out = speak([
      { e: drift, t: 0 }, // speak (clock = 0)
      { e: drift, t: 3000 }, // dropped; must NOT reset clock
      { e: drift, t: 4500 }, // 4.5s since last SPOKEN → speak
    ]);
    expect(out).toEqual(['Head still', 'Head still']);
  });

  it('is deterministic (pure): same inputs → same output', () => {
    const seq = [
      { e: rep(1), t: 0 },
      { e: { type: 'holdStarted', index: 0 } as ExerciseEvent, t: 800 },
    ];
    expect(speak(seq)).toEqual(speak(seq));
  });
});
