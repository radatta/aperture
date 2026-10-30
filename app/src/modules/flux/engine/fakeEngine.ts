import {
  getExercise,
  type Euler,
  type EvalControl,
  type ExerciseDefinition,
  type ExerciseEvent,
  type ExerciseId,
  type ExerciseState,
} from '@aperture/shared/flux';
import { FluxCore } from './core';
import type { EngineDebug, FluxEngine, FluxEngineEvent } from './engine';
import type { Delegate, ErrorStage, Sample } from './protocol';
import { mirrorForSide, type Side } from './side';

// A FluxEngine with no camera and no worker.
// - manual (jsdom tests): nothing happens on its own; the test scripts every event through `fake`.
// - auto (`?engine=fake`, stub mode only): "boots" after 300 ms on CPU, then runs the real FluxCore at
//   30 Hz on a synthetic head that performs whichever exercise is selected — so the headless review
//   reaches every panel state and finishes real sets.

export interface FakeControls {
  progress(loaded: number, total: number): void;
  ready(delegate?: Delegate, fallback?: boolean): void;
  fail(stage: ErrorStage, message: string): void;
  sample(partial?: Partial<Sample>): void;
  calibrated(ok: boolean, auto?: boolean): void;
  state(state: ExerciseState): void;
  event(event: ExerciseEvent): void;
  pause(): void;
  // Every engine method call, in order: 'start', 'stop', 'select:<id|null>:<side>', 'control:start', …
  readonly calls: readonly string[];
  readonly lastSelect: { id: ExerciseId | null; side: Side } | undefined;
}

const AUTO_BOOT_MS = 300;
const FRAME_MS = 1000 / 30;
const ZERO_SAMPLE: Sample = {
  rel: { pitch: 0, yaw: 0, roll: 0 },
  rom: { pitch: 0, yaw: 0, roll: 0 },
  raw: { pitch: 0, yaw: 0, roll: 0 },
  faceVisible: true,
  fps: 30,
  tSec: 0,
};

export function createFakeEngine(opts: { auto?: boolean } = {}): {
  engine: FluxEngine;
  fake: FakeControls;
} {
  const listeners = new Set<(e: FluxEngineEvent) => void>();
  const calls: string[] = [];
  let lastSelect: { id: ExerciseId | null; side: Side } | undefined;
  let delegate: Delegate | null = null;
  const emit = (e: FluxEngineEvent) => listeners.forEach((l) => l(e));

  // auto mode
  let core = new FluxCore();
  let def: ExerciseDefinition | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let boot: ReturnType<typeof setTimeout> | null = null;
  let t0 = 0;
  let canvas: HTMLCanvasElement | null = null;

  const tick = () => {
    const tMs = performance.now() - t0;
    const pose = syntheticPose(def, tMs / 1000);
    const r = core.frame(eulerToMatrix(pose), tMs);
    if (!r) return;
    emit({ type: 'sample', sample: r.sample });
    if (r.autoCalibrated) emit({ type: 'calibrated', ok: true, auto: true });
    for (const event of r.events) emit({ type: 'exerciseEvent', event });
    if (r.state) emit({ type: 'exerciseState', state: r.state });
    drawDot(canvas, pose);
  };
  const halt = () => {
    if (timer) clearInterval(timer);
    if (boot) clearTimeout(boot);
    timer = boot = null;
  };
  const run = () => {
    halt();
    boot = setTimeout(() => {
      delegate = 'CPU';
      emit({ type: 'progress', loaded: 1, total: 1 });
      emit({ type: 'ready', delegate });
      if (lastSelect) {
        const state = core.selectExercise(lastSelect.id, lastSelect.side);
        if (state) emit({ type: 'exerciseState', state });
      }
      t0 = performance.now();
      timer = setInterval(tick, FRAME_MS);
    }, AUTO_BOOT_MS);
  };

  const engine: FluxEngine = {
    start: async (els) => {
      calls.push('start');
      canvas = els.canvas;
      if (!opts.auto) return;
      core = new FluxCore();
      run();
    },
    stop: () => {
      calls.push('stop');
      halt();
      delegate = null;
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    },
    resume: async () => {
      calls.push('resume');
      if (opts.auto) run();
    },
    calibrate: () => {
      calls.push('calibrate');
      if (opts.auto) emit({ type: 'calibrated', ok: core.calibrate() });
    },
    selectExercise: (id, side) => {
      calls.push(`select:${id}:${side}`);
      lastSelect = { id, side };
      def = id ? mirrorForSide(getExercise(id), side) : null;
      if (!opts.auto || !timer) return;
      const state = core.selectExercise(id, side);
      if (state) emit({ type: 'exerciseState', state });
    },
    control: (control: EvalControl) => {
      calls.push(`control:${control.type}`);
      if (!opts.auto) return;
      const r = core.control(control);
      if (!r) return;
      for (const event of r.events) emit({ type: 'exerciseEvent', event });
      emit({ type: 'exerciseState', state: r.state });
    },
    setForcedCpu: (on) => {
      calls.push(`forcedCpu:${on}`);
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    debug: (): EngineDebug => ({
      delegate,
      droppedFrames: 0,
      fallbacks: 0,
      trackSize: delegate ? '640×480' : null,
    }),
  };

  const fake: FakeControls = {
    progress: (loaded, total) => emit({ type: 'progress', loaded, total }),
    ready: (d = 'CPU', fallback) => {
      delegate = d;
      emit({ type: 'ready', delegate: d, ...(fallback && { fallback }) });
    },
    fail: (stage, message) => emit({ type: 'error', stage, message }),
    sample: (partial) => emit({ type: 'sample', sample: { ...ZERO_SAMPLE, ...partial } }),
    calibrated: (ok, auto) => emit({ type: 'calibrated', ok, ...(auto && { auto: true }) }),
    state: (state) => emit({ type: 'exerciseState', state }),
    event: (event) => emit({ type: 'exerciseEvent', event }),
    pause: () => emit({ type: 'paused' }),
    get calls() {
      return calls;
    },
    get lastSelect() {
      return lastSelect;
    },
  };

  return { engine, fake };
}

// ─── the synthetic head ──────────────────────────────────────────────────────

const ZERO: Euler = { pitch: 0, yaw: 0, roll: 0 };

// 0 → 1 → hold → 0 → rest, one excursion per cycle. Returns the excursion fraction and cycle index.
function excursion(t: number, holdSec: number, rest = 0.75): { f: number; cycle: number } {
  const ramp = 1;
  const period = ramp + holdSec + ramp + rest;
  const cycle = Math.floor(t / period);
  const p = t - cycle * period;
  if (p < ramp) return { f: p / ramp, cycle };
  if (p < ramp + holdSec) return { f: 1, cycle };
  if (p < 2 * ramp + holdSec) return { f: 1 - (p - ramp - holdSec) / ramp, cycle };
  return { f: 0, cycle };
}

const jitter = (t: number): number => 0.4 * Math.sin(7.3 * t);

// The head holds still this long first, so the core sets its neutral by itself (D40) and the
// headless review never needs a Calibrate tap.
export const STILL_LEAD_SEC = 2.5;

// A head that performs `def` (exported for tests). Calibrate first: neutral is the zero pose.
export function syntheticPose(def: ExerciseDefinition | null, tLead: number): Euler {
  const still: Euler = { pitch: jitter(tLead), yaw: jitter(tLead + 1), roll: jitter(tLead + 2) };
  if (tLead < STILL_LEAD_SEC) return still;
  const t = tLead - STILL_LEAD_SEC;
  if (!def) {
    // Library default: a slow yaw sweep, so the overlay and readout move.
    return { ...still, yaw: 40 * Math.sin((2 * Math.PI * t) / 6) };
  }
  switch (def.kind) {
    case 'romReps': {
      const { f, cycle } = excursion(t, (def.holdSec ?? 0) + 0.5);
      const sign =
        def.direction === 'positive' ? 1 : def.direction === 'negative' ? -1 : cycle % 2 ? -1 : 1;
      return { ...still, [def.axis]: sign * f * (def.targetDeg + 8) };
    }
    case 'holdAtTarget': {
      // Between holds the head must leave the zone, so rest well outside the tolerance window.
      const { f } = excursion(t, def.holdSec + 1);
      const at = (target: number | undefined, jit: number) => {
        if (target === undefined) return jit;
        const away = target - Math.sign(target || 1) * (def.toleranceDeg + 10);
        return away + f * (target - away) + jit;
      };
      return {
        pitch: at(def.target.pitch, still.pitch),
        yaw: at(def.target.yaw, still.yaw),
        roll: at(def.target.roll, still.roll),
      };
    }
    case 'guidedHold':
      return still;
    case 'reposition': {
      // Out past the excursion, then back to a small, steady error and hold still to settle.
      const { f } = excursion(t, 0.5, def.settleSec + 1.5);
      const out = def.excursionDeg + 10;
      const axis = def.axis === 'any' ? 'yaw' : def.axis;
      return { ...ZERO, [axis]: f > 0 ? f * out : 3 };
    }
    case 'oscillation':
      return {
        ...still,
        [def.axis]: (def.targetAmplitudeDeg / 2) * Math.sin(2 * Math.PI * def.targetCadenceHz * t),
      };
  }
}

// Inverse of matrixToEuler: R = Rz(roll)·Ry(yaw)·Rx(pitch), column-major 4×4.
export function eulerToMatrix(e: Euler): number[] {
  const rad = Math.PI / 180;
  const [cx, sx] = [Math.cos(e.pitch * rad), Math.sin(e.pitch * rad)];
  const [cy, sy] = [Math.cos(e.yaw * rad), Math.sin(e.yaw * rad)];
  const [cz, sz] = [Math.cos(e.roll * rad), Math.sin(e.roll * rad)];
  // prettier-ignore
  return [
    cz * cy, sz * cy, -sy, 0,
    cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx, 0,
    cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx, 0,
    0, 0, 0, 1,
  ];
}

// A single dot that follows the synthetic head, so screenshots show the overlay layer is live.
function drawDot(canvas: HTMLCanvasElement | null, pose: Euler): void {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--teal') || 'teal';
  ctx.beginPath();
  ctx.arc(
    w / 2 + (pose.yaw / 90) * (w / 2),
    h / 2 + (pose.pitch / 90) * (h / 2),
    6,
    0,
    2 * Math.PI,
  );
  ctx.fill();
}
