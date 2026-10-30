import { describe, expect, it } from 'vitest';
import { FluxCore } from './core';

// Column-major yaw rotation, as MediaPipe hands it back.
function yaw(deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function pitch(deg: number): number[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
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

  it('a Re-calibrate mid-set keeps the count, and one during the rest keeps the set finished (D55)', () => {
    const core = new FluxCore();
    let t = feed(core, yaw(0), 10, 0);
    core.calibrate();
    core.selectExercise('cervical-rotation', 'a');
    const reps = (dir = 1) => {
      let last = null as null | { repsPos: number; repsNeg: number; phase: string };
      for (let i = 0; i < 2; i++) {
        for (let k = 0; k < 150; k++) {
          const r = core.frame(yaw(55 * dir), (t += 1000 / 30));
          if (r?.state?.kind === 'romReps') last = r.state;
        }
        for (let k = 0; k < 40; k++) {
          const r = core.frame(yaw(0), (t += 1000 / 30));
          if (r?.state?.kind === 'romReps') last = r.state;
        }
      }
      return last;
    };
    const two = reps();
    expect((two?.repsPos ?? 0) + (two?.repsNeg ?? 0)).toBe(2);
    expect(core.calibrate()).toBe(true);
    const after = reps();
    expect((after?.repsPos ?? 0) + (after?.repsNeg ?? 0)).toBe(4);
    // On to the end of the set (5 a side, so 10), then a Re-calibrate during the rest: still complete —
    // turning during the rest counts nothing.
    let done = after;
    for (let i = 0; i < 4 && done?.phase !== 'complete'; i++) done = reps(i < 1 ? 1 : -1);
    expect(done?.phase).toBe('complete');
    expect(core.calibrate()).toBe(true);
    const rest = reps();
    expect(rest?.phase).toBe('complete');
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
      const first = run(dropout, [...hold(yaw(0), 45), null, ...hold(yaw(0), 45)]);
      expect(dropout.calibrated).toBe(false); // 1.5 s + 1.5 s, never 2 s in a row
      // The clock restarted at the dropout: 44 still frames after it, then 2 s needs ~16 more.
      const more = run(dropout, hold(yaw(0), 14), first.t);
      expect(dropout.calibrated).toBe(false);
      run(dropout, hold(yaw(0), 3), more.t);
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

  describe('frontal neutral, and its re-set between sets (D45, D46)', () => {
    const run = (core: FluxCore, ms: (number[] | null)[], t0 = 0) => {
      let t = t0;
      const out = ms.map((m) => core.frame(m, (t += 1000 / 30)));
      return { out, t };
    };
    const hold = (m: number[], n: number) => Array.from({ length: n }, () => m);
    const autos = (out: ReturnType<FluxCore['frame']>[]) => out.filter((r) => r?.autoCalibrated);

    it("the automatic neutral needs a roughly frontal face; a propped phone's pitch is fine", () => {
      const turned = new FluxCore();
      const t = run(turned, hold(yaw(35), 90)).t;
      expect(turned.calibrated).toBe(false); // 3 s still, looking aside
      run(turned, hold(yaw(10), 70), t);
      expect(turned.calibrated).toBe(true);
      const propped = new FluxCore();
      run(propped, hold(pitch(30), 70));
      expect(propped.calibrated).toBe(true);
      for (const m of [pitch(50), roll(30)]) {
        const core = new FluxCore();
        run(core, hold(m, 90));
        expect(core.calibrated).toBe(false);
      }
    });

    // A neutral at yaw 0, then one guided set run to completion with the head still.
    function finishedSet() {
      const core = new FluxCore();
      let t = run(core, hold(yaw(0), 70)).t;
      expect(core.calibrated).toBe(true);
      core.selectExercise('isometric-flexion', 'a');
      core.control({ type: 'start' });
      let done = false;
      while (!done) {
        const r = core.frame(yaw(0), (t += 1000 / 30));
        done = r?.events.some((e) => e.type === 'setCompleted') ?? false;
      }
      return { core, t };
    }

    it('a manual Re-calibrate in the rest isn’t overwritten by a quiet re-set in the same pause (D55)', () => {
      const { core, t } = finishedSet();
      const t2 = run(core, hold(yaw(6), 10), t).t;
      expect(core.calibrate()).toBe(true); // the user's own neutral, at 6°
      const { out } = run(core, hold(yaw(6), 120), t2); // 4 s still, right there
      expect(autos(out)).toEqual([]);
      expect(out.at(-1)?.sample.rel.yaw).toBeCloseTo(0, 0);
    });

    it('between sets, a still head near the neutral re-sets it once per pause, keeping the set', () => {
      const { core, t } = finishedSet();
      const { out, t: t2 } = run(core, hold(yaw(8), 75), t);
      expect(autos(out)).toHaveLength(1);
      expect(autos(out)[0]?.autoCalibrated?.yaw).toBeCloseTo(8, 0);
      expect(out.at(-1)?.sample.rel.yaw).toBeCloseTo(0, 0);
      const last = out.filter((r) => r?.state).at(-1)?.state;
      expect(last).toMatchObject({ phase: 'complete', holdsDone: 5 });
      expect(out.at(-1)?.sample.rom.yaw).toBeGreaterThan(5); // the ROM kept
      const later = run(core, hold(yaw(8), 120), t2);
      expect(autos(later.out)).toEqual([]); // the same pause: once
      // Back to the old zero (8° the other way): the range is re-keyed, not 0→8 plus 0→−8.
      const back = run(core, hold(yaw(0), 30), later.t);
      expect(back.out.at(-1)?.sample.rom.yaw).toBeCloseTo(8, 0);
    });

    it('every fresh pause in the rest re-sets it, so the last before the next set wins', () => {
      const { core, t } = finishedSet();
      const first = run(core, hold(yaw(4), 75), t);
      const second = run(core, hold(yaw(8), 75), first.t); // moved, then a new pause
      const yaws = [...autos(first.out), ...autos(second.out)].map((r) =>
        Math.round(r?.autoCalibrated?.yaw ?? NaN),
      );
      expect(yaws).toEqual([4, 8]);
      expect(second.out.at(-1)?.sample.rel.yaw).toBeCloseTo(0, 0);
      // Kept near the set's own neutral, so re-sets can't creep: 16° is 8° from the last re-set but
      // 16° from where the set ended.
      const far = run(core, hold(yaw(16), 120), second.t);
      expect(autos(far.out)).toEqual([]);
      // Two re-sets, one range: 0° to 16° seen, re-keyed across both, reads 16.
      const back = run(core, hold(yaw(0), 30), far.t);
      expect(back.out.at(-1)?.sample.rom.yaw).toBeCloseTo(16, 0);
    });

    it("a blink or a dropped frame mid-rest isn't a new pause: a still rest re-sets once", () => {
      const { core, t } = finishedSet();
      const { out } = run(
        core,
        [...hold(yaw(8), 75), null, ...hold(yaw(8), 75), null, ...hold(yaw(8), 75)],
        t,
      );
      expect(autos(out)).toHaveLength(1);
    });

    it('re-arms for the next finished set; needs the head frontal as well as near', () => {
      const { core, t } = finishedSet();
      let at = run(core, hold(yaw(8), 75), t).t;
      core.control({ type: 'start' }); // set two, then finished again
      let done = false;
      while (!done) {
        const r = core.frame(yaw(8), (at += 1000 / 30));
        done = r?.events.some((e) => e.type === 'setCompleted') ?? false;
      }
      // Still at the same pose into the next rest: a new rest re-arms it even without moving.
      const same = run(core, hold(yaw(8), 75), at);
      expect(autos(same.out)).toHaveLength(1);
      expect(autos(run(core, hold(yaw(14), 75), same.t).out)).toHaveLength(1);
      // A neutral already 15° to the side: a head 7° further is near it, but no longer frontal.
      const side = new FluxCore();
      let ts = run(side, hold(yaw(15), 70)).t;
      expect(side.calibrated).toBe(true);
      side.selectExercise('isometric-flexion', 'a');
      side.control({ type: 'start' });
      done = false;
      while (!done) {
        const r = side.frame(yaw(15), (ts += 1000 / 30));
        done = r?.events.some((e) => e.type === 'setCompleted') ?? false;
      }
      expect(autos(run(side, hold(yaw(22), 120), ts).out)).toEqual([]);
    });

    it('not for a pose well away from the neutral (a stretch), nor once the next set starts', () => {
      const far = finishedSet();
      expect(autos(run(far.core, hold(yaw(20), 120), far.t).out)).toEqual([]);
      const next = finishedSet();
      next.core.control({ type: 'stop' });
      next.core.control({ type: 'start' });
      expect(autos(run(next.core, hold(yaw(8), 120), next.t).out)).toEqual([]);
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
