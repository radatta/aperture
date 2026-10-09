import { describe, expect, it } from 'vitest';
import { EXERCISES, getExercise } from './definitions';
import type { Axis, ExerciseDefinition } from './types';

const AXES: readonly Axis[] = ['pitch', 'yaw', 'roll'];
// Widen from the `as const` literal so optional fields (provocative, …) are visible.
const all: readonly ExerciseDefinition[] = EXERCISES;

describe('exercise definitions', () => {
  it('have unique ids', () => {
    const ids = all.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declare at least one condition and stage', () => {
    for (const e of all) {
      expect(e.conditions.length, e.id).toBeGreaterThan(0);
      expect(e.stages.length, e.id).toBeGreaterThan(0);
    }
  });

  it('give every provocative exercise a contraindication', () => {
    for (const e of all) {
      if (e.provocative) {
        expect(e.contraindications?.length ?? 0, e.id).toBeGreaterThan(0);
      }
    }
  });

  it('have coherent per-kind numeric bounds', () => {
    for (const e of all) {
      switch (e.kind) {
        case 'romReps':
          expect(e.exitDeg, e.id).toBeLessThan(e.enterDeg);
          expect(e.targetDeg, e.id).toBeGreaterThan(0);
          expect(e.reps, e.id).toBeGreaterThan(0);
          break;
        case 'holdAtTarget': {
          expect(e.holdSec, e.id).toBeGreaterThan(0);
          expect(e.reps, e.id).toBeGreaterThan(0);
          expect(e.toleranceDeg, e.id).toBeGreaterThan(0);
          const axes = Object.keys(e.target);
          expect(axes.length, e.id).toBeGreaterThan(0);
          for (const a of axes) expect(AXES, e.id).toContain(a);
          break;
        }
        case 'guidedHold':
          expect(e.holdSec, e.id).toBeGreaterThan(0);
          expect(e.reps, e.id).toBeGreaterThan(0);
          expect(e.restSec, e.id).toBeGreaterThanOrEqual(0);
          break;
        case 'reposition':
          expect(e.excursionDeg, e.id).toBeGreaterThan(0);
          expect(e.settleSec, e.id).toBeGreaterThan(0);
          expect(e.reps, e.id).toBeGreaterThan(0);
          break;
        case 'oscillation':
          expect(e.durationSec, e.id).toBeGreaterThan(0);
          expect(e.targetAmplitudeDeg, e.id).toBeGreaterThan(0);
          expect(e.targetCadenceHz, e.id).toBeGreaterThan(0);
          break;
      }
    }
  });

  it('getExercise returns the matching definition and throws on unknown', () => {
    expect(getExercise('cervical-rotation').name).toBe('Neck Rotation');
    // @ts-expect-error — unknown id is not assignable to ExerciseId
    expect(() => getExercise('nope')).toThrow();
  });
});
