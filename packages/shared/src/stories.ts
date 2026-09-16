// Competency tags for the behavioral story bank — a FIXED set, shipped as a constant. The editor can
// only emit these, so the vocabulary stays stable across stories (which is what makes tagging useful for
// recall). It is deliberately NOT the Category entity (that's editable CRUD): this set changes with a
// code edit, rarely. The union type is derived from the const so the two can never drift.
export const COMPETENCY_TAGS = [
  'leadership',
  'conflict',
  'ownership',
  'failure',
  'ambiguity',
  'impact',
] as const;

export type CompetencyTag = (typeof COMPETENCY_TAGS)[number];
