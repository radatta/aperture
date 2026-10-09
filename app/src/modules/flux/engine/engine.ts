import type { EvalControl, ExerciseEvent, ExerciseId, ExerciseState } from '@aperture/shared/flux';
import { API_MODE } from '../../../shared/env';
import { createFakeEngine } from './fakeEngine';
import type { Delegate, ErrorStage, Sample } from './protocol';
import type { Side } from './side';
import { createWorkerEngine } from './workerEngine';

// The seam between the Flux page and the camera + worker. The page only ever talks to a FluxEngine, so
// jsdom tests (no camera, no Worker, no wasm) and the headless review (`?engine=fake`) drive the real
// UI with a scripted engine, while the app uses the worker one.

export type FluxEngineEvent =
  | { readonly type: 'progress'; readonly loaded: number; readonly total: number }
  // `fallback`: the engine replaced a failing GPU worker with a CPU one on its own.
  | { readonly type: 'ready'; readonly delegate: Delegate; readonly fallback?: boolean }
  | { readonly type: 'sample'; readonly sample: Sample }
  | { readonly type: 'calibrated'; readonly ok: boolean }
  | { readonly type: 'exerciseState'; readonly state: ExerciseState }
  | { readonly type: 'exerciseEvent'; readonly event: ExerciseEvent }
  // The camera stopped under us (tab hidden, track ended). Neutral and the worker are kept.
  | { readonly type: 'paused' }
  | { readonly type: 'error'; readonly stage: ErrorStage; readonly message: string };

// Numbers for the Details readout; polled, never pushed.
export interface EngineDebug {
  readonly delegate: Delegate | null;
  readonly droppedFrames: number;
  readonly fallbacks: number; // GPU → CPU worker replacements this start
  readonly trackSize: string | null;
}

export interface StageElements {
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
}

export interface FluxEngine {
  // Camera + model. Resolves once start-up is underway; progress/ready/error arrive as events.
  start(els: StageElements): Promise<void>;
  // Releases the camera and the worker. Neutral is lost (flux parity).
  stop(): void;
  // Re-acquires the camera after a pause, keeping the worker and neutral.
  resume(): Promise<void>;
  calibrate(): void;
  // Remembered across start/stop, so the selection survives a restart.
  selectExercise(id: ExerciseId | null, side: Side): void;
  control(control: EvalControl): void;
  // The GPU/CPU glyph: persist the choice and restart inference on that delegate.
  setForcedCpu(on: boolean): void;
  subscribe(listener: (e: FluxEngineEvent) => void): () => void;
  debug(): EngineDebug;
}

let override: (() => FluxEngine) | null = null;

// Test seam: jsdom tests install a fake; setup.ts resets it between tests.
export function setFluxEngineFactory(factory: (() => FluxEngine) | null): void {
  override = factory;
}
export const resetFluxEngineFactory = () => setFluxEngineFactory(null);

export function createFluxEngine(): FluxEngine {
  if (override) return override();
  // Stub-only: the headless review drives the real page on a synthetic head (no camera in Chromium).
  if (API_MODE === 'stub' && new URLSearchParams(window.location.search).get('engine') === 'fake')
    return createFakeEngine({ auto: true }).engine;
  return createWorkerEngine();
}
