import { describe, expect, it } from 'vitest';
import { evaluate, initialState } from './evaluate';
import type {
  Euler,
  EvalControl,
  EvalInput,
  ExerciseDefinition,
  ExerciseEvent,
  ExerciseState,
} from '@aperture/shared/flux';

// ─── helpers ────────────────────────────────────────────────────────────────

const N = (pitch = 0, yaw = 0, roll = 0): Euler => ({ pitch, yaw, roll });
const repeat = (rel: Euler, n: number): Euler[] => Array.from({ length: n }, () => rel);

// Fold `evaluate` over a rel-stream at a fixed fps; optional start/stop frames.
function fold(
  def: ExerciseDefinition,
  rels: Euler[],
  opts: {
    fps?: number;
    startAt?: number;
    stopAt?: number;
    faceVisible?: boolean;
  } = {},
) {
  const { fps = 30, startAt, stopAt, faceVisible = true } = opts;
  const step = 1 / fps;
  let state = initialState(def);
  const events: ExerciseEvent[] = [];
  rels.forEach((rel, i) => {
    const input: EvalInput = { rel, tSec: i * step, faceVisible };
    const control: EvalControl | undefined =
      startAt === i ? { type: 'start' } : stopAt === i ? { type: 'stop' } : undefined;
    const r = evaluate(def, state, input, control);
    state = r.state;
    events.push(...r.events);
  });
  return { state, events };
}

const of = <T extends ExerciseEvent['type']>(
  events: ExerciseEvent[],
  type: T,
): Extract<ExerciseEvent, { type: T }>[] =>
  events.filter((e): e is Extract<ExerciseEvent, { type: T }> => e.type === type);

const base = {
  tracker: 'face',
  instructions: '',
  cues: [],
  conditions: ['general'],
  stages: ['chronic'],
} as const;

// ─── A. romReps ───────────────────────────────────────────────────────────────

describe('romReps', () => {
  const flexion = {
    ...base,
    id: 't-flex',
    name: 't',
    measurement: 'measured',
    kind: 'romReps',
    axis: 'pitch',
    direction: 'negative',
    enterDeg: 15,
    exitDeg: 8,
    targetDeg: 45,
    reps: 10,
  } satisfies ExerciseDefinition;

  it('counts one rep on excursion → return and records peak/target', () => {
    const { events } = fold(flexion, [N(0), N(-20), N(-50), N(-20), N(0)]);
    const reps = of(events, 'repCompleted');
    expect(reps).toHaveLength(1);
    expect(reps[0]?.side).toBe('single');
    expect(reps[0]?.peakDeg).toBeCloseTo(50);
    expect(reps[0]?.reachedTarget).toBe(true);
    expect(reps[0]?.count).toBe(1);
  });

  it('does not double-count jitter across the enter threshold (hysteresis)', () => {
    const { events } = fold(flexion, [N(0), N(-16), N(-10), N(-16), N(-10), N(0)]);
    expect(of(events, 'repCompleted')).toHaveLength(1);
  });

  it('marks reachedTarget false for a sub-target rep', () => {
    const { events } = fold(flexion, [N(0), N(-30), N(0)]);
    const reps = of(events, 'repCompleted');
    expect(reps).toHaveLength(1);
    expect(reps[0]?.reachedTarget).toBe(false);
  });

  it('counts each side independently when bilateral', () => {
    const rotation = {
      ...base,
      id: 't-rot',
      name: 't',
      measurement: 'measured',
      kind: 'romReps',
      axis: 'yaw',
      direction: 'bilateral',
      enterDeg: 15,
      exitDeg: 8,
      targetDeg: 60,
      reps: 10,
    } satisfies ExerciseDefinition;
    const { events } = fold(rotation, [N(0, 0), N(0, 70), N(0, 0), N(0, -70), N(0, 0)]);
    const reps = of(events, 'repCompleted');
    expect(reps.map((r) => r.side)).toEqual(['positive', 'negative']);
    expect(reps.map((r) => r.count)).toEqual([1, 2]); // the running total the voice counts
  });

  it('ignores excursions in the disallowed direction', () => {
    // negative-only: a positive pitch excursion must not count
    const { events } = fold(flexion, [N(0), N(40), N(0)]);
    expect(of(events, 'repCompleted')).toHaveLength(0);
  });

  it('warns once when the head moves off-plane (cross-axis compensation)', () => {
    // rotation is a yaw move; large roll = tilting instead of turning cleanly
    const rotation = {
      ...base,
      id: 't-rot-comp',
      name: 't',
      measurement: 'measured',
      kind: 'romReps',
      axis: 'yaw',
      direction: 'bilateral',
      enterDeg: 15,
      exitDeg: 8,
      targetDeg: 60,
      reps: 10,
    } satisfies ExerciseDefinition;
    const { events } = fold(rotation, repeat(N(0, 30, 25), 40)); // roll 25° off-plane (> 20°)
    const warn = of(events, 'postureWarning');
    expect(warn).toHaveLength(1); // once per episode, not every frame
    expect(warn[0]?.axis).toBe('roll');
  });

  it('requires an end-range hold to hit target when holdSec is set', () => {
    const holdRom = {
      ...base,
      id: 't-hold-rom',
      name: 't',
      measurement: 'measured',
      kind: 'romReps',
      axis: 'yaw',
      direction: 'positive',
      enterDeg: 15,
      exitDeg: 8,
      targetDeg: 30,
      reps: 10,
      holdSec: 1,
    } satisfies ExerciseDefinition;
    // reached target range but returned immediately → not held → not "on target"
    const quick = fold(holdRom, [N(0, 0), N(0, 40), N(0, 0)]);
    expect(of(quick.events, 'repCompleted')[0]?.reachedTarget).toBe(false);
    expect(of(quick.events, 'repCompleted')[0]?.holdReached).toBe(false);
    // held at end range ~1.3s before returning → on target
    const held = fold(holdRom, [N(0, 0), ...repeat(N(0, 40), 40), N(0, 0)]);
    expect(of(held.events, 'repCompleted')[0]?.reachedTarget).toBe(true);
    expect(of(held.events, 'repCompleted')[0]?.holdReached).toBe(true);
  });

  describe('holdReached (the count, spoken when the hold is up — D32)', () => {
    const holdRom = {
      ...base,
      id: 't-hold-rom2',
      name: 't',
      measurement: 'measured',
      kind: 'romReps',
      axis: 'yaw',
      direction: 'positive',
      enterDeg: 15,
      exitDeg: 8,
      targetDeg: 30,
      reps: 10,
      holdSec: 1,
    } satisfies ExerciseDefinition;

    it('fires once per excursion, before the return, with the pending count', () => {
      const { events } = fold(holdRom, [N(0, 0), ...repeat(N(0, 40), 60), N(0, 0)]);
      expect(of(events, 'holdReached')).toEqual([{ type: 'holdReached', count: 1 }]);
      expect(events.map((e) => e.type)).toEqual(['holdReached', 'repCompleted']);
      expect(of(events, 'repCompleted')[0]).toMatchObject({ holdReached: true, count: 1 });
    });

    it('fires on the frame the hold time is crossed', () => {
      let state = initialState(holdRom);
      let before = 0;
      const accum = (s: ExerciseState) => (s.kind === 'romReps' ? s.holdAccumSec : NaN);
      for (let i = 0; i < 60; i++) {
        const r = evaluate(holdRom, state, {
          rel: i === 0 ? N(0, 0) : N(0, 40),
          tSec: i / 30,
          faceVisible: true,
        });
        if (r.events.some((e) => e.type === 'holdReached')) {
          expect(accum(state)).toBeLessThan(1);
          expect(accum(r.state)).toBeGreaterThanOrEqual(1);
          before++;
        }
        state = r.state;
      }
      expect(before).toBe(1);
    });

    it('is not emitted on an early return (the rep still counts, aloud)', () => {
      const { events } = fold(holdRom, [N(0, 0), N(0, 40), N(0, 0)]);
      expect(of(events, 'holdReached')).toHaveLength(0);
      expect(of(events, 'repCompleted')[0]).toMatchObject({ holdReached: false, count: 1 });
    });

    it('is not emitted when the exercise has no hold', () => {
      const { events } = fold(flexion, [N(0), ...repeat(N(-50), 60), N(0)]);
      expect(of(events, 'holdReached')).toHaveLength(0);
      expect(of(events, 'repCompleted')[0]?.holdReached).toBe(false);
    });

    it('carries the running total when bilateral', () => {
      const rot = {
        ...holdRom,
        id: 't-hold-rot',
        direction: 'bilateral',
      } satisfies ExerciseDefinition;
      const { events } = fold(rot, [
        N(0, 0),
        ...repeat(N(0, 40), 40),
        N(0, 0),
        ...repeat(N(0, -40), 40),
        N(0, 0),
      ]);
      expect(of(events, 'holdReached').map((e) => e.count)).toEqual([1, 2]);
      expect(of(events, 'repCompleted').map((e) => e.count)).toEqual([1, 2]);
    });
  });

  it('does not warn when off-plane movement is small', () => {
    const { events } = fold(flexion, repeat(N(-30, 5, 5), 30));
    expect(of(events, 'postureWarning')).toHaveLength(0);
  });

  it('tolerates up to 20° off-plane (flux warned past 15°)', () => {
    const { events } = fold(flexion, repeat(N(-30, 18, 0), 40));
    expect(of(events, 'postureWarning')).toHaveLength(0);
  });

  it('emits setCompleted once and then ignores further motion', () => {
    const twoReps = {
      ...flexion,
      id: 't-2',
      reps: 2,
    } satisfies ExerciseDefinition;
    const { state, events } = fold(twoReps, [
      N(0),
      N(-50),
      N(0), // rep 1
      N(-50),
      N(0), // rep 2 → complete
      N(-50),
      N(0), // ignored
    ]);
    expect(of(events, 'repCompleted').map((r) => r.count)).toEqual([1, 2]);
    const done = of(events, 'setCompleted');
    expect(done).toHaveLength(1);
    expect(done[0]?.summary.count).toBe(2);
    expect(state.phase).toBe('complete');
  });
});

// ─── B. holdAtTarget ──────────────────────────────────────────────────────────

describe('holdAtTarget', () => {
  const stretch = {
    ...base,
    id: 't-hold',
    name: 't',
    measurement: 'approximate',
    kind: 'holdAtTarget',
    target: { roll: 28 },
    toleranceDeg: 12,
    holdSec: 1,
    reps: 1,
  } satisfies ExerciseDefinition;

  it('completes a continuous hold and finishes the (single-rep) set', () => {
    const { state, events } = fold(stretch, repeat(N(0, 0, 28), 45));
    expect(of(events, 'positionReached')).toHaveLength(1);
    expect(of(events, 'holdCompleted')).toHaveLength(1);
    expect(of(events, 'setCompleted')).toHaveLength(1);
    expect(state.phase).toBe('complete');
  });

  it('resets the timer if you leave the target mid-hold', () => {
    // 0.5s in position, drop out, then a full 1s in position
    const rels = [
      ...repeat(N(0, 0, 28), 15),
      ...repeat(N(0, 0, 0), 10),
      ...repeat(N(0, 0, 28), 40),
    ];
    const { events } = fold(stretch, rels);
    expect(of(events, 'positionLost')).toHaveLength(1);
    expect(of(events, 'holdCompleted')).toHaveLength(1); // only the second attempt counts
    expect(of(events, 'holdBroken')).toHaveLength(0); // 0.5 s is flicker, not a broken hold
  });

  describe('holdBroken (said out loud — D33)', () => {
    const long = { ...stretch, id: 't-hold-long', holdSec: 3 } satisfies ExerciseDefinition;
    const IN = N(0, 0, 28);
    const OUT = N(0, 0, 0);
    // n frames in position (the first only arms the timer, so held = (n − 1) / 30 s), then out.
    const breakAfter = (n: number, out = 12) =>
      of(fold(long, [...repeat(IN, n), ...repeat(OUT, out)]).events, 'holdBroken');

    it('reports how long the hold lasted', () => {
      const ev = breakAfter(45);
      expect(ev).toHaveLength(1);
      expect(ev[0]?.heldSec).toBeCloseTo(44 / 30, 5);
    });

    it('only past a 1 s hold — shorter is flicker', () => {
      expect(breakAfter(30)).toHaveLength(0); // ≈ 0.97 s
      expect(breakAfter(32)).toHaveLength(1); // ≈ 1.03 s
      const flicker = fold(long, [...repeat(IN, 15), ...repeat(OUT, 12)]);
      expect(of(flicker.events, 'positionLost')).toHaveLength(1);
    });

    it('only once the head has stayed out for 0.3 s — a blip back in says nothing', () => {
      expect(breakAfter(45, 8)).toHaveLength(0); // out ≈ 0.23 s
      const blip = fold(long, [...repeat(IN, 45), ...repeat(OUT, 3), ...repeat(IN, 10)]);
      expect(of(blip.events, 'positionLost')).toHaveLength(1);
      expect(of(blip.events, 'positionReached')).toHaveLength(2);
      expect(of(blip.events, 'holdBroken')).toHaveLength(0);
    });
  });

  it('leaving after a completed hold is a release, not a broken hold', () => {
    const two = { ...stretch, id: 't-hold-two', holdSec: 1, reps: 2 } satisfies ExerciseDefinition;
    const { events } = fold(two, [
      ...repeat(N(0, 0, 28), 40),
      ...repeat(N(0, 0, 0), 10),
      ...repeat(N(0, 0, 28), 40),
    ]);
    expect(of(events, 'holdCompleted')).toHaveLength(2);
    expect(of(events, 'holdBroken')).toHaveLength(0);
  });

  it('requires ALL specified axes within tolerance', () => {
    const multi = {
      ...stretch,
      id: 't-hold2',
      target: { yaw: 30, pitch: -20 },
      toleranceDeg: 10,
    } satisfies ExerciseDefinition;
    // yaw right but pitch wrong → never in position
    const { events } = fold(multi, repeat(N(0, 30, 0), 45));
    expect(of(events, 'holdCompleted')).toHaveLength(0);
    // both correct → completes
    const ok = fold(multi, repeat(N(-20, 30, 0), 45));
    expect(of(ok.events, 'holdCompleted')).toHaveLength(1);
  });

  it('does not hold when the face is not visible', () => {
    const { events } = fold(stretch, repeat(N(0, 0, 28), 45), {
      faceVisible: false,
    });
    expect(of(events, 'holdCompleted')).toHaveLength(0);
  });

  it('requires leaving the zone between reps', () => {
    const twoRep = {
      ...stretch,
      id: 't-hold3',
      holdSec: 0.5,
      reps: 2,
    } satisfies ExerciseDefinition;
    // continuous hold → only 1 counts (must release for the 2nd)
    const cont = fold(twoRep, repeat(N(0, 0, 28), 60));
    expect(of(cont.events, 'holdCompleted')).toHaveLength(1);
    // hold, release, hold again → 2 counts, set complete
    const rels = [
      ...repeat(N(0, 0, 28), 20),
      ...repeat(N(0, 0, 0), 10),
      ...repeat(N(0, 0, 28), 20),
    ];
    const two = fold(twoRep, rels);
    expect(of(two.events, 'holdCompleted')).toHaveLength(2);
    expect(of(two.events, 'setCompleted')).toHaveLength(1);
  });
});

// ─── C. guidedHold ────────────────────────────────────────────────────────────

describe('guidedHold', () => {
  const iso = {
    ...base,
    id: 't-iso',
    name: 't',
    measurement: 'guided',
    kind: 'guidedHold',
    holdSec: 1,
    reps: 2,
    restSec: 0.5,
    driftToleranceDeg: 8,
  } satisfies ExerciseDefinition;

  it('does nothing until started', () => {
    const { state, events } = fold(iso, repeat(N(0), 60));
    expect(events).toHaveLength(0);
    expect(state.phase).toBe('ready');
  });

  it('runs hold → rest → hold and completes the set', () => {
    const { state, events } = fold(iso, repeat(N(0), 90), { startAt: 0 });
    expect(of(events, 'holdStarted').length).toBeGreaterThanOrEqual(2);
    expect(of(events, 'holdCompleted')).toHaveLength(2);
    expect(of(events, 'setCompleted')).toHaveLength(1);
    expect(state.phase).toBe('complete');
  });

  it('warns once when the head drifts, not every frame', () => {
    const drifty = {
      ...iso,
      id: 't-iso2',
      holdSec: 2,
      reps: 1,
    } satisfies ExerciseDefinition;
    const rels = [
      ...repeat(N(0), 10),
      ...repeat(N(0, 15, 0), 10), // drift (mag 15 > 8)
      ...repeat(N(0), 10),
    ];
    const { events } = fold(drifty, rels, { startAt: 0 });
    const drift = of(events, 'driftWarning');
    expect(drift).toHaveLength(1);
    expect(drift[0]?.axis).toBe('yaw');
  });

  it('never warns when driftTolerance is null (pure guide)', () => {
    const glide = {
      ...iso,
      id: 't-glide',
      holdSec: 1,
      reps: 1,
      driftToleranceDeg: null,
    } satisfies ExerciseDefinition;
    const { events } = fold(glide, repeat(N(0, 40, 0), 60), { startAt: 0 });
    expect(of(events, 'driftWarning')).toHaveLength(0);
  });
});

// ─── D. reposition ────────────────────────────────────────────────────────────

describe('reposition', () => {
  const jps = {
    ...base,
    id: 't-jps',
    name: 't',
    measurement: 'approximate',
    kind: 'reposition',
    axis: 'any',
    excursionDeg: 25,
    settleSec: 1,
    reps: 1,
  } satisfies ExerciseDefinition;

  it('records the return-to-neutral error after an excursion + settle', () => {
    const rels = [
      N(0),
      ...repeat(N(0, 30, 0), 5), // move away (mag 30 ≥ 25)
      ...repeat(N(0, 2, 0), 40), // return near neutral and hold still
    ];
    const { state, events } = fold(jps, rels, { startAt: 0 });
    const trials = of(events, 'trialCompleted');
    expect(trials).toHaveLength(1);
    expect(trials[0]?.errorDeg).toBeCloseTo(2, 1);
    expect(state.phase).toBe('complete');
  });

  it('needs a real excursion first (no trial without moving away)', () => {
    const { events } = fold(jps, repeat(N(0, 2, 0), 50), { startAt: 0 });
    expect(of(events, 'trialCompleted')).toHaveLength(0);
  });
});

// ─── D. oscillation ───────────────────────────────────────────────────────────

describe('oscillation', () => {
  const gaze = {
    ...base,
    id: 't-gaze',
    name: 't',
    measurement: 'approximate',
    kind: 'oscillation',
    axis: 'yaw',
    targetAmplitudeDeg: 20,
    targetCadenceHz: 0.8,
    durationSec: 2,
  } satisfies ExerciseDefinition;

  it('counts oscillation cycles and measures peak-to-peak amplitude', () => {
    const fps = 30;
    const f = 0.8;
    const rels = Array.from({ length: fps * 2 + 5 }, (_, i) =>
      N(0, 20 * Math.sin(2 * Math.PI * f * (i / fps))),
    );
    const { state, events } = fold(gaze, rels, { startAt: 0, fps });
    const cycles = of(events, 'cycleCompleted');
    expect(cycles.length).toBeGreaterThanOrEqual(2);
    // peak-to-peak of a ±20° sine ≈ 40°
    const amp = cycles.at(-1)?.amplitudeDeg;
    expect(amp).toBeGreaterThan(30);
    expect(amp).toBeLessThan(45);
    expect(of(events, 'setCompleted')).toHaveLength(1);
    expect(state.phase).toBe('complete');
  });
});

// ─── purity / determinism ─────────────────────────────────────────────────────

describe('purity', () => {
  it('is deterministic: same stream → identical state and events', () => {
    const rot = {
      ...base,
      id: 't-pure',
      name: 't',
      measurement: 'measured',
      kind: 'romReps',
      axis: 'yaw',
      direction: 'bilateral',
      enterDeg: 15,
      exitDeg: 8,
      targetDeg: 60,
      reps: 10,
    } satisfies ExerciseDefinition;
    const rels = [N(0), N(0, 70), N(0), N(0, -70), N(0)];
    const a = fold(rot, rels);
    const b = fold(rot, rels);
    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
  });

  it('resets to initial state on stop', () => {
    const rot = {
      ...base,
      id: 't-stop',
      name: 't',
      measurement: 'measured',
      kind: 'romReps',
      axis: 'yaw',
      direction: 'bilateral',
      enterDeg: 15,
      exitDeg: 8,
      targetDeg: 60,
      reps: 10,
    } satisfies ExerciseDefinition;
    const { state } = fold(rot, [N(0), N(0, 70), N(0)], { stopAt: 2 });
    expect(state).toEqual(initialState(rot));
  });
});

// ─── Aperture: "Again" for every kind ─────────────────────────────────────────

describe('Again (start from complete)', () => {
  // Finish a set with `rels`, then press Again and replay the same stream after it.
  function twoSets(def: ExerciseDefinition, rels: Euler[], startFirst: boolean) {
    const first = fold(def, rels, startFirst ? { startAt: 0 } : {});
    expect(first.state.phase).toBe('complete');
    const t0 = rels.length / 30 + 1;
    let state = first.state;
    const events: ExerciseEvent[] = [];
    rels.forEach((rel, i) => {
      const control: EvalControl | undefined = i === 0 ? { type: 'start' } : undefined;
      const r = evaluate(def, state, { rel, tSec: t0 + i / 30, faceVisible: true }, control);
      state = r.state;
      events.push(...r.events);
    });
    return { state, events };
  }

  it('romReps: a second set counts from zero', () => {
    const flex = {
      ...base,
      id: 't-flex2',
      name: 't',
      measurement: 'measured',
      kind: 'romReps',
      axis: 'pitch',
      direction: 'negative',
      enterDeg: 15,
      exitDeg: 8,
      targetDeg: 45,
      reps: 1,
    } satisfies ExerciseDefinition;
    const { state, events } = twoSets(flex, [N(0), N(-20), N(-50), N(-20), N(0)], false);
    expect(of(events, 'repCompleted').map((r) => r.count)).toEqual([1]); // the voice restarts at One
    expect(of(events, 'setCompleted')).toHaveLength(1);
    expect(state.phase).toBe('complete');
  });

  it('holdAtTarget: a second set needs its own holds', () => {
    const hold = {
      ...base,
      id: 't-hold2',
      name: 't',
      measurement: 'approximate',
      kind: 'holdAtTarget',
      target: { roll: 28 },
      toleranceDeg: 12,
      holdSec: 1,
      reps: 1,
    } satisfies ExerciseDefinition;
    const { state, events } = twoSets(
      hold,
      [...repeat(N(0), 3), ...repeat(N(0, 0, 28), 45)],
      false,
    );
    expect(of(events, 'holdCompleted')).toHaveLength(1);
    expect(of(events, 'setCompleted')).toHaveLength(1);
    expect(state.kind === 'holdAtTarget' && state.holdsDone).toBe(1);
  });

  it('guidedHold: holdsDone restarts at zero (flux carried it over)', () => {
    const iso = {
      ...base,
      id: 't-iso2',
      name: 't',
      measurement: 'guided',
      kind: 'guidedHold',
      holdSec: 1,
      reps: 2,
      restSec: 0.5,
      driftToleranceDeg: 8,
    } satisfies ExerciseDefinition;
    const { state, events } = twoSets(iso, repeat(N(0), 90), true);
    expect(of(events, 'holdCompleted')).toHaveLength(2);
    expect(of(events, 'setCompleted')).toHaveLength(1);
    expect(state.kind === 'guidedHold' && state.holdsDone).toBe(2);
  });

  it('reposition: trials and error sums restart (flux averaged across sets)', () => {
    const jps = {
      ...base,
      id: 't-jps2',
      name: 't',
      measurement: 'approximate',
      kind: 'reposition',
      axis: 'any',
      excursionDeg: 25,
      settleSec: 1,
      reps: 1,
    } satisfies ExerciseDefinition;
    const rels = [N(0), ...repeat(N(0, 30, 0), 5), ...repeat(N(0, 4, 0), 40)];
    const { state, events } = twoSets(jps, rels, true);
    expect(of(events, 'trialCompleted')).toHaveLength(1);
    expect(state.kind === 'reposition' && state.trialsDone).toBe(1);
    expect(state.kind === 'reposition' && state.errorCount).toBe(1);
  });
});
