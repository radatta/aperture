import { describe, expect, it } from 'vitest';
import {
  CONDITION_LABELS,
  categoryOf,
  contraindicationFor,
  filterByCondition,
  filterByStage,
  groupByCategory,
  STAGE_LABELS,
} from './catalog';
import { EXERCISES, FLUX_EXERCISE_IDS, getExercise, isExerciseId } from './definitions';
import type { ExerciseDefinition } from './types';

const all: readonly ExerciseDefinition[] = EXERCISES;

describe('catalog', () => {
  it('assigns each exercise to exactly one category', () => {
    for (const e of all) expect(categoryOf(e), e.id).toBeTruthy();
    const total = groupByCategory(all).reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(all.length);
  });

  it('sorts measured ROM into Active Range of Motion', () => {
    expect(categoryOf(getExercise('cervical-rotation'))).toBe('Active Range of Motion');
    // eye-head is romReps but approximate → sensorimotor, not Active ROM
    expect(categoryOf(getExercise('eye-head-coordination'))).toBe('Sensorimotor');
  });

  it('filters by condition and keeps only matching exercises', () => {
    const disc = filterByCondition(all, 'herniatedDisc');
    expect(disc.length).toBeGreaterThan(0);
    for (const e of disc) expect(e.conditions).toContain('herniatedDisc');
    expect(filterByCondition(all, null)).toHaveLength(all.length);
  });

  it('surfaces a contraindication for the matching condition', () => {
    const ext = getExercise('cervical-extension');
    expect(contraindicationFor(ext, 'herniatedDisc')?.stage).toBe('acute');
    expect(contraindicationFor(ext, 'general')).toBeNull();
    expect(contraindicationFor(getExercise('cervical-rotation'), 'herniatedDisc')).toBeNull();
  });
});

describe('Aperture additions', () => {
  it('filterByStage keeps only exercises prescribed for that stage', () => {
    const acute = filterByStage(EXERCISES, 'acute');
    expect(acute.length).toBeGreaterThan(0);
    expect(acute.every((d) => d.stages.includes('acute'))).toBe(true);
    expect(filterByStage(EXERCISES, null)).toBe(EXERCISES);
  });

  it('labels every condition and stage', () => {
    expect(Object.keys(CONDITION_LABELS).sort()).toEqual([
      'general',
      'herniatedDisc',
      'sprainStrain',
    ]);
    expect(Object.keys(STAGE_LABELS).sort()).toEqual(['acute', 'chronic', 'subacute']);
  });

  it('isExerciseId accepts every catalog id and nothing else', () => {
    expect(FLUX_EXERCISE_IDS).toHaveLength(EXERCISES.length);
    expect(FLUX_EXERCISE_IDS.every(isExerciseId)).toBe(true);
    expect(isExerciseId('nope')).toBe(false);
  });
});
