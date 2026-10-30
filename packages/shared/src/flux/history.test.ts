import { describe, expect, it } from 'vitest';
import type { FluxSet } from '../types';
import type { RecordFluxSetInput } from '../api';
import { ulid } from '../ulid';
import { EXERCISES, getExercise } from './definitions';
import {
  fluxFilterError,
  fluxSetError,
  groupByDay,
  hasSide,
  inRange,
  plannedCount,
  setMetric,
  SHORT_NAMES,
  sideLabel,
  summarizeSets,
} from './history';

const input = (over: Partial<RecordFluxSetInput> = {}): RecordFluxSetInput => ({
  id: ulid(),
  day: '2026-10-20',
  exerciseId: 'cervical-rotation',
  kind: 'romReps',
  side: null,
  condition: null,
  count: 20,
  avgPeakDeg: 50,
  avgErrorDeg: null,
  rom: { pitch: 1, yaw: 2, roll: 3 },
  calibrated: true,
  delegate: 'GPU',
  durationSec: 200,
  completedAt: 1_000,
  repTaskId: null,
  stoppedEarly: false,
  planned: 10,
  ...over,
});
const row = (over: Partial<FluxSet> = {}): FluxSet => ({
  ...input(),
  avgPeakDeg: 50,
  avgErrorDeg: null,
  userId: 'u',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  ...over,
});

describe('sideLabel (D48)', () => {
  it('names each side by where the head mainly goes', () => {
    const label = (id: Parameters<typeof getExercise>[0]) => [
      sideLabel(getExercise(id), 'a'),
      sideLabel(getExercise(id), 'b'),
    ];
    expect(label('upper-trap-stretch')).toEqual(['Right', 'Left']); // roll +28: tilt right
    expect(label('levator-scapulae-stretch')).toEqual(['Right', 'Left']); // yaw +30: turn right
    expect(label('scalene-stretch')).toEqual(['Left', 'Right']); // roll −22 outweighs yaw +18
  });

  it('hasSide is exactly the three one-sided stretches', () => {
    expect(EXERCISES.filter(hasSide).map((d) => d.id)).toEqual([
      'upper-trap-stretch',
      'levator-scapulae-stretch',
      'scalene-stretch',
    ]);
  });
});

describe('fluxSetError', () => {
  it('accepts a well-formed set, sided or not', () => {
    expect(fluxSetError(input())).toBeNull();
    expect(
      fluxSetError(input({ exerciseId: 'scalene-stretch', kind: 'holdAtTarget', side: 'b' })),
    ).toBeNull();
  });

  it.each<[string, Partial<RecordFluxSetInput>, string]>([
    ['a bad id', { id: 'x' }, 'valid id'],
    ['a bad day', { day: '2026-13-40' }, 'valid day'],
    ['an unknown exercise', { exerciseId: 'nope' }, 'Unknown Flux exercise'],
    ['the wrong kind', { kind: 'oscillation' }, 'romReps'],
    ['a side on an unsided exercise', { side: 'a' }, 'has no side'],
    [
      'no side on a stretch',
      { exerciseId: 'upper-trap-stretch', kind: 'holdAtTarget' },
      'needs a side',
    ],
    ['an unknown condition', { condition: 'broken' as never }, 'Unknown condition'],
    ['an inherited key as a condition', { condition: 'toString' as never }, 'Unknown condition'],
    ['a fractional count', { count: 2.5 }, 'whole number'],
    ['a NaN measurement', { avgPeakDeg: Number.NaN }, 'not a number'],
    ['a missing rom axis', { rom: { pitch: 1, yaw: 2 } as never }, 'not a number'],
    ['an unknown delegate', { delegate: 'TPU' as never }, 'delegate'],
    ['an empty rep id', { repTaskId: '' }, 'Roll rep'],
    ['no stopped-early flag', { stoppedEarly: undefined as never }, 'stopped early'],
    ['a fractional planned count', { planned: 2.5 }, 'planned count'],
    ['a zero planned count', { planned: 0 }, 'planned count'],
    ['a stopped set with nothing in it', { stoppedEarly: true, count: 0 }, 'first rep'],
    ['no planned count on a counted exercise', { planned: null }, 'needs its planned count'],
    [
      'a planned count on a timed exercise',
      { exerciseId: 'gaze-stability', kind: 'oscillation', planned: 10 },
      'no planned count',
    ],
  ])('refuses %s', (_, over, msg) => {
    expect(fluxSetError(input(over))).toContain(msg);
  });

  it('takes a stopped set with something in it, and a timed set with no planned count (D55)', () => {
    expect(fluxSetError(input({ stoppedEarly: true, count: 2, planned: 10 }))).toBeNull();
    expect(
      fluxSetError(input({ exerciseId: 'gaze-stability', kind: 'oscillation', planned: null })),
    ).toBeNull();
  });
});

describe('plannedCount (D56)', () => {
  it('is both sides for a bilateral drill, the reps otherwise, none for a timed set', () => {
    const planned = (id: Parameters<typeof getExercise>[0]) => plannedCount(getExercise(id));
    expect(planned('cervical-rotation')).toBe(10);
    expect(planned('cervical-flexion')).toBe(6);
    expect(planned('chin-tuck')).toBe(6);
    expect(planned('deep-neck-flexor')).toBe(6);
    expect(planned('joint-position-sense')).toBe(6);
    expect(planned('gaze-stability')).toBeNull();
  });
});

describe('filters', () => {
  it('from/to come in pairs of day keys', () => {
    expect(fluxFilterError(undefined)).toBeNull();
    expect(fluxFilterError({ exerciseId: 'chin-tuck' })).toBeNull();
    expect(fluxFilterError({ from: '2026-10-01', to: '2026-10-31' })).toBeNull();
    expect(fluxFilterError({ to: '2026-10-31' })).toContain('both');
    expect(fluxFilterError({ from: 'yesterday', to: '2026-10-31' })).toContain('YYYY-MM-DD');
  });

  it('inRange keeps alive sets in range, newest first', () => {
    const a = row({ day: '2026-10-01', completedAt: 1 });
    const b = row({ day: '2026-10-05', completedAt: 2, exerciseId: 'chin-tuck' });
    const gone = row({ day: '2026-10-05', completedAt: 3, deletedAt: 9 });
    expect(inRange([a, b, gone]).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(inRange([a, b], { from: '2026-10-02', to: '2026-10-31' })).toEqual([b]);
    expect(inRange([a, b], { exerciseId: 'cervical-rotation' })).toEqual([a]);
  });
});

describe('setMetric', () => {
  it('judges each kind by its own number', () => {
    const m = (id: Parameters<typeof getExercise>[0], over: Partial<FluxSet>) =>
      setMetric(getExercise(id), { count: 0, avgPeakDeg: null, avgErrorDeg: null, ...over });
    expect(m('cervical-rotation', { avgPeakDeg: 52 })).toMatchObject({
      value: 52,
      unit: '°',
      target: 60,
      betterWhen: 'higher',
    });
    expect(m('cervical-rotation', {})).toBeNull();
    expect(m('chin-tuck', { count: 8 })).toMatchObject({ value: 8, unit: 'holds', target: 6 });
    expect(m('deep-neck-flexor', { count: 10 })).toMatchObject({ unit: 'reps' });
    expect(m('joint-position-sense', { avgErrorDeg: 3.1 })).toMatchObject({
      value: 3.1,
      betterWhen: 'lower',
    });
    expect(m('gaze-stability', { count: 24 })).toMatchObject({ unit: 'cycles' });
  });
});

describe('grouping and summaries', () => {
  it('groupByDay: newest day first, each newest first', () => {
    const a = row({ day: '2026-10-01', completedAt: 1 });
    const b = row({ day: '2026-10-02', completedAt: 2 });
    const c = row({ day: '2026-10-02', completedAt: 3 });
    expect(groupByDay([a, b, c]).map((g) => [g.day, g.sets.map((s) => s.id)])).toEqual([
      ['2026-10-02', [c.id, b.id]],
      ['2026-10-01', [a.id]],
    ]);
  });

  it('summarizeSets: per exercise in the order done, "sets" only on the first', () => {
    expect(summarizeSets([])).toBe('');
    expect(summarizeSets([row()])).toBe('1 set rotation');
    expect(
      summarizeSets([
        row({ exerciseId: 'upper-trap-stretch', completedAt: 3 }),
        row({ completedAt: 1 }),
        row({ completedAt: 2 }),
      ]),
    ).toBe('2 sets rotation, 1 upper trap');
  });

  it('every exercise has a short name', () => {
    expect(Object.keys(SHORT_NAMES).sort()).toEqual(EXERCISES.map((d) => d.id).sort());
  });
});
