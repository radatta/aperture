import { describe, expect, it } from 'vitest';
import { EXERCISES, getExercise } from '@aperture/shared/flux';
import { hasSide, mirrorForSide } from './side';

describe('side', () => {
  it('only the three one-sided stretches have a side', () => {
    expect(EXERCISES.filter(hasSide).map((d) => d.id)).toEqual([
      'upper-trap-stretch',
      'levator-scapulae-stretch',
      'scalene-stretch',
    ]);
  });

  it('side B negates yaw and roll, keeps pitch', () => {
    const def = mirrorForSide(getExercise('scalene-stretch'), 'b');
    expect(def.kind === 'holdAtTarget' && def.target).toEqual({ roll: 22, yaw: -18, pitch: -10 });
  });

  it('side A and side-less exercises come back unchanged', () => {
    const trap = getExercise('upper-trap-stretch');
    expect(mirrorForSide(trap, 'a')).toBe(trap);
    const chin = getExercise('chin-tuck');
    expect(mirrorForSide(chin, 'b')).toBe(chin);
  });
});
