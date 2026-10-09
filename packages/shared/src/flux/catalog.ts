// Pure presentation helpers over the exercise library: grouping into categories,
// filtering by condition, and contraindication lookup. Kept out of the React
// components so it's unit-testable (no DOM), per the pure-core rule.

import type { Condition, Contraindication, ExerciseDefinition, Stage } from './types';

export type Category =
  'Active Range of Motion' | 'Stretches & Holds' | 'Guided & Isometric' | 'Sensorimotor';

export const CATEGORY_ORDER: readonly Category[] = [
  'Active Range of Motion',
  'Stretches & Holds',
  'Guided & Isometric',
  'Sensorimotor',
];

export function categoryOf(def: ExerciseDefinition): Category {
  if (def.kind === 'romReps')
    return def.measurement === 'measured' ? 'Active Range of Motion' : 'Sensorimotor';
  if (def.kind === 'holdAtTarget') return 'Stretches & Holds';
  if (def.kind === 'guidedHold') return 'Guided & Isometric';
  return 'Sensorimotor'; // reposition, oscillation
}

export function filterByCondition(
  defs: readonly ExerciseDefinition[],
  condition: Condition | null,
): readonly ExerciseDefinition[] {
  if (!condition) return defs;
  return defs.filter((d) => d.conditions.includes(condition));
}

/** Aperture addition: the stage chip. Same shape as filterByCondition. */
export function filterByStage(
  defs: readonly ExerciseDefinition[],
  stage: Stage | null,
): readonly ExerciseDefinition[] {
  if (!stage) return defs;
  return defs.filter((d) => d.stages.includes(stage));
}

/** Lower-case, as the precaution sentence reads ("Caution for herniated disc (acute):"). */
export const CONDITION_LABELS: Readonly<Record<Condition, string>> = {
  herniatedDisc: 'herniated disc',
  sprainStrain: 'sprain / strain',
  general: 'general neck pain',
};

export const STAGE_LABELS: Readonly<Record<Stage, string>> = {
  acute: 'Acute',
  subacute: 'Subacute',
  chronic: 'Chronic',
};

/** The contraindication for a condition (any stage), or null. Warn, don't hide. */
export function contraindicationFor(
  def: ExerciseDefinition,
  condition: Condition | null,
): Contraindication | null {
  if (!condition || !def.contraindications) return null;
  return def.contraindications.find((c) => c.condition === condition) ?? null;
}

export interface CategoryGroup {
  readonly category: Category;
  readonly items: readonly ExerciseDefinition[];
}

export function groupByCategory(defs: readonly ExerciseDefinition[]): readonly CategoryGroup[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: defs.filter((d) => categoryOf(d) === category),
  })).filter((g) => g.items.length > 0);
}

/** Short human label for the measurement honesty of an exercise. */
export function measurementLabel(def: ExerciseDefinition): string {
  switch (def.measurement) {
    case 'measured':
      return 'Measured';
    case 'approximate':
      return 'Approximate';
    case 'guided':
      return 'Guided';
  }
}
