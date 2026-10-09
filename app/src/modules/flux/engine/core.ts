// The hot loop's state, without the worker. flux-track kept this as module-level lets inside its worker
// (worker.ts); here it's a plain class over (matrix | null, tMs) so the real worker, the browser fake
// engine and node tests all run the same code. No DOM, no MediaPipe, no timers.

import {
  getExercise,
  type Euler,
  type EvalControl,
  type ExerciseDefinition,
  type ExerciseEvent,
  type ExerciseId,
  type ExerciseState,
} from '@aperture/shared/flux';
import { evaluate, initialState } from './evaluate';
import { matrixToEuler, OneEuroFilter, RomTracker, relativeTo, ZERO } from './headPose';
import type { Sample } from './protocol';
import { mirrorForSide, type Side } from './side';

// Post exercise-state updates at ~15fps (events are never throttled).
const STATE_INTERVAL_SEC = 1 / 15;

export interface FrameResult {
  readonly sample: Sample;
  readonly events: readonly ExerciseEvent[];
  // Present only when the 15 Hz state throttle lets one through.
  readonly state?: ExerciseState;
}

export interface ControlResult {
  readonly state: ExerciseState;
  readonly events: readonly ExerciseEvent[];
}

export class FluxCore {
  private neutral: Euler | null = null;
  private lastSmoothed: Euler = ZERO;
  private lastRaw: Euler = ZERO;
  private lastTs = 0;
  private lastFrameSec = 0;
  private lastStatePostSec = 0;
  private fps = 0;
  private faceVisible = false;
  private def: ExerciseDefinition | null = null;
  private exerciseState: ExerciseState | null = null;
  private readonly filters = {
    pitch: new OneEuroFilter(),
    yaw: new OneEuroFilter(),
    roll: new OneEuroFilter(),
  };
  private readonly rom = { pitch: new RomTracker(), yaw: new RomTracker(), roll: new RomTracker() };

  get calibrated(): boolean {
    return this.neutral !== null;
  }

  get neutralPose(): Euler | null {
    return this.neutral;
  }

  // Carry a neutral over from a previous worker (the CPU fallback).
  restoreNeutral(neutral: Euler | null): void {
    this.neutral = neutral && { ...neutral };
  }

  // One detector result. Returns null for a frame dropped on a non-increasing timestamp.
  frame(matrix: ArrayLike<number> | null, tMs: number): FrameResult | null {
    // detectForVideo needs strictly increasing timestamps; the core enforces the same rule.
    if (tMs <= this.lastTs) return null;
    this.lastTs = tMs;
    const tSec = tMs / 1000;

    this.faceVisible = matrix !== null;
    if (matrix) {
      const raw = matrixToEuler(matrix);
      this.lastRaw = raw;
      this.lastSmoothed = {
        pitch: this.filters.pitch.filter(raw.pitch, tSec),
        yaw: this.filters.yaw.filter(raw.yaw, tSec),
        roll: this.filters.roll.filter(raw.roll, tSec),
      };
      if (this.neutral) {
        const rel = relativeTo(this.lastSmoothed, this.neutral);
        this.rom.pitch.add(rel.pitch);
        this.rom.yaw.add(rel.yaw);
        this.rom.roll.add(rel.roll);
      }
    }

    // No face holds the last pose (flux parity) — only hold/guided kinds check faceVisible.
    const rel = relativeTo(this.lastSmoothed, this.neutral);
    const dt = tSec - (this.lastFrameSec || tSec);
    this.lastFrameSec = tSec;
    // ~1 s EWMA instead of flux's per-frame 1/dt, so the badge doesn't flicker.
    if (dt > 0) this.fps += (1 / dt - this.fps) * Math.min(1, dt);

    const sample: Sample = {
      rel,
      rom: { pitch: this.rom.pitch.range, yaw: this.rom.yaw.range, roll: this.rom.roll.range },
      raw: this.lastRaw,
      faceVisible: this.faceVisible,
      fps: Math.round(this.fps),
      tSec,
    };

    if (!this.def || !this.exerciseState) return { sample, events: [] };
    const r = evaluate(this.def, this.exerciseState, { rel, tSec, faceVisible: this.faceVisible });
    this.exerciseState = r.state;
    if (tSec - this.lastStatePostSec < STATE_INTERVAL_SEC) return { sample, events: r.events };
    this.lastStatePostSec = tSec;
    return { sample, events: r.events, state: r.state };
  }

  // Neutral = the current smoothed pose. Refused without a face, so a stale/zero pose never sticks.
  calibrate(): boolean {
    if (!this.faceVisible) return false;
    this.neutral = { ...this.lastSmoothed };
    this.resetRom();
    if (this.def) this.exerciseState = initialState(this.def);
    return true;
  }

  selectExercise(id: ExerciseId | null, side: Side): ExerciseState | null {
    this.def = id ? mirrorForSide(getExercise(id), side) : null;
    this.exerciseState = this.def ? initialState(this.def) : null;
    this.lastStatePostSec = 0;
    this.resetRom();
    return this.exerciseState;
  }

  // Start/Stop applied immediately (between frames), as flux did.
  control(control: EvalControl): ControlResult | null {
    if (!this.def || !this.exerciseState) return null;
    const input = {
      rel: relativeTo(this.lastSmoothed, this.neutral),
      tSec: this.lastTs / 1000,
      faceVisible: true,
    };
    const r = evaluate(this.def, this.exerciseState, input, control);
    this.exerciseState = r.state;
    return r;
  }

  private resetRom(): void {
    this.rom.pitch.reset();
    this.rom.yaw.reset();
    this.rom.roll.reset();
  }
}
