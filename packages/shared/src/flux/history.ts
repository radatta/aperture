// Saved Flux sets (docs/areas/flux, D47–D54): the helpers the History tab, the night line, both ApiClient
// impls and the MCP tools share, so they label, validate and summarise a set the same way.

import { isDayKey } from '../dates';
import { isUlid } from '../ulid';
import type { FluxSet, FluxSide } from '../types';
import type { FluxSetFilter, RecordFluxSetInput } from '../api';
import { CONDITION_LABELS } from './catalog';
import { getExercise, isExerciseId, type ExerciseId } from './definitions';
import type { ExerciseDefinition } from './types';

// The three one-sided stretches. Side B mirrors the definition (yaw and roll negate).
export const hasSide = (def: ExerciseDefinition): boolean =>
  def.kind === 'holdAtTarget' && (def.target.yaw !== undefined || def.target.roll !== undefined);

// Sides are named by where the head mainly goes (D48): the larger of the target's yaw and roll, and
// +yaw / +roll = right (verified on the iPhone, 2026-10-29). Upper trap and levator Side A go right;
// scalene's Side A tilts left (roll −22) while turning a little right, so it's Left.
export function sideLabel(def: ExerciseDefinition, side: FluxSide): 'Right' | 'Left' {
  const { yaw = 0, roll = 0 } = def.kind === 'holdAtTarget' ? def.target : {};
  const aRight = (Math.abs(roll) >= Math.abs(yaw) ? roll : yaw) >= 0;
  return (side === 'a') === aRight ? 'Right' : 'Left';
}

// Bilateral ROM reps count +yaw / +roll (repsPos) as Right, the other way as Left (D48).
export const BILATERAL_LABELS = { positive: 'Right', negative: 'Left' } as const;

// Short names for one-line summaries (the night line, MCP).
export const SHORT_NAMES: Readonly<Record<ExerciseId, string>> = {
  'cervical-rotation': 'rotation',
  'cervical-lateral-flexion': 'side bend',
  'cervical-flexion': 'flexion',
  'cervical-extension': 'extension',
  'chin-tuck': 'chin tuck',
  'retraction-extension': 'retraction',
  'upper-trap-stretch': 'upper trap',
  'levator-scapulae-stretch': 'levator',
  'scalene-stretch': 'scalene',
  'eye-head-coordination': 'eye–head',
  'deep-neck-flexor': 'deep neck flexor',
  'isometric-flexion': 'isometric flexion',
  'isometric-extension': 'isometric extension',
  'isometric-lateral-flexion': 'isometric side bend',
  'isometric-rotation': 'isometric rotation',
  'scapular-retraction': 'scapular retraction',
  'median-nerve-glide': 'nerve glide',
  'joint-position-sense': 'joint position',
  'gaze-stability': 'gaze stability',
};

const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
const optFinite = (n: unknown): boolean => n === undefined || n === null || finite(n);

// The one refusal text for a set the server won't store (stub and Lambda both throw it); null = valid.
export function fluxSetError(input: RecordFluxSetInput): string | null {
  if (typeof input.id !== 'string' || !isUlid(input.id)) return 'A Flux set needs a valid id.';
  if (typeof input.day !== 'string' || !isDayKey(input.day)) return 'A Flux set needs a valid day.';
  if (typeof input.exerciseId !== 'string' || !isExerciseId(input.exerciseId))
    return `Unknown Flux exercise "${String(input.exerciseId)}".`;
  const def = getExercise(input.exerciseId);
  if (input.kind !== def.kind)
    return `${def.name} is a ${def.kind} exercise, not ${String(input.kind)}.`;
  if (hasSide(def) ? input.side !== 'a' && input.side !== 'b' : input.side !== null)
    return hasSide(def) ? `${def.name} needs a side.` : `${def.name} has no side.`;
  if (input.condition !== null && !(input.condition in CONDITION_LABELS))
    return `Unknown condition "${String(input.condition)}".`;
  if (!Number.isInteger(input.count) || input.count < 0)
    return 'A Flux set count must be a whole number.';
  const rom = input.rom as unknown as Record<string, unknown> | null;
  if (
    !optFinite(input.avgPeakDeg) ||
    !optFinite(input.avgErrorDeg) ||
    !rom ||
    !finite(rom.pitch) ||
    !finite(rom.yaw) ||
    !finite(rom.roll) ||
    !finite(input.durationSec) ||
    input.durationSec < 0 ||
    !finite(input.completedAt)
  )
    return 'A Flux set has a measurement that is not a number.';
  if (typeof input.calibrated !== 'boolean')
    return 'A Flux set must say whether it was calibrated.';
  if (input.delegate !== null && input.delegate !== 'GPU' && input.delegate !== 'CPU')
    return `Unknown tracking delegate "${String(input.delegate)}".`;
  if (input.repTaskId !== null && (typeof input.repTaskId !== 'string' || !input.repTaskId))
    return 'A Flux set links to its Roll rep by task id.';
  return null;
}

// from/to both or neither (the LeetCode rule), each a day key.
export function fluxFilterError(filter: FluxSetFilter | undefined): string | null {
  if (!filter) return null;
  const { from, to } = filter;
  if ((from === undefined) !== (to === undefined)) return 'Give both from and to, or neither.';
  if (from !== undefined && (!isDayKey(from) || !isDayKey(to ?? '')))
    return 'from and to are days (YYYY-MM-DD).';
  return null;
}

// Alive sets in the filter, newest first — the one filter both impls apply.
export function inRange(sets: readonly FluxSet[], filter: FluxSetFilter = {}): FluxSet[] {
  const { from, to, exerciseId } = filter;
  return sets
    .filter(
      (s) =>
        s.deletedAt === null &&
        (from === undefined || (s.day >= from && s.day <= (to ?? from))) &&
        (exerciseId === undefined || s.exerciseId === exerciseId),
    )
    .sort((a, b) => b.completedAt - a.completedAt);
}

// The one number a set is judged by, per kind — what History's row and trend show.
export interface SetMetric {
  readonly label: string;
  readonly value: number;
  readonly unit: '°' | 'reps' | 'holds' | 'trials' | 'cycles';
  readonly target?: number;
  readonly betterWhen: 'higher' | 'lower';
}

export function setMetric(
  def: ExerciseDefinition,
  set: Pick<FluxSet, 'count' | 'avgPeakDeg' | 'avgErrorDeg'>,
): SetMetric | null {
  switch (def.kind) {
    case 'romReps':
      return set.avgPeakDeg === null
        ? null
        : {
            label: 'avg peak',
            value: set.avgPeakDeg,
            unit: '°',
            target: def.targetDeg,
            betterWhen: 'higher',
          };
    case 'holdAtTarget':
      return {
        label: 'holds',
        value: set.count,
        unit: 'holds',
        target: def.reps,
        betterWhen: 'higher',
      };
    case 'guidedHold':
      return {
        label: 'reps',
        value: set.count,
        unit: 'reps',
        target: def.reps,
        betterWhen: 'higher',
      };
    case 'reposition':
      return set.avgErrorDeg === null
        ? null
        : { label: 'avg error', value: set.avgErrorDeg, unit: '°', betterWhen: 'lower' };
    case 'oscillation':
      return { label: 'cycles', value: set.count, unit: 'cycles', betterWhen: 'higher' };
  }
}

// Sets grouped by day, newest day first, each day's sets newest first.
export function groupByDay(sets: readonly FluxSet[]): { day: string; sets: FluxSet[] }[] {
  const days = new Map<string, FluxSet[]>();
  for (const s of [...sets].sort((a, b) => b.completedAt - a.completedAt)) {
    const list = days.get(s.day);
    if (list) list.push(s);
    else days.set(s.day, [s]);
  }
  return [...days].map(([day, list]) => ({ day, sets: list }));
}

// "2 sets rotation, 1 upper trap" — per exercise, in the order first done; "" for none.
export function summarizeSets(
  sets: readonly Pick<FluxSet, 'exerciseId' | 'completedAt'>[],
): string {
  const counts = new Map<string, number>();
  for (const s of [...sets].sort((a, b) => a.completedAt - b.completedAt))
    counts.set(s.exerciseId, (counts.get(s.exerciseId) ?? 0) + 1);
  return [...counts]
    .map(([id, n], i) => {
      const name = isExerciseId(id) ? SHORT_NAMES[id] : id;
      return i === 0 ? `${n} ${n === 1 ? 'set' : 'sets'} ${name}` : `${n} ${name}`;
    })
    .join(', ');
}
