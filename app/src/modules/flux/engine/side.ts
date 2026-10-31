import { hasSide, type ExerciseDefinition } from '@aperture/shared/flux';

// One-sided stretches (upper trap, levator, scalene) say "then the other side", but flux's targets are
// fixed-sign, so the second side could never register. Side B mirrors the definition: yaw and roll
// negate, pitch (nodding) is symmetric. Stored as 'a' / 'b'; shown Right / Left by the head's main move
// (sideLabel, D48 — the sign convention was verified on the iPhone, 2026-10-29).
export type Side = 'a' | 'b';

export { hasSide };

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
