// The one generic exercise engine. A single pure `evaluate` folds per-frame
// samples into exercise state + discrete events, dispatching on the definition's
// `kind`. No DOM, no timers, no Date.now — all time comes from `input.tSec`, so
// it's deterministic and unit-testable, and it runs unchanged inside the worker.

import { magnitude } from './headPose';
import type {
  Axis,
  Euler,
  EvalControl,
  EvalInput,
  EvalResult,
  ExerciseDefinition,
  ExerciseEvent,
  ExerciseKind,
  ExerciseState,
  GuidedHoldState,
  HoldAtTargetState,
  OscillationState,
  Phase,
  RepositionState,
  RomRepsState,
} from '@aperture/shared/flux';

/** Clamp a frame gap so a paused tab resuming can't overshoot a timer. */
const MAX_DT = 0.5;
/** Angular speed (deg/s) below which the head counts as "still". */
const STILL_SPEED = 6;
/** Off-plane head movement (deg) that flags compensation in a single-axis move. */
const OFF_AXIS_DEG = 15;
/** Min seconds between posture warnings. */
const POSTURE_COOLDOWN = 3;
const AXES: readonly Axis[] = ['pitch', 'yaw', 'roll'];

/** The full definition narrowed to one kind (base fields + that kind's spec). */
type DefOf<K extends ExerciseKind> = Extract<ExerciseDefinition, { kind: K }>;

function dt(lastTSec: number | null, tSec: number): number {
  if (lastTSec === null) return 0;
  return Math.min(MAX_DT, Math.max(0, tSec - lastTSec));
}

/** Advance only the timing baseline (used while idle/complete). */
function touch<T extends ExerciseState>(state: T, input: EvalInput): T {
  return { ...state, lastTSec: input.tSec, lastRel: input.rel };
}

function dominantAxis(e: Euler): Axis {
  const ap = Math.abs(e.pitch);
  const ay = Math.abs(e.yaw);
  const ar = Math.abs(e.roll);
  if (ap >= ay && ap >= ar) return 'pitch';
  if (ay >= ar) return 'yaw';
  return 'roll';
}

function speedOf(rel: Euler, lastRel: Euler | null, dtv: number): number {
  if (!lastRel) return 0;
  const delta: Euler = {
    pitch: rel.pitch - lastRel.pitch,
    yaw: rel.yaw - lastRel.yaw,
    roll: rel.roll - lastRel.roll,
  };
  return magnitude(delta) / (dtv || 1);
}

// Per-kind builders are the single source of truth for a fresh state; each
// returns its concrete variant, so `evaluate` narrows cast-free after `switch`.
function commonOf(def: ExerciseDefinition) {
  return { exerciseId: def.id, lastTSec: null, lastRel: null } as const;
}
function buildRom(def: DefOf<'romReps'>): RomRepsState {
  return {
    ...commonOf(def),
    kind: 'romReps',
    phase: 'active',
    zone: 'neutral',
    peakThisRep: 0,
    repsPos: 0,
    repsNeg: 0,
    peakSum: 0,
    peakCount: 0,
    holdAccumSec: 0,
    compensating: false,
    lastPostureWarnAt: Number.NEGATIVE_INFINITY,
  };
}
function buildHold(def: DefOf<'holdAtTarget'>): HoldAtTargetState {
  return {
    ...commonOf(def),
    kind: 'holdAtTarget',
    phase: 'active',
    holdsDone: 0,
    inPosition: false,
    holdElapsedSec: 0,
    awaitingRelease: false,
  };
}
function buildGuided(def: DefOf<'guidedHold'>): GuidedHoldState {
  return {
    ...commonOf(def),
    kind: 'guidedHold',
    phase: 'ready',
    holdsDone: 0,
    segment: 'hold',
    segmentElapsedSec: 0,
    drifting: false,
  };
}
function buildReposition(def: DefOf<'reposition'>): RepositionState {
  return {
    ...commonOf(def),
    kind: 'reposition',
    phase: 'ready',
    trialsDone: 0,
    sub: 'away',
    stillElapsedSec: 0,
    errorSum: 0,
    errorCount: 0,
  };
}
function buildOscillation(def: DefOf<'oscillation'>): OscillationState {
  return {
    ...commonOf(def),
    kind: 'oscillation',
    phase: 'ready',
    elapsedSec: 0,
    cycles: 0,
    lastVelSign: 0,
    runMin: Number.POSITIVE_INFINITY,
    runMax: Number.NEGATIVE_INFINITY,
    amplitudeEwma: 0,
    lastPeakTSec: null,
  };
}

export function initialState(def: ExerciseDefinition): ExerciseState {
  switch (def.kind) {
    case 'romReps':
      return buildRom(def);
    case 'holdAtTarget':
      return buildHold(def);
    case 'guidedHold':
      return buildGuided(def);
    case 'reposition':
      return buildReposition(def);
    case 'oscillation':
      return buildOscillation(def);
  }
}

export function evaluate(
  def: ExerciseDefinition,
  state: ExerciseState,
  input: EvalInput,
  control?: EvalControl,
): EvalResult {
  if (control?.type === 'stop') return { state: initialState(def), events: [] };
  // Aperture: "Again" on a finished set starts from a clean slate for every kind. Flux carried
  // holdsDone / trialsDone / error sums into the next guided and reposition set, and romReps /
  // holdAtTarget had no way back from `complete` at all.
  if (control?.type === 'start' && state.phase === 'complete') state = initialState(def);
  switch (def.kind) {
    case 'romReps':
      return evalRomReps(def, state.kind === 'romReps' ? state : buildRom(def), input);
    case 'holdAtTarget':
      return evalHold(def, state.kind === 'holdAtTarget' ? state : buildHold(def), input);
    case 'guidedHold':
      return evalGuided(
        def,
        state.kind === 'guidedHold' ? state : buildGuided(def),
        input,
        control,
      );
    case 'reposition':
      return evalReposition(
        def,
        state.kind === 'reposition' ? state : buildReposition(def),
        input,
        control,
      );
    case 'oscillation':
      return evalOscillation(
        def,
        state.kind === 'oscillation' ? state : buildOscillation(def),
        input,
        control,
      );
  }
}

// ─── A. ROM reps ────────────────────────────────────────────────────────────

function evalRomReps(def: DefOf<'romReps'>, state: RomRepsState, input: EvalInput): EvalResult {
  const events: ExerciseEvent[] = [];
  if (state.phase === 'complete') return { state: touch(state, input), events };

  const dtv = dt(state.lastTSec, input.tSec);
  const holdSec = def.holdSec ?? 0;
  const v = input.rel[def.axis];
  let { zone, peakThisRep, repsPos, repsNeg, peakSum, peakCount, holdAccumSec } = state;
  const allowPos = def.direction === 'positive' || def.direction === 'bilateral';
  const allowNeg = def.direction === 'negative' || def.direction === 'bilateral';

  if (zone === 'neutral') {
    if (allowPos && v >= def.enterDeg) {
      zone = 'positive';
      peakThisRep = v;
      holdAccumSec = 0;
    } else if (allowNeg && v <= -def.enterDeg) {
      zone = 'negative';
      peakThisRep = v;
      holdAccumSec = 0;
    }
  } else {
    peakThisRep = zone === 'positive' ? Math.max(peakThisRep, v) : Math.min(peakThisRep, v);
    // Accumulate the end-range hold while the position is held past enterDeg.
    if (Math.abs(v) >= def.enterDeg) holdAccumSec += dtv;
    if (Math.abs(v) <= def.exitDeg) {
      const peakDeg = Math.abs(peakThisRep);
      const held = holdSec === 0 || holdAccumSec >= holdSec;
      const reachedTarget = peakDeg >= def.targetDeg && held;
      const side =
        def.direction === 'bilateral' ? (zone === 'positive' ? 'positive' : 'negative') : 'single';
      if (zone === 'positive') repsPos++;
      else repsNeg++;
      peakSum += peakDeg;
      peakCount++;
      events.push({ type: 'repCompleted', side, peakDeg, reachedTarget });
      zone = 'neutral';
      peakThisRep = 0;
      holdAccumSec = 0;
    }
  }

  let phase: Phase = state.phase;
  const done =
    def.direction === 'bilateral'
      ? repsPos >= def.reps && repsNeg >= def.reps
      : repsPos + repsNeg >= def.reps;
  if (done) {
    phase = 'complete';
    events.push({
      type: 'setCompleted',
      summary: {
        count: repsPos + repsNeg,
        avgPeakDeg: peakCount ? peakSum / peakCount : undefined,
      },
    });
  }

  // Cross-axis compensation: a single-plane move should stay on its axis. Flag
  // (once per episode, rate-limited) when the head tilts/nods off-plane. Compare
  // only the two off-axes to each other (not to the main axis).
  const offAxes = AXES.filter((a) => a !== def.axis);
  let worst = offAxes[0] ?? def.axis;
  for (const a of offAxes) {
    if (Math.abs(input.rel[a]) > Math.abs(input.rel[worst])) worst = a;
  }
  const offMax = Math.abs(input.rel[worst]);
  const compensating = offMax > OFF_AXIS_DEG;
  let lastPostureWarnAt = state.lastPostureWarnAt;
  if (compensating && !state.compensating && input.tSec - lastPostureWarnAt > POSTURE_COOLDOWN) {
    events.push({ type: 'postureWarning', axis: worst, deg: offMax });
    lastPostureWarnAt = input.tSec;
  }

  return {
    state: {
      ...state,
      phase,
      zone,
      peakThisRep,
      repsPos,
      repsNeg,
      peakSum,
      peakCount,
      holdAccumSec,
      compensating,
      lastPostureWarnAt,
      lastTSec: input.tSec,
      lastRel: input.rel,
    },
    events,
  };
}

// ─── B. Hold at target ──────────────────────────────────────────────────────

function evalHold(
  def: DefOf<'holdAtTarget'>,
  state: HoldAtTargetState,
  input: EvalInput,
): EvalResult {
  const events: ExerciseEvent[] = [];
  if (state.phase === 'complete') return { state: touch(state, input), events };

  const dtv = dt(state.lastTSec, input.tSec);
  const axes = Object.keys(def.target) as Axis[];
  const rawInPos =
    input.faceVisible &&
    axes.every((a) => Math.abs(input.rel[a] - (def.target[a] ?? 0)) <= def.toleranceDeg);

  let { holdsDone, inPosition, holdElapsedSec, awaitingRelease } = state;

  // Between reps the user must leave the target zone before the next hold counts.
  if (awaitingRelease) {
    if (!rawInPos) awaitingRelease = false;
    return {
      state: {
        ...state,
        inPosition: false,
        holdElapsedSec: 0,
        awaitingRelease,
        lastTSec: input.tSec,
        lastRel: input.rel,
      },
      events,
    };
  }

  if (rawInPos && !inPosition) {
    inPosition = true;
    holdElapsedSec = 0;
    events.push({ type: 'positionReached' });
  } else if (!rawInPos && inPosition) {
    inPosition = false;
    holdElapsedSec = 0;
    events.push({ type: 'positionLost' });
  }

  let phase: Phase = state.phase;
  if (inPosition) {
    holdElapsedSec += dtv;
    if (holdElapsedSec >= def.holdSec) {
      events.push({
        type: 'holdCompleted',
        index: holdsDone,
        durationSec: def.holdSec,
      });
      holdsDone++;
      holdElapsedSec = 0;
      inPosition = false;
      awaitingRelease = true;
      if (holdsDone >= def.reps) {
        phase = 'complete';
        events.push({ type: 'setCompleted', summary: { count: holdsDone } });
      }
    }
  }

  return {
    state: {
      ...state,
      phase,
      holdsDone,
      inPosition,
      holdElapsedSec,
      awaitingRelease,
      lastTSec: input.tSec,
      lastRel: input.rel,
    },
    events,
  };
}

// ─── C. Guided / isometric hold ─────────────────────────────────────────────

function evalGuided(
  def: DefOf<'guidedHold'>,
  state: GuidedHoldState,
  input: EvalInput,
  control?: EvalControl,
): EvalResult {
  const events: ExerciseEvent[] = [];

  if (control?.type === 'start' && state.phase !== 'active') {
    events.push({ type: 'holdStarted', index: 0 });
    return {
      state: {
        ...state,
        phase: 'active',
        segment: 'hold',
        segmentElapsedSec: 0,
        drifting: false,
        lastTSec: input.tSec,
        lastRel: input.rel,
      },
      events,
    };
  }
  if (state.phase !== 'active') return { state: touch(state, input), events };

  const dtv = dt(state.lastTSec, input.tSec);
  let { holdsDone, segment, segmentElapsedSec, drifting } = state;

  if (def.driftToleranceDeg !== null && segment === 'hold') {
    const isDrift = input.faceVisible && magnitude(input.rel) > def.driftToleranceDeg;
    if (isDrift && !drifting) {
      const axis = dominantAxis(input.rel);
      events.push({
        type: 'driftWarning',
        axis,
        deg: Math.abs(input.rel[axis]),
      });
    }
    drifting = isDrift;
  } else {
    drifting = false;
  }

  segmentElapsedSec += dtv;
  let phase: Phase = state.phase;
  if (segment === 'hold' && segmentElapsedSec >= def.holdSec) {
    events.push({
      type: 'holdCompleted',
      index: holdsDone,
      durationSec: def.holdSec,
    });
    holdsDone++;
    if (holdsDone >= def.reps) {
      phase = 'complete';
      events.push({ type: 'setCompleted', summary: { count: holdsDone } });
    } else {
      segment = 'rest';
      segmentElapsedSec = 0;
      drifting = false;
    }
  } else if (segment === 'rest' && segmentElapsedSec >= def.restSec) {
    segment = 'hold';
    segmentElapsedSec = 0;
    events.push({ type: 'holdStarted', index: holdsDone });
  }

  return {
    state: {
      ...state,
      phase,
      holdsDone,
      segment,
      segmentElapsedSec,
      drifting,
      lastTSec: input.tSec,
      lastRel: input.rel,
    },
    events,
  };
}

// ─── D. Joint-position sense (reposition) ───────────────────────────────────

function evalReposition(
  def: DefOf<'reposition'>,
  state: RepositionState,
  input: EvalInput,
  control?: EvalControl,
): EvalResult {
  const events: ExerciseEvent[] = [];

  if (control?.type === 'start' && state.phase !== 'active') {
    return {
      state: {
        ...state,
        phase: 'active',
        sub: 'away',
        stillElapsedSec: 0,
        lastTSec: input.tSec,
        lastRel: input.rel,
      },
      events,
    };
  }
  if (state.phase !== 'active') return { state: touch(state, input), events };

  const dtv = dt(state.lastTSec, input.tSec);
  const mag = def.axis === 'any' ? magnitude(input.rel) : Math.abs(input.rel[def.axis]);
  const speed = speedOf(input.rel, state.lastRel, dtv);

  let { trialsDone, sub, stillElapsedSec, errorSum, errorCount } = state;
  let phase: Phase = state.phase;

  if (sub === 'away') {
    if (mag >= def.excursionDeg) sub = 'returning';
  } else if (sub === 'returning') {
    if (speed < STILL_SPEED) {
      sub = 'settling';
      stillElapsedSec = 0;
    }
  } else {
    if (speed < STILL_SPEED) {
      stillElapsedSec += dtv;
      if (stillElapsedSec >= def.settleSec) {
        const errorDeg = mag;
        events.push({ type: 'trialCompleted', errorDeg });
        errorSum += errorDeg;
        errorCount++;
        trialsDone++;
        if (trialsDone >= def.reps) {
          phase = 'complete';
          events.push({
            type: 'setCompleted',
            summary: {
              count: trialsDone,
              avgErrorDeg: errorCount ? errorSum / errorCount : undefined,
            },
          });
        } else {
          sub = 'away';
          stillElapsedSec = 0;
        }
      }
    } else {
      stillElapsedSec = 0;
      if (mag >= def.excursionDeg) sub = 'returning';
    }
  }

  return {
    state: {
      ...state,
      phase,
      trialsDone,
      sub,
      stillElapsedSec,
      errorSum,
      errorCount,
      lastTSec: input.tSec,
      lastRel: input.rel,
    },
    events,
  };
}

// ─── D. Oscillation (gaze stability) ────────────────────────────────────────

function evalOscillation(
  def: DefOf<'oscillation'>,
  state: OscillationState,
  input: EvalInput,
  control?: EvalControl,
): EvalResult {
  const events: ExerciseEvent[] = [];

  if (control?.type === 'start' && state.phase !== 'active') {
    const v0 = input.rel[def.axis];
    return {
      state: {
        ...state,
        phase: 'active',
        elapsedSec: 0,
        cycles: 0,
        lastVelSign: 0,
        runMin: v0,
        runMax: v0,
        amplitudeEwma: 0,
        lastPeakTSec: input.tSec,
        lastTSec: input.tSec,
        lastRel: input.rel,
      },
      events,
    };
  }
  if (state.phase !== 'active') return { state: touch(state, input), events };

  const dtv = dt(state.lastTSec, input.tSec);
  const v = input.rel[def.axis];
  let { elapsedSec, cycles, lastVelSign, runMin, runMax, amplitudeEwma, lastPeakTSec } = state;

  elapsedSec += dtv;
  runMin = Math.min(runMin, v);
  runMax = Math.max(runMax, v);

  const prevV = state.lastRel ? state.lastRel[def.axis] : v;
  const vel = v - prevV;
  const velSign: -1 | 0 | 1 = vel > 1e-6 ? 1 : vel < -1e-6 ? -1 : 0;

  if (velSign !== 0 && lastVelSign !== 0 && velSign !== lastVelSign) {
    const amplitudeDeg = runMax - runMin;
    const half = lastPeakTSec !== null ? Math.max(1e-3, input.tSec - lastPeakTSec) : null;
    const cadenceHz = half !== null ? 1 / (2 * half) : 0;
    amplitudeEwma = amplitudeEwma === 0 ? amplitudeDeg : 0.4 * amplitudeDeg + 0.6 * amplitudeEwma;
    cycles += 0.5;
    events.push({ type: 'cycleCompleted', amplitudeDeg, cadenceHz });
    runMin = v;
    runMax = v;
    lastPeakTSec = input.tSec;
  }
  if (velSign !== 0) lastVelSign = velSign;

  let phase: Phase = state.phase;
  if (elapsedSec >= def.durationSec) {
    phase = 'complete';
    events.push({
      type: 'setCompleted',
      summary: { count: Math.floor(cycles), avgPeakDeg: amplitudeEwma },
    });
  }

  return {
    state: {
      ...state,
      phase,
      elapsedSec,
      cycles,
      lastVelSign,
      runMin,
      runMax,
      amplitudeEwma,
      lastPeakTSec,
      lastTSec: input.tSec,
      lastRel: input.rel,
    },
    events,
  };
}
