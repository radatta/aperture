import { describe, expect, it, vi } from 'vitest';
import { EXERCISES, getExercise, type ExerciseEvent } from '@aperture/shared/flux';
import { FluxCore } from './core';
import { createFakeEngine, eulerToMatrix, syntheticPose } from './fakeEngine';
import { matrixToEuler } from './headPose';
import type { FluxEngineEvent } from './engine';
import { mirrorForSide, type Side } from './side';

const STAGE = {
  video: document.createElement('video'),
  canvas: document.createElement('canvas'),
};

describe('eulerToMatrix', () => {
  it('round-trips through matrixToEuler', () => {
    const e = { pitch: 12, yaw: -35, roll: 20 };
    const back = matrixToEuler(eulerToMatrix(e));
    expect(back.pitch).toBeCloseTo(12, 6);
    expect(back.yaw).toBeCloseTo(-35, 6);
    expect(back.roll).toBeCloseTo(20, 6);
  });
});

describe('syntheticPose', () => {
  // The headless review relies on this: on `?engine=fake` every exercise finishes a real set through
  // the real core and evaluator. Timed kinds need Start, as on the page.
  it.each(EXERCISES.map((d) => d.id))('completes a set of %s', (id) => {
    for (const side of ['a', 'b'] as Side[]) {
      const def = mirrorForSide(getExercise(id), side);
      const core = new FluxCore();
      core.frame(eulerToMatrix(syntheticPose(null, 0)), 1);
      expect(core.calibrate()).toBe(true);
      core.selectExercise(id, side);
      core.control({ type: 'start' });
      const events: ExerciseEvent[] = [];
      for (let i = 1; i < 30 * 240 && !events.some((e) => e.type === 'setCompleted'); i++) {
        const t = i / 30;
        events.push(
          ...(core.frame(eulerToMatrix(syntheticPose(def, t)), 1 + t * 1000)?.events ?? []),
        );
      }
      expect(
        events.map((e) => e.type),
        `${id} side ${side}`,
      ).toContain('setCompleted');
    }
  });
});

describe('createFakeEngine', () => {
  it('manual mode: emits only what the test scripts, and records calls', async () => {
    const { engine, fake } = createFakeEngine();
    const seen: FluxEngineEvent[] = [];
    engine.subscribe((e) => seen.push(e));
    await engine.start(STAGE);
    engine.selectExercise('chin-tuck', 'a');
    engine.control({ type: 'start' });
    expect(seen).toEqual([]);
    fake.ready('GPU');
    fake.sample({ fps: 24 });
    expect(seen.map((e) => e.type)).toEqual(['ready', 'sample']);
    expect(fake.calls).toEqual(['start', 'select:chin-tuck:a', 'control:start']);
    expect(fake.lastSelect).toEqual({ id: 'chin-tuck', side: 'a' });
    expect(engine.debug()).toMatchObject({ delegate: 'GPU', fallbacks: 0 });
  });

  it('auto mode: boots on CPU and streams samples and the selected exercise state', async () => {
    vi.useFakeTimers();
    const { engine } = createFakeEngine({ auto: true });
    const seen: FluxEngineEvent[] = [];
    engine.subscribe((e) => seen.push(e));
    engine.selectExercise('cervical-rotation', 'a');
    await engine.start(STAGE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.find((e) => e.type === 'ready')).toEqual({ type: 'ready', delegate: 'CPU' });
    expect(seen.some((e) => e.type === 'sample')).toBe(true);
    expect(seen.some((e) => e.type === 'exerciseState')).toBe(true);
    engine.calibrate();
    expect(seen.at(-1)).toEqual({ type: 'calibrated', ok: true });
    engine.stop();
    const n = seen.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.length).toBe(n);
  });
});
