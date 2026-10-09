import type { ExerciseDefinition } from '@aperture/shared/flux';

// One-sided stretches (upper trap, levator, scalene) say "then the other side", but flux's targets are
// fixed-sign, so the second side could never register. Side B mirrors the definition: yaw and roll
// negate, pitch (nodding) is symmetric. Labelled A/B, not left/right — the yaw/roll sign convention is
// unverified until the phase-8 dev test (definitions.ts header).
export type Side = 'a' | 'b';

export const hasSide = (def: ExerciseDefinition): boolean =>
  def.kind === 'holdAtTarget' && (def.target.yaw !== undefined || def.target.roll !== undefined);

export function mirrorForSide(def: ExerciseDefinition, side: Side): ExerciseDefinition {
  if (side === 'a' || def.kind !== 'holdAtTarget' || !hasSide(def)) return def;
  const { pitch, yaw, roll } = def.target;
  return {
    ...def,
    target: {
      ...(pitch !== undefined && { pitch }),
      ...(yaw !== undefined && { yaw: -yaw }),
      ...(roll !== undefined && { roll: -roll }),
    },
  };
}
