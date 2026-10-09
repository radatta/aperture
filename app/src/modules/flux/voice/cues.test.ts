import { describe, expect, it } from 'vitest';
import type { ExerciseEvent } from '@aperture/shared/flux';
import { type CueState, initialCueState, reduceCue } from './cues';

/** Fold events at explicit timestamps, collecting the spoken texts. */
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

const rep = (reachedTarget: boolean): ExerciseEvent => ({
  type: 'repCompleted',
  side: 'single',
  peakDeg: 40,
  reachedTarget,
});

describe('reduceCue', () => {
  it('speaks the first eligible event', () => {
    const r = reduceCue(initialCueState, rep(false), 0);
    expect(r.utterance?.text).toBe('Good');
  });

  it('phrases reachedTarget differently', () => {
    expect(reduceCue(initialCueState, rep(true), 0).utterance?.text).toBe('Good, full range');
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
      { e: rep(true), t: 0 },
      { e: { type: 'setCompleted', summary: { count: 10 } }, t: 50 },
    ]);
    expect(out).toEqual(['Good, full range', 'Set complete. Well done.']);
  });

  it('throttles rapid reps but speaks well-spaced ones', () => {
    const out = speak([
      { e: rep(false), t: 0 }, // speak
      { e: rep(false), t: 200 }, // within cooldown+dedup → drop
      { e: rep(false), t: 2000 }, // spaced beyond dedup → speak
    ]);
    expect(out).toEqual(['Good', 'Good']);
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
      { e: rep(false), t: 0 },
      { e: { type: 'holdStarted', index: 0 } as ExerciseEvent, t: 800 },
    ];
    expect(speak(seq)).toEqual(speak(seq));
  });
});
