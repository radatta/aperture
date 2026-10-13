import type { ExerciseDefinition, ExerciseState, RepositionState } from '@aperture/shared/flux';
import { magnitude } from './engine/headPose';

// The live numbers a set shows — rep count and the hold/countdown ring — derived once from definition
// + evaluator state, so the panel and the overlay on the video (StageReadout) show the same numbers.
// The prompts stay per surface: the panel has room for sentences, the overlay gets short forms.

export type RingTone = 'teal' | 'gold' | 'warn';

export interface Readout {
  readonly count: { readonly n: number; readonly of?: number; readonly unit: string } | null;
  readonly ring: {
    readonly progress: number;
    readonly label: string;
    readonly sublabel?: string;
    readonly tone: RingTone;
  } | null;
  readonly note: string | null; // reposition's short sub-phase prompt
  readonly done: boolean;
}

const secs = (n: number) => `${Math.max(0, Math.ceil(n))}`;

// Out in a ROM excursion but short of the hold zone, the hold not yet done — the voice says "Further"
// (D37), so the ring says it too. A dip below the zone keeps the ring's progress.
export function romShort(def: ExerciseDefinition, state: ExerciseState): boolean {
  if (def.kind !== 'romReps' || state.kind !== 'romReps' || !def.holdSec) return false;
  return state.zone !== 'neutral' && !state.inHoldZone && state.holdAccumSec < def.holdSec;
}

// Joint position's step to show: the evaluator briefly reads "settling" at the far-end turnaround, but
// "Hold still" is only right near neutral (D39 — the voice stays quiet there too).
export function repositionStep(
  def: ExerciseDefinition,
  state: RepositionState,
): RepositionState['sub'] {
  if (def.kind !== 'reposition' || state.sub !== 'settling' || !state.lastRel) return state.sub;
  const mag = def.axis === 'any' ? magnitude(state.lastRel) : Math.abs(state.lastRel[def.axis]);
  return mag < def.excursionDeg ? 'settling' : 'returning';
}

// null when there's nothing live yet: no state, a stale state from another kind, or a kind that waits
// on its own Start button.
export function liveReadout(def: ExerciseDefinition, state: ExerciseState | null): Readout | null {
  if (def.kind === 'romReps' && state?.kind === 'romReps') {
    const done = state.phase === 'complete';
    const holdSec = def.holdSec ?? 0;
    const inExcursion = state.zone !== 'neutral';
    // The clock runs only in the hold zone near the target (D36); short of it the ring says go further.
    const short = romShort(def, state);
    return {
      count: {
        n: state.repsPos + state.repsNeg,
        of: def.direction === 'bilateral' ? def.reps * 2 : def.reps,
        unit: 'reps',
      },
      ring:
        holdSec > 0 && !done
          ? {
              progress: inExcursion ? Math.min(1, state.holdAccumSec / holdSec) : 0,
              label: !inExcursion ? 'hold' : short ? 'further' : secs(holdSec - state.holdAccumSec),
              tone: inExcursion && state.holdAccumSec >= holdSec ? 'gold' : 'teal',
            }
          : null,
      note: null,
      done,
    };
  }

  if (def.kind === 'holdAtTarget' && state?.kind === 'holdAtTarget') {
    const done = state.phase === 'complete';
    return {
      count: { n: state.holdsDone, of: def.reps, unit: 'holds' },
      ring: done
        ? null
        : {
            progress: state.inPosition ? state.holdElapsedSec / def.holdSec : 0,
            label: state.inPosition ? secs(def.holdSec - state.holdElapsedSec) : '—',
            tone: state.inPosition ? 'gold' : 'teal',
          },
      note: null,
      done,
    };
  }

  if (def.kind === 'guidedHold' && state?.kind === 'guidedHold') {
    if (state.phase === 'ready') return null;
    if (state.phase === 'complete')
      return {
        count: { n: state.holdsDone, of: def.reps, unit: 'reps' },
        ring: null,
        note: null,
        done: true,
      };
    const isHold = state.segment === 'hold';
    const total = isHold ? def.holdSec : def.restSec;
    return {
      count: {
        n: Math.min(state.holdsDone + (isHold ? 1 : 0), def.reps),
        of: def.reps,
        unit: 'reps',
      },
      ring: {
        progress: total > 0 ? state.segmentElapsedSec / total : 0,
        label: secs(total - state.segmentElapsedSec),
        sublabel: isHold ? 'HOLD' : 'rest',
        tone: state.drifting ? 'warn' : isHold ? 'gold' : 'teal',
      },
      note: null,
      done: false,
    };
  }

  if (def.kind === 'reposition' && state?.kind === 'reposition') {
    if (state.phase === 'ready') return null;
    if (state.phase === 'complete')
      return {
        count: { n: state.trialsDone, of: def.reps, unit: 'trials' },
        ring: null,
        note: null,
        done: true,
      };
    return {
      count: { n: state.trialsDone, of: def.reps, unit: 'trials' },
      ring: null,
      note: { away: 'Turn away', returning: 'Back to neutral', settling: 'Hold still…' }[
        repositionStep(def, state)
      ],
      done: false,
    };
  }

  if (def.kind === 'oscillation' && state?.kind === 'oscillation') {
    if (state.phase === 'ready') return null;
    if (state.phase === 'complete')
      return {
        count: { n: Math.floor(state.cycles), unit: 'cycles' },
        ring: null,
        note: null,
        done: true,
      };
    return {
      count: { n: Math.floor(state.cycles), unit: 'cycles' },
      ring: {
        progress: state.elapsedSec / def.durationSec,
        label: secs(def.durationSec - state.elapsedSec),
        sublabel: 'seconds',
        tone: 'teal',
      },
      note: null,
      done: false,
    };
  }

  return null;
}
