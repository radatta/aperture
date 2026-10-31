// The one generic exercise engine. A single pure `evaluate` folds per-frame
// samples into exercise state + discrete events, dispatching on the definition's
// `kind`. No DOM, no timers, no Date.now — all time comes from `input.tSec`, so
// it's deterministic and unit-testable, and it runs unchanged inside the worker.

import { magnitude, speedOf, STILL_SPEED } from './headPose';
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
  SetSummary,
  RepositionState,
  RomRepsState,
} from '@aperture/shared/flux';

// Clamp a frame gap so a paused tab resuming can't overshoot a timer.
const MAX_DT = 0.5;
// Off-plane head movement (deg) that flags compensation in a single-axis move.
const OFF_AXIS_DEG = 20; // flux's 15 fired constantly in the dev test (D28)
// Min seconds between posture warnings.
const POSTURE_COOLDOWN = 3;
// A broken hold is only said out loud past this (shorter is boundary flicker — the visual shows it)…
const HOLD_BROKEN_MIN_SEC = 1;
// …and only once the head has stayed out this long (edge jitter or a dropped face frame late in a
// long hold comes straight back; saying it then would be wrong with your eyes closed).
const HOLD_BROKEN_OUT_SEC = 0.3;
// A ROM hold is timed only this close to the target (D36): 75 % — rotation 37.5° of 50°.
const HOLD_ZONE_FRACTION = 0.75;
// The face lost this long, in all, at the far end of an excursion is the end of the turn (D57) — a dropped
// frame (motion blur, a hand) on the way out or back isn't, and says nothing.
const BLIND_END_SEC = 0.3;
// "Further" (D37): still this long short of the zone — once per excursion, literally: a dip below the zone
// after "Hold" doesn't say it again (the paused clock is the cost; a return says "Hold longer").
const FURTHER_STILL_SEC = 0.6;
// …or a swing back that never reached the zone and lasted this long.
const FURTHER_SWING_SEC = 1;
// A pause counts as stopping short only this close to the excursion's peak, past enterDeg — not a
// pause on the way back, nor a resting head drifted just past exitDeg.
const FURTHER_PEAK_DEG = 3;
// Stretch direction nudges (D38): still this long out of position, once per pause, and no sooner than
// this after the last nudge, release or broken hold (a pause that starts inside it still gets one).
const NUDGE_STILL_SEC = 0.8;
const NUDGE_COOLDOWN_SEC = 4;
const AXES: readonly Axis[] = ['pitch', 'yaw', 'roll'];

// The full definition narrowed to one kind (base fields + that kind's spec).
type DefOf<K extends ExerciseKind> = Extract<ExerciseDefinition, { kind: K }>;

function dt(lastTSec: number | null, tSec: number): number {
  if (lastTSec === null) return 0;
  return Math.min(MAX_DT, Math.max(0, tSec - lastTSec));
}

// Advance only the timing baseline (used while idle/complete).
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

// Where a ROM rep's end-range hold starts timing (D36). Derived, not a definition field.
export const romHoldDeg = (def: { readonly targetDeg: number }): number =>
  def.targetDeg * HOLD_ZONE_FRACTION;

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
    inHoldZone: false,
    stillShortSec: 0,
    furtherSaid: false,
    excursionSec: 0,
    blindSec: 0,
    wentBlind: false,
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
    brokenHeldSec: 0,
    outSec: 0,
    stillOutSec: 0,
    lastNudgeAt: Number.NEGATIVE_INFINITY,
    nudgeSaid: false,
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

// Out in a ROM excursion, mid-set: where a lost face is the end of the turn, not the user gone (D57).
export const inRomExcursion = (s: ExerciseState | null | undefined): boolean =>
  s?.kind === 'romReps' && s.phase === 'active' && s.zone !== 'neutral';

// What a set amounts to, from its state: the count and its one measurement. A finished set's
// `setCompleted` summary is exactly this of its final state (evaluate.test pins it per kind), and a set
// ended early is saved from this of its last state (D55) — one reading, so the two can't drift.
export function summaryOf(state: ExerciseState): SetSummary {
  switch (state.kind) {
    case 'romReps':
      return {
        count: state.repsPos + state.repsNeg,
        avgPeakDeg: state.peakCount ? state.peakSum / state.peakCount : undefined,
      };
    case 'holdAtTarget':
    case 'guidedHold':
      return { count: state.holdsDone };
    case 'reposition':
      return {
        count: state.trialsDone,
        avgErrorDeg: state.errorCount ? state.errorSum / state.errorCount : undefined,
      };
    case 'oscillation':
      return { count: Math.floor(state.cycles), avgPeakDeg: state.amplitudeEwma };
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
  // A dropout outside an excursion freezes the rep: the core holds the last pose, and a face lost near
  // neutral is really gone. Mid-excursion it's the far end of the turn (D57), handled below.
  if (!input.faceVisible && state.zone === 'neutral') return { state: touch(state, input), events };

  const dtv = dt(state.lastTSec, input.tSec);
  const holdSec = def.holdSec ?? 0;
  const holdDeg = romHoldDeg(def);
  const v = input.rel[def.axis];
  const speed = speedOf(input.rel, state.lastRel, dtv);
  let { zone, peakThisRep, repsPos, repsNeg, peakSum, peakCount, holdAccumSec } = state;
  let { stillShortSec, furtherSaid, excursionSec, blindSec, wentBlind } = state;
  let inHoldZone = false;
  const allowPos = def.direction === 'positive' || def.direction === 'bilateral';
  const allowNeg = def.direction === 'negative' || def.direction === 'bilateral';

  if (zone === 'neutral') {
    if ((allowPos && v >= def.enterDeg) || (allowNeg && v <= -def.enterDeg)) {
      zone = v > 0 ? 'positive' : 'negative';
      peakThisRep = v;
      holdAccumSec = 0;
      stillShortSec = 0;
      furtherSaid = false;
      excursionSec = 0;
    }
  } else {
    peakThisRep = zone === 'positive' ? Math.max(peakThisRep, v) : Math.min(peakThisRep, v);
    // The excursion measured on its own side: a jump straight to the other side (a face dropout
    // mid-swing) is a return, never hold time on the wrong side.
    const out = zone === 'positive' ? v : -v;
    const atFarEnd = out >= def.enterDeg && out >= Math.abs(peakThisRep) - FURTHER_PEAK_DEG;
    const still = speed < STILL_SPEED;
    // The blind time up to the latch is credited back, so the hold runs from when the face went.
    let credit = 0;
    if (!input.faceVisible && atFarEnd) blindSec += dtv;
    if (!wentBlind && blindSec >= BLIND_END_SEC) {
      wentBlind = true;
      if (out < holdDeg) credit = blindSec - dtv;
    }
    // Once the face has dropped this excursion, the user is at the end of the turn the camera can't
    // follow (D57): a blind frame (the pose frozen at the last one seen) and a still pause at the peak —
    // a face flickering back in at the limit — are hold time, wherever the angle read. That also keeps
    // "Further" out of it: the pause is hold time, and the swing trigger needs a rep with none.
    const asHeld = wentBlind && (!input.faceVisible || (atFarEnd && still));
    // The end-range hold is timed only in the hold zone near the target (D36): "Hold" on the first frame
    // in it, the count the moment the time is up (eyes closed, D32) — once per excursion; the rep counts
    // on return only if the hold reached holdSec (D35). A dip below the zone pauses the clock.
    inHoldZone = holdSec > 0 && (out >= holdDeg || asHeld);
    if (inHoldZone) {
      const prev = holdAccumSec;
      if (prev === 0 && !state.inHoldZone)
        events.push({ type: 'holdEntered', count: repsPos + repsNeg + 1 });
      holdAccumSec += dtv + credit;
      if (prev < holdSec && holdAccumSec >= holdSec)
        events.push({ type: 'holdReached', count: repsPos + repsNeg + 1 });
      stillShortSec = 0;
      excursionSec = 0;
    } else if (holdSec > 0 && out > def.exitDeg && holdAccumSec < holdSec) {
      // Short of the zone: a pause at the far end says "Further" (D37) — once per excursion, so a user
      // straining at their real limit isn't told again and again.
      excursionSec += dtv;
      // A frozen pose isn't a pause: only a seen one counts toward "Further".
      stillShortSec = atFarEnd && still && input.faceVisible ? stillShortSec + dtv : 0;
      if (!furtherSaid && stillShortSec >= FURTHER_STILL_SEC) {
        events.push({ type: 'stoppedShort', shortDeg: holdDeg - out });
        furtherSaid = true;
      }
    }
    if (out <= def.exitDeg) {
      const peakDeg = Math.abs(peakThisRep);
      const holdReached = holdSec > 0 && holdAccumSec >= holdSec;
      const short = holdSec > 0 && !holdReached;
      // Back before the hold was up: not a rep (D35). Said whenever "Hold" was — a zone entry is a real
      // attempt; before it the swing trigger below has the floor.
      if (short && holdAccumSec > 0) events.push({ type: 'holdShort', heldSec: holdAccumSec });
      // A swing out and back that never reached the zone, with no pause to say it at (D37).
      if (short && holdAccumSec === 0 && !furtherSaid && excursionSec >= FURTHER_SWING_SEC)
        events.push({ type: 'stoppedShort', shortDeg: holdDeg - Math.abs(peakThisRep) });
      if (!short) {
        const side =
          def.direction === 'bilateral'
            ? zone === 'positive'
              ? 'positive'
              : 'negative'
            : 'single';
        if (zone === 'positive') repsPos++;
        else repsNeg++;
        peakSum += peakDeg;
        peakCount++;
        events.push({
          type: 'repCompleted',
          side,
          peakDeg,
          reachedTarget: peakDeg >= def.targetDeg, // held is guaranteed here
          holdReached,
          count: repsPos + repsNeg,
        });
      }
      zone = 'neutral';
      peakThisRep = 0;
      holdAccumSec = 0;
      inHoldZone = false;
      stillShortSec = 0;
      furtherSaid = false;
      excursionSec = 0;
      blindSec = 0;
      wentBlind = false;
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
      inHoldZone,
      stillShortSec,
      furtherSaid,
      excursionSec,
      blindSec,
      wentBlind,
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

  let { holdsDone, inPosition, holdElapsedSec, awaitingRelease, brokenHeldSec, outSec } = state;
  let { stillOutSec, lastNudgeAt, nudgeSaid } = state;

  // Between reps the user must leave the target zone before the next hold counts — a dropout isn't
  // leaving (the head is most likely still there, D44).
  if (awaitingRelease) {
    if (!rawInPos && input.faceVisible) awaitingRelease = false;
    return {
      state: {
        ...state,
        inPosition: false,
        holdElapsedSec: 0,
        awaitingRelease,
        stillOutSec: 0,
        nudgeSaid: false,
        lastTSec: input.tSec,
        lastRel: input.rel,
      },
      events,
    };
  }

  // A dropout mid-hold pauses the clock (D44): the core keeps the last pose, so the head is most likely
  // still there, and the session already says "Can't see you" (D43). Nothing moves until the face is back.
  if (!input.faceVisible && inPosition)
    return { state: { ...touch(state, input), stillOutSec: 0, nudgeSaid: false }, events };

  if (rawInPos && !inPosition) {
    inPosition = true;
    holdElapsedSec = 0;
    brokenHeldSec = 0; // back before the beat was up — nothing to say
    outSec = 0;
    events.push({ type: 'positionReached' });
  } else if (!rawInPos && inPosition) {
    // Left with the face in view (a dropout pauses above, D44).
    if (holdElapsedSec >= HOLD_BROKEN_MIN_SEC) brokenHeldSec = holdElapsedSec;
    outSec = 0;
    inPosition = false;
    holdElapsedSec = 0;
    events.push({ type: 'positionLost' });
  } else if (!rawInPos && brokenHeldSec > 0) {
    if (input.faceVisible) outSec += dtv;
    if (outSec >= HOLD_BROKEN_OUT_SEC) {
      events.push({ type: 'holdBroken', heldSec: brokenHeldSec });
      brokenHeldSec = 0;
      lastNudgeAt = input.tSec;
    }
  }

  // Still and out of position: say which way to go on the worst axis (D38), once per pause.
  if (!rawInPos && input.faceVisible) {
    const still = speedOf(input.rel, state.lastRel, dtv) < STILL_SPEED;
    stillOutSec = still ? stillOutSec + dtv : 0;
    if (!still) nudgeSaid = false;
    if (
      !nudgeSaid &&
      stillOutSec >= NUDGE_STILL_SEC &&
      input.tSec - lastNudgeAt >= NUDGE_COOLDOWN_SEC
    ) {
      let worst: Axis | null = null;
      let worstOff = 0;
      for (const a of axes) {
        const off = Math.abs(input.rel[a] - (def.target[a] ?? 0)) - def.toleranceDeg;
        if (off > worstOff) [worst, worstOff] = [a, off];
      }
      if (worst) {
        const target = def.target[worst] ?? 0;
        const deg = target - input.rel[worst];
        events.push({
          type: 'nudge',
          axis: worst,
          toward: Math.sign(deg) === Math.sign(target) ? 'more' : 'less',
          deg,
        });
        lastNudgeAt = input.tSec;
        nudgeSaid = true;
      }
    }
  } else {
    stillOutSec = 0;
    nudgeSaid = false;
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
      lastNudgeAt = input.tSec;
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
      brokenHeldSec,
      outSec,
      stillOutSec,
      lastNudgeAt,
      nudgeSaid,
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
    events.push({ type: 'repositionPrompt', sub: 'away' });
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

  // The sub-phase is spoken so the drill runs eyes closed (D39), after any trial result. Not every
  // change: the turnaround at the far end slows below STILL_SPEED and flips returning ⇄ settling, so
  // "Hold still" is said only near neutral and a move back out stays silent.
  const prompt =
    sub === 'away'
      ? state.sub !== 'away'
      : sub === 'returning'
        ? state.sub === 'away'
        : state.sub !== 'settling' && mag < def.excursionDeg;
  if (prompt) events.push({ type: 'repositionPrompt', sub });

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
    events.push({ type: 'setStarted' });
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
