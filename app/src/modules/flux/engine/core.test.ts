import { describe, expect, it } from 'vitest';
import { FluxCore } from './core';

// Column-major yaw rotation, as MediaPipe hands it back.
function yaw(deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function roll(deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// Feed `n` frames at 30 fps from `t0Ms`, holding one matrix. Returns the last frame's ms.
function feed(core: FluxCore, m: number[] | null, n: number, t0Ms: number): number {
  let t = t0Ms;
  for (let i = 0; i < n; i++) core.frame(m, (t += 1000 / 30));
  return t;
}

describe('FluxCore', () => {
  it('drops a frame whose timestamp does not increase', () => {
    const core = new FluxCore();
    expect(core.frame(yaw(0), 100)).not.toBeNull();
    expect(core.frame(yaw(0), 100)).toBeNull();
    expect(core.frame(yaw(0), 50)).toBeNull();
  });

  it('refuses to calibrate without a face, then accepts once one is seen', () => {
    const core = new FluxCore();
    core.frame(null, 10);
    expect(core.calibrate()).toBe(false);
    expect(core.calibrated).toBe(false);
    core.frame(yaw(10), 20);
    expect(core.calibrate()).toBe(true);
    expect(core.calibrated).toBe(true);
  });

  it('measures relative to the calibrated neutral and only accrues ROM after calibration', () => {
    const core = new FluxCore();
    let t = feed(core, yaw(20), 30, 0);
    const before = core.frame(yaw(20), (t += 33));
    expect(before?.sample.rom.yaw).toBe(0);
    expect(core.calibrate()).toBe(true);
    t = feed(core, yaw(50), 60, t);
    const after = core.frame(yaw(50), t + 33);
    expect(after?.sample.rel.yaw).toBeGreaterThan(25);
    expect(after?.sample.raw.yaw).toBeCloseTo(50, 0);
    // max − min of the smoothed rel since calibration; the 1€ filter catches up within a frame or two.
    expect(after?.sample.rom.yaw).toBeGreaterThan(10);
  });

  it('holds the last pose when the face disappears', () => {
    const core = new FluxCore();
    const t = feed(core, yaw(30), 30, 0);
    const lost = core.frame(null, t + 33);
    expect(lost?.sample.faceVisible).toBe(false);
    expect(lost?.sample.rel.yaw).toBeGreaterThan(25);
  });

  it('throttles exercise state to ~15 Hz but never events', () => {
    const core = new FluxCore();
    core.selectExercise('cervical-rotation', 'a');
    let states = 0;
    let t = 0;
    for (let i = 0; i < 30; i++) if (core.frame(yaw(0), (t += 1000 / 30))?.state) states++;
    // At 30 fps the ≥1/15 s gate lets through roughly every second-to-third frame (flux parity).
    expect(states).toBeGreaterThanOrEqual(10);
    expect(states).toBeLessThanOrEqual(16);
  });

  it('selectExercise resets ROM and returns the fresh state; null clears it', () => {
    const core = new FluxCore();
    let t = feed(core, yaw(0), 10, 0);
    core.calibrate();
    t = feed(core, yaw(40), 30, t);
    expect(core.selectExercise('cervical-rotation', 'a')?.phase).toBe('active');
    expect(core.frame(yaw(40), t + 33)?.sample.rom.yaw).toBe(0);
    expect(core.selectExercise(null, 'a')).toBeNull();
    expect(core.control({ type: 'start' })).toBeNull();
  });

  it('applies side B by mirroring the stretch target', () => {
    // upper-trap-stretch targets roll +28; side B is roll −28.
    const reached = (side: 'a' | 'b') => {
      const core = new FluxCore();
      let t = feed(core, roll(0), 10, 0);
      core.calibrate();
      core.selectExercise('upper-trap-stretch', side);
      let hit = false;
      for (let i = 0; i < 60; i++) {
        const r = core.frame(roll(-28), (t += 1000 / 30));
        if (r?.events.some((e) => e.type === 'positionReached')) hit = true;
      }
      return hit;
    };
    expect(reached('a')).toBe(false);
    expect(reached('b')).toBe(true);
  });

  describe('auto-calibrate (D40)', () => {
    // Frames at 30 fps from t, one matrix each; returns every result and the last ms.
    const run = (core: FluxCore, ms: (number[] | null)[], t0 = 0) => {
      let t = t0;
      const out = ms.map((m) => core.frame(m, (t += 1000 / 30)));
      return { out, t };
    };
    const hold = (m: number[] | null, n: number) => Array.from({ length: n }, () => m);

    it('sets the neutral once a visible face has held still for 2 s, once', () => {
      const core = new FluxCore();
      const { out } = run(core, hold(yaw(12), 90));
      const auto = out.flatMap((r, i) => (r?.autoCalibrated ? [i] : []));
      expect(auto).toHaveLength(1);
      expect(auto[0]).toBeGreaterThanOrEqual(60); // 2 s at 30 fps
      expect(auto[0]).toBeLessThan(64);
      expect(out[auto[0] ?? 0]?.autoCalibrated?.yaw).toBeCloseTo(12, 0);
      expect(core.calibrated).toBe(true);
      expect(out.at(-1)?.sample.rel.yaw).toBeCloseTo(0, 1);
    });

    it('not while moving, nor without a face, and a dropout restarts the clock', () => {
      const moving = new FluxCore();
      run(
        moving,
        Array.from({ length: 120 }, (_, i) => yaw(30 * Math.sin(i / 5))),
      );
      expect(moving.calibrated).toBe(false);
      const faceless = new FluxCore();
      run(faceless, hold(null, 120));
      expect(faceless.calibrated).toBe(false);
      const dropout = new FluxCore();
      run(dropout, [...hold(yaw(0), 45), null, ...hold(yaw(0), 45)]);
      expect(dropout.calibrated).toBe(false); // 1.5 s + 1.5 s, never 2 s in a row
      run(dropout, hold(yaw(0), 30), 5000);
      expect(dropout.calibrated).toBe(true);
    });

    it('the evaluator waits for the neutral, while its state still posts at the throttle', () => {
      const core = new FluxCore();
      core.selectExercise('cervical-rotation', 'a');
      // A raw 50° turn before any neutral: no "Hold", no rep, no count.
      const { out, t } = run(core, [
        ...hold(yaw(50), 40),
        ...hold(yaw(0), 10),
        ...hold(yaw(50), 10),
      ]);
      expect(out.flatMap((r) => r?.events ?? [])).toEqual([]);
      expect(out.filter((r) => r?.state).length).toBeGreaterThan(20);
      expect(core.calibrated).toBe(false);
      // Then held still to a neutral, a real rep counts.
      const after = run(core, [...hold(yaw(0), 70), ...hold(yaw(55), 160), ...hold(yaw(0), 30)], t);
      expect(core.calibrated).toBe(true);
      const types = after.out.flatMap((r) => r?.events ?? []).map((e) => e.type);
      expect(types).toContain('holdEntered');
      expect(types).toContain('repCompleted');
    });
  });

  it('applies start/stop controls between frames', () => {
    const core = new FluxCore();
    core.selectExercise('deep-neck-flexor', 'a');
    const started = core.control({ type: 'start' });
    expect(started?.state.phase).toBe('active');
    expect(core.control({ type: 'stop' })?.state.phase).toBe('ready');
  });
});
