// Exercises-as-data: the declarative shape that drives the one generic engine.
// Pure types only — no DOM, no MediaPipe, no React. A single evaluator
// (evaluate.ts) interprets these five "kinds", so adding an exercise means
// writing config, not code.
//
// The engine measures head ROTATION only (pitch/yaw/roll relative to a
// calibrated neutral). Most neck-rehab exercises aren't cleanly measurable that
// way, so each definition declares how honestly the engine can grade it via
// `measurement` and picks the `kind` that matches what we can actually observe.

// Head rotation in degrees. Lives here (not app/) so the catalog's types are self-contained.
export interface Euler {
  // rotation about X — nodding (cervical flexion / extension)
  pitch: number;
  // rotation about Y — turning left/right (cervical rotation)
  yaw: number;
  // rotation about Z — ear-to-shoulder (lateral tilt)
  roll: number;
}

export type Axis = 'pitch' | 'yaw' | 'roll';

// Which condition an exercise is commonly prescribed for (for filtering).
export type Condition = 'herniatedDisc' | 'sprainStrain' | 'general';

// Rehab stage the exercise suits (for filtering + contraindication rules).
export type Stage = 'acute' | 'subacute' | 'chronic';

// How honestly the engine can grade this exercise.
export type Measurement =
  | 'measured' // clean single-axis ROM/hold we can quantify
  | 'approximate' // multi-signal or proxy — we track a head position, not the true motion
  | 'guided'; // not angle-measurable — timer + (maybe) drift check only

export interface Contraindication {
  readonly condition: Condition;
  readonly stage: Stage;
  readonly reason: string; // shown in the precaution banner
}

interface ExerciseBase {
  readonly id: string; // stable slug, unique
  readonly name: string;
  readonly tracker: 'face'; // "pose" reserved for shoulder work (not this phase)
  readonly measurement: Measurement;
  readonly instructions: string;
  readonly cues: readonly string[]; // static coaching lines
  readonly precautions?: readonly string[];
  readonly contraindications?: readonly Contraindication[];
  readonly conditions: readonly Condition[];
  readonly stages: readonly Stage[];
  // End-range direction some conditions must avoid (e.g. extension).
  readonly provocative?: boolean;
}

// A. ROM reps — single axis, hysteresis excursion → return, counts reps.
export interface RomRepsSpec {
  readonly kind: 'romReps';
  readonly axis: Axis;
  readonly direction: 'positive' | 'negative' | 'bilateral';
  readonly enterDeg: number; // magnitude to count as "in excursion"
  readonly exitDeg: number; // must return below this (exit < enter → hysteresis)
  readonly targetDeg: number; // goal excursion (drives the ring + reachedTarget)
  readonly reps: number; // per side if bilateral, else total
  readonly holdSec?: number; // end-range hold per rep — a return before it's up doesn't count (D35); 0/undefined = none
}

// B. Hold at a (possibly multi-signal) target head position for holdSec.
export interface HoldAtTargetSpec {
  readonly kind: 'holdAtTarget';
  readonly target: Partial<Record<Axis, number>>; // only the axes that matter
  readonly toleranceDeg: number; // per-axis window
  readonly holdSec: number;
  readonly reps: number;
}

// C. Guided/isometric — timer-driven; engine can only verify "near neutral".
export interface GuidedHoldSpec {
  readonly kind: 'guidedHold';
  readonly holdSec: number;
  readonly reps: number;
  readonly restSec: number;
  readonly driftToleranceDeg: number | null; // null = pure guide, no drift check
}

// D. Joint-position sense — return-to-neutral error after an excursion.
export interface RepositionSpec {
  readonly kind: 'reposition';
  readonly axis: Axis | 'any'; // "any" → 3D error magnitude
  readonly excursionDeg: number; // move out at least this far first
  readonly settleSec: number; // must be still this long to register a return
  readonly reps: number; // trials
}

// D. Oscillation — gaze-stability head oscillation amplitude + cadence.
export interface OscillationSpec {
  readonly kind: 'oscillation';
  readonly axis: Axis;
  readonly targetAmplitudeDeg: number;
  readonly targetCadenceHz: number;
  readonly durationSec: number;
}

export type ExerciseSpec =
  RomRepsSpec | HoldAtTargetSpec | GuidedHoldSpec | RepositionSpec | OscillationSpec;

export type ExerciseKind = ExerciseSpec['kind'];

export type ExerciseDefinition = ExerciseBase & ExerciseSpec;

// ─── Per-frame evaluator I/O ────────────────────────────────────────────────

export interface EvalInput {
  readonly rel: Euler; // angle relative to calibrated neutral
  readonly tSec: number; // monotonic timestamp, seconds
  readonly faceVisible: boolean;
}

// Lifecycle control from the UI (Start/Stop for timed kinds).
export type EvalControl = { readonly type: 'start' } | { readonly type: 'stop' };

export type Phase = 'ready' | 'active' | 'complete';

interface StateCommon {
  readonly exerciseId: string;
  readonly phase: Phase;
  readonly lastTSec: number | null;
  readonly lastRel: Euler | null;
}

export interface RomRepsState extends StateCommon {
  readonly kind: 'romReps';
  readonly zone: 'neutral' | 'positive' | 'negative';
  readonly peakThisRep: number;
  readonly repsPos: number;
  readonly repsNeg: number;
  readonly peakSum: number;
  readonly peakCount: number;
  // Seconds held in the excursion this rep (for the end-range hold timer).
  readonly holdAccumSec: number;
  // True while the head is tilting/nodding off the exercise's plane.
  readonly compensating: boolean;
  readonly lastPostureWarnAt: number;
}

export interface HoldAtTargetState extends StateCommon {
  readonly kind: 'holdAtTarget';
  readonly holdsDone: number;
  readonly inPosition: boolean;
  readonly holdElapsedSec: number;
  readonly awaitingRelease: boolean;
  // A hold of this many seconds was just lost (0 = none pending); it's said out loud only once the head
  // has stayed out for a beat (`outSec`), so a one-frame edge flicker never says "Back into position".
  readonly brokenHeldSec: number;
  readonly outSec: number;
}

export interface GuidedHoldState extends StateCommon {
  readonly kind: 'guidedHold';
  readonly holdsDone: number;
  readonly segment: 'hold' | 'rest';
  readonly segmentElapsedSec: number;
  readonly drifting: boolean;
}

export interface RepositionState extends StateCommon {
  readonly kind: 'reposition';
  readonly trialsDone: number;
  readonly sub: 'away' | 'returning' | 'settling';
  readonly stillElapsedSec: number;
  readonly errorSum: number;
  readonly errorCount: number;
}

export interface OscillationState extends StateCommon {
  readonly kind: 'oscillation';
  readonly elapsedSec: number;
  readonly cycles: number;
  readonly lastVelSign: -1 | 0 | 1;
  readonly runMin: number;
  readonly runMax: number;
  readonly amplitudeEwma: number;
  readonly lastPeakTSec: number | null;
}

export type ExerciseState =
  RomRepsState | HoldAtTargetState | GuidedHoldState | RepositionState | OscillationState;

// ─── Discrete events (these cross into the cold app / get persisted later) ───

export interface SetSummary {
  readonly count: number;
  readonly avgPeakDeg?: number;
  readonly avgErrorDeg?: number;
}

export type ExerciseEvent =
  | {
      readonly type: 'repCompleted';
      readonly side: 'positive' | 'negative' | 'single';
      readonly peakDeg: number;
      readonly reachedTarget: boolean;
      readonly count: number; // reps done this set, this one included — what the voice counts
      // True for every counted rep of a hold exercise (a short hold isn't a rep, D35), whose count was
      // spoken at holdReached — the voice stays quiet; false with no hold, so it counts on return.
      readonly holdReached: boolean;
    }
  // romReps with holdSec: the end-range hold time is up — the voice counts now; the rep counts on return.
  | { readonly type: 'holdReached'; readonly count: number } // repsPos + repsNeg + 1, the pending count
  | { readonly type: 'holdStarted'; readonly index: number }
  | {
      readonly type: 'holdCompleted';
      readonly index: number;
      readonly durationSec: number;
    }
  | { readonly type: 'positionReached' }
  | { readonly type: 'positionLost' }
  // holdAtTarget: left the target after a meaningful hold; positionLost stays silent for flicker.
  | { readonly type: 'holdBroken'; readonly heldSec: number }
  // romReps with holdSec: back below exitDeg before the hold was up — no rep (D35); said past 1 s held.
  | { readonly type: 'holdShort'; readonly heldSec: number }
  | { readonly type: 'driftWarning'; readonly axis: Axis; readonly deg: number }
  | {
      readonly type: 'postureWarning'; // moving off-plane during a single-axis move
      readonly axis: Axis;
      readonly deg: number;
    }
  | { readonly type: 'trialCompleted'; readonly errorDeg: number }
  | {
      readonly type: 'cycleCompleted';
      readonly amplitudeDeg: number;
      readonly cadenceHz: number;
    }
  | { readonly type: 'setCompleted'; readonly summary: SetSummary };

export interface EvalResult {
  readonly state: ExerciseState;
  readonly events: readonly ExerciseEvent[];
}
