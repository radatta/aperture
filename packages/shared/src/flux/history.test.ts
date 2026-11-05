import { describe, expect, it } from 'vitest';
import type { FluxSet } from '../types';
import type { RecordFluxSetInput } from '../api';
import { ulid } from '../ulid';
import { EXERCISES, getExercise } from './definitions';
import {
  fluxExerciseSummary,
  fluxFilterError,
  fluxNoteFingerprint,
  fluxNoteText,
  fluxSetError,
  fluxSetsError,
  fluxWeekLine,
  fluxWeekStart,
  fluxWeekSummary,
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
      target: 50,
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

describe('fluxSetsError (D61)', () => {
  it('accepts a map of catalogue ids to whole numbers 1–5, and nothing else', () => {
    expect(fluxSetsError({})).toBeNull();
    expect(fluxSetsError({ 'chin-tuck': 1, 'cervical-rotation': 5 })).toBeNull();
    expect(fluxSetsError({ 'chin-tuck': 0 })).toContain('1 to 5');
    expect(fluxSetsError({ 'chin-tuck': 6 })).toContain('1 to 5');
    expect(fluxSetsError({ 'chin-tuck': 2.5 })).toContain('whole number');
    expect(fluxSetsError({ 'chin-tuck': '3' })).toContain('whole number');
    expect(fluxSetsError({ nope: 2 })).toContain('Unknown Flux exercise');
    expect(fluxSetsError(null)).toContain('map');
    expect(fluxSetsError([1])).toContain('map');
  });
});

// --- The weekly note (D62) ---
describe('fluxWeekStart', () => {
  it('is the Monday of the week the day is in', () => {
    expect(fluxWeekStart('2026-11-02')).toBe('2026-11-02'); // a Monday
    expect(fluxWeekStart('2026-11-05')).toBe('2026-11-02'); // Thursday
    expect(fluxWeekStart('2026-11-08')).toBe('2026-11-02'); // Sunday
    expect(fluxWeekStart('2026-11-09')).toBe('2026-11-09'); // the next Monday
  });
});

const weekSet = (over: Partial<FluxSet> = {}): FluxSet => ({
  id: ulid(),
  userId: 'u',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  day: '2026-11-03',
  exerciseId: 'cervical-rotation',
  kind: 'romReps',
  side: null,
  condition: null,
  count: 10,
  avgPeakDeg: 44,
  avgErrorDeg: null,
  rom: { pitch: 4, yaw: 100, roll: 5 },
  calibrated: true,
  delegate: 'GPU',
  durationSec: 150,
  completedAt: 1_000,
  repTaskId: null,
  stoppedEarly: false,
  planned: 10,
  ...over,
});

describe('fluxWeekSummary + fluxWeekLine', () => {
  const sets = [
    weekSet({ completedAt: 1_000, avgPeakDeg: 44 }),
    weekSet({ completedAt: 2_000, avgPeakDeg: 53, day: '2026-11-05' }),
    weekSet({
      completedAt: 3_000,
      exerciseId: 'upper-trap-stretch',
      kind: 'holdAtTarget',
      side: 'a',
      avgPeakDeg: null,
      count: 3,
      planned: 3,
    }),
    weekSet({ completedAt: 500, day: '2026-10-29', avgPeakDeg: 40 }), // last week
    weekSet({ completedAt: 100, day: '2026-10-20', avgPeakDeg: 30 }), // two weeks ago: ignored
  ];

  it('counts this week against last, per exercise, most sets first, with sides for a sided stretch', () => {
    const s = fluxWeekSummary(sets, '2026-11-02');
    expect(s).toMatchObject({
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      totalSets: 3,
      lastWeekSets: 1,
    });
    expect(s.exercises.map((e) => e.exerciseId)).toEqual([
      'cervical-rotation',
      'upper-trap-stretch',
    ]);
    expect(s.exercises[0]).toMatchObject({
      sets: 2,
      first: 44,
      latest: 53,
      unit: '°',
      sides: null,
      lastWeek: { sets: 1, latest: 40 },
    });
    expect(s.exercises[1]).toMatchObject({ sets: 1, sides: { right: 1, left: 0 }, lastWeek: null });
  });

  it('writes the line: counts, the angle first → latest from two sets up, last week beside it', () => {
    expect(fluxWeekLine(fluxWeekSummary(sets, '2026-11-02'))).toBe(
      'This week: 2 sets rotation 44° → 53°, 1 upper trap · last week 1',
    );
    expect(fluxWeekLine(fluxWeekSummary(sets.slice(0, 3), '2026-11-02'))).toBe(
      'This week: 2 sets rotation 44° → 53°, 1 upper trap · first week',
    );
    expect(fluxWeekLine(fluxWeekSummary(sets, '2026-11-02')).length).toBeLessThanOrEqual(140);
  });

  it('stays within the cap with every exercise in the week', () => {
    const all = EXERCISES.map((def, i) =>
      weekSet({ exerciseId: def.id, kind: def.kind, side: null, avgPeakDeg: null, completedAt: i }),
    );
    const line = fluxWeekLine(fluxWeekSummary(all, '2026-11-02'));
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.endsWith('…')).toBe(true);
  });

  it('the exercise summary is the MCP shape: a stopped set keeps its angle, loses its count', () => {
    const [e] = fluxExerciseSummary([
      weekSet({ completedAt: 1, avgPeakDeg: 44 }),
      weekSet({ completedAt: 2, avgPeakDeg: 50, stoppedEarly: true, count: 3 }),
    ]);
    expect(e).toEqual({
      exerciseId: 'cervical-rotation',
      exercise: 'Neck Rotation',
      sets: 2,
      stoppedEarly: 1,
      metric: 'avg peak',
      unit: '°',
      first: 44,
      latest: 50,
      betterWhen: 'higher',
      target:
        getExercise('cervical-rotation').kind === 'romReps'
          ? (getExercise('cervical-rotation') as { targetDeg: number }).targetDeg
          : undefined,
    });
  });
});

describe('fluxNoteFingerprint', () => {
  it('is the identity of the week’s sets: order-free, and a swap of one set for another changes it', () => {
    const a = weekSet({ id: 'A', completedAt: 1 });
    const b = weekSet({ id: 'B', completedAt: 2 });
    const c = weekSet({ id: 'C', completedAt: 0 }); // an offline set landing later, with an earlier time
    expect(fluxNoteFingerprint([a, b])).toBe(fluxNoteFingerprint([b, a]));
    expect(fluxNoteFingerprint([a, b])).not.toBe(fluxNoteFingerprint([c, b]));
    expect(fluxNoteFingerprint([a, b])).not.toBe(fluxNoteFingerprint([a]));
    expect(fluxNoteFingerprint([a, b])).toMatch(/^2:[0-9a-f]+$/);
    expect(fluxNoteFingerprint([])).toMatch(/^0:/);
  });
});

describe('fluxNoteText', () => {
  const s = fluxWeekSummary(
    [weekSet({ avgPeakDeg: 44 }), weekSet({ avgPeakDeg: 53, completedAt: 2 })],
    '2026-11-02',
  );
  const line = fluxWeekLine(s);
  it('accepts a trimmed line within the cap whose numbers are all in the input', () => {
    expect(fluxNoteText('  Rotation twice,  44° to 53°. ', line, s)).toBe(
      'Rotation twice, 44° to 53°.',
    );
  });
  it('accepts a difference of two given numbers, and a dashed or plural form of a name', () => {
    expect(fluxNoteText('Rotation up 9 degrees over two sets.', line, s)).toBe(
      'Rotation up 9 degrees over two sets.',
    );
    const tucks = fluxWeekSummary(
      [
        weekSet({ exerciseId: 'chin-tuck', kind: 'holdAtTarget', avgPeakDeg: null }),
        weekSet({
          exerciseId: 'chin-tuck',
          kind: 'holdAtTarget',
          avgPeakDeg: null,
          completedAt: 2,
        }),
      ],
      '2026-11-02',
    );
    expect(fluxNoteText('Two chin-tuck sets.', fluxWeekLine(tucks), tucks)).toBe(
      'Two chin-tuck sets.',
    );
  });
  it('refuses a non-string, an empty, an over-long, a number the input lacks, or a note naming no exercise', () => {
    expect(fluxNoteText(null, line, s)).toBeNull();
    expect(fluxNoteText('   ', line, s)).toBeNull();
    expect(fluxNoteText('x'.repeat(141), line, s)).toBeNull();
    expect(fluxNoteText('Rotation up 12 degrees.', line, s)).toBeNull();
    expect(fluxNoteText('Two sets, 44° to 53°.', line, s)).toBeNull();
  });
});
