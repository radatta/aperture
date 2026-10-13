// Typed message protocol across the hot-loop worker boundary. Only small, structured-clone-safe
// payloads cross here: per-frame samples + decimated overlay points one way, control messages the
// other. The pure evaluator's state/events are plain data, so they serialize as-is. Video never leaves
// the device; nothing here is ever sent to the API (docs/areas/flux).

import type {
  Euler,
  EvalControl,
  ExerciseEvent,
  ExerciseId,
  ExerciseState,
} from '@aperture/shared/flux';
import type { Side } from './side';

export type Delegate = 'GPU' | 'CPU';

// Where a failure happened — each maps to its own copy and retry on the stage.
export type ErrorStage = 'assets' | 'init' | 'detect' | 'camera';

export interface Sample {
  readonly rel: Euler; // angle relative to calibrated neutral
  readonly rom: Euler; // range of motion (max-min) per axis since calibration / exercise change
  readonly raw: Euler; // pre-neutral angle, for the Details readout
  readonly faceVisible: boolean;
  readonly fps: number;
  readonly tSec: number;
}

// main → worker
export type ToWorker =
  // One init per worker. A CPU fallback is a fresh worker, not a second init: MediaPipe's module glue
  // hands its factory over once per realm, so re-creating the landmarker in the same worker fails.
  // The neutral and selection ride along so a fallback mid-session doesn't lose calibration.
  | {
      readonly type: 'init';
      readonly delegate: Delegate;
      readonly neutral: Euler | null;
      readonly select: { readonly id: ExerciseId | null; readonly side: Side } | null;
    }
  | { readonly type: 'frame'; readonly bitmap: ImageBitmap; readonly tMs: number }
  | { readonly type: 'calibrate' }
  | { readonly type: 'selectExercise'; readonly id: ExerciseId | null; readonly side: Side }
  | { readonly type: 'control'; readonly control: EvalControl }
  | { readonly type: 'stop' };

// worker → main
export type FromWorker =
  | { readonly type: 'progress'; readonly loaded: number; readonly total: number }
  // Assets are in; the landmarker is being created on this delegate (the GPU crash-mark window opens).
  | { readonly type: 'initStarted'; readonly delegate: Delegate }
  | { readonly type: 'ready'; readonly delegate: Delegate }
  | {
      readonly type: 'sample';
      readonly sample: Sample;
      readonly landmarks: Float32Array; // decimated [x,y,…] normalized, for overlay
    }
  // Every frame message is acked, dropped or not — the main thread sends the next only after it.
  | { readonly type: 'frameDone' }
  // `neutral` is kept by the main thread so a replacement worker can start calibrated. `auto`: the core
  // set it from 2 s of stillness (D40), not a Calibrate tap.
  | {
      readonly type: 'calibrated';
      readonly ok: boolean;
      readonly neutral: Euler | null;
      readonly auto?: true;
    }
  | { readonly type: 'exerciseState'; readonly state: ExerciseState }
  | { readonly type: 'exerciseEvent'; readonly event: ExerciseEvent }
  | { readonly type: 'error'; readonly stage: ErrorStage; readonly message: string };
