import { describe, expect, it } from 'vitest';
import { getExercise, type ExerciseState } from '@aperture/shared/flux';
import { initialState } from './engine/evaluate';
import { liveReadout } from './readout';

// An evaluator state with some fields set, as the engine would hand it over mid-set.
const with_ = (base: ExerciseState, over: Record<string, unknown>) =>
  ({ ...base, ...over }) as ExerciseState;

describe('liveReadout', () => {
  it('is null with no state, or a state from another kind', () => {
    expect(liveReadout(getExercise('chin-tuck'), null)).toBeNull();
    const rom = initialState(getExercise('cervical-rotation'));
    expect(liveReadout(getExercise('chin-tuck'), rom)).toBeNull();
  });

  it('romReps: both sides count toward one total; the ring times the end-range hold', () => {
    const def = getExercise('cervical-rotation'); // bilateral, 10 reps a side, 4 s hold
    const s = initialState(def);
    expect(liveReadout(def, with_(s, { repsPos: 3, repsNeg: 2 }))).toEqual({
      count: { n: 5, of: 20, unit: 'reps' },
      ring: { progress: 0, label: 'hold', tone: 'teal' },
      note: null,
      done: false,
    });
    expect(liveReadout(def, with_(s, { zone: 'positive', holdAccumSec: 1.2 }))?.ring).toEqual({
      progress: 0.3,
      label: '3',
      tone: 'teal',
    });
    expect(liveReadout(def, with_(s, { zone: 'positive', holdAccumSec: 4.5 }))?.ring).toEqual({
      progress: 1,
      label: '0',
      tone: 'gold',
    });
  });

  it('romReps complete: done, no ring', () => {
    const def = getExercise('cervical-flexion');
    const r = liveReadout(def, with_(initialState(def), { phase: 'complete', repsPos: 10 }));
    expect(r).toMatchObject({ count: { n: 10, of: 10 }, ring: null, done: true });
  });

  it('holdAtTarget: holds done, and a countdown only while in position', () => {
    const def = getExercise('chin-tuck'); // 10 holds of 4 s
    const s = initialState(def);
    expect(liveReadout(def, with_(s, { holdsDone: 2 }))).toMatchObject({
      count: { n: 2, of: 10, unit: 'holds' },
      ring: { progress: 0, label: '—', tone: 'teal' },
    });
    expect(liveReadout(def, with_(s, { inPosition: true, holdElapsedSec: 1 }))?.ring).toEqual({
      progress: 0.25,
      label: '3',
      tone: 'gold',
    });
    expect(liveReadout(def, with_(s, { phase: 'complete', holdsDone: 10 }))).toMatchObject({
      ring: null,
      done: true,
    });
  });

  it('guidedHold: nothing before Start; the current rep and its segment timer while active', () => {
    const def = getExercise('deep-neck-flexor'); // 10 s hold, 5 s rest
    const s = initialState(def);
    expect(liveReadout(def, s)).toBeNull();
    expect(
      liveReadout(
        def,
        with_(s, { phase: 'active', segment: 'hold', segmentElapsedSec: 4, holdsDone: 1 }),
      ),
    ).toMatchObject({
      count: { n: 2, of: 10 },
      ring: { progress: 0.4, label: '6', sublabel: 'HOLD', tone: 'gold' },
    });
    expect(
      liveReadout(
        def,
        with_(s, { phase: 'active', segment: 'rest', segmentElapsedSec: 1, holdsDone: 2 }),
      ),
    ).toMatchObject({ count: { n: 2 }, ring: { label: '4', sublabel: 'rest', tone: 'teal' } });
    expect(
      liveReadout(def, with_(s, { phase: 'active', segment: 'hold', drifting: true }))?.ring?.tone,
    ).toBe('warn');
  });

  it('reposition: trials and a short prompt while active', () => {
    const def = getExercise('joint-position-sense');
    const s = initialState(def);
    expect(liveReadout(def, s)).toBeNull();
    expect(
      liveReadout(def, with_(s, { phase: 'active', sub: 'returning', trialsDone: 3 })),
    ).toEqual({
      count: { n: 3, of: 10, unit: 'trials' },
      ring: null,
      note: 'Back to neutral',
      done: false,
    });
    expect(liveReadout(def, with_(s, { phase: 'complete', trialsDone: 10 }))).toEqual({
      count: { n: 10, of: 10, unit: 'trials' },
      ring: null,
      note: null,
      done: true,
    });
  });

  it('oscillation: whole cycles (no target) and the seconds left', () => {
    const def = getExercise('gaze-stability'); // 30 s
    const s = initialState(def);
    expect(liveReadout(def, s)).toBeNull();
    expect(
      liveReadout(def, with_(s, { phase: 'active', cycles: 7.6, elapsedSec: 12 })),
    ).toMatchObject({
      count: { n: 7, unit: 'cycles' },
      ring: { progress: 0.4, label: '18', sublabel: 'seconds' },
    });
    expect(liveReadout(def, with_(s, { phase: 'active' }))?.count).not.toHaveProperty('of');
    expect(liveReadout(def, with_(s, { phase: 'complete', cycles: 21.3 }))).toMatchObject({
      count: { n: 21 },
      ring: null,
      done: true,
    });
  });
});
