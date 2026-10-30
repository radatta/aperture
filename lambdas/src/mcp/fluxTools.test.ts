import { beforeEach, describe, expect, it } from 'vitest';
import { ulid, type ApiMethod, type RecordFluxSetInput } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// list_flux_sets / list_flux_exercises over the real handleRpc path (D52).
const U = 'local';
const now = () => Date.parse('2026-10-21T18:00:00Z');
let backend: BackendClient;
let ctx: ToolContext;

beforeEach(() => {
  const doc = new InMemoryDoc();
  backend = new BackendClient(new Repo(doc, liveWrites(doc), U), { userId: U, now });
  ctx = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(doc, { userId: U, method, args, now }),
    upload: async () => {},
    now,
  };
});

const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
};
const record = (over: Partial<RecordFluxSetInput>) =>
  backend.recordFluxSet({
    id: ulid(),
    day: '2026-10-20',
    exerciseId: 'cervical-rotation',
    kind: 'romReps',
    side: null,
    condition: null,
    count: 20,
    avgPeakDeg: 50,
    avgErrorDeg: null,
    rom: { pitch: 4, yaw: 100, roll: 5 },
    calibrated: true,
    delegate: 'GPU',
    durationSec: 240,
    completedAt: 1_000,
    repTaskId: null,
    stoppedEarly: false,
    planned: 10,
    ...over,
  });

interface SetsOut {
  sets: {
    exercise: string;
    side: string | null;
    metric: { value: number } | null;
    countedTowardRollRep: boolean;
    stoppedEarly: boolean;
    planned: number | null;
  }[];
  summary: { exerciseId: string; sets: number; first?: number; latest?: number }[];
  daySummary?: string;
  note: string;
}

describe('list_flux_sets', () => {
  it('resolves the exercise, the Right/Left side and the one number, with a per-exercise summary', async () => {
    await record({ day: '2026-10-19', completedAt: 1_000, avgPeakDeg: 46 });
    await record({ completedAt: 2_000, avgPeakDeg: 52, repTaskId: 'T1' });
    await record({
      exerciseId: 'scalene-stretch',
      kind: 'holdAtTarget',
      side: 'a',
      count: 2,
      avgPeakDeg: null,
      completedAt: 3_000,
    });
    const out = (await run('list_flux_sets')) as SetsOut;
    expect(out.sets.map((s) => [s.exercise, s.side, s.metric?.value])).toEqual([
      ['Scalene Stretch', 'left', 2], // scalene's Side A tilts left (D48)
      ['Neck Rotation', null, 52],
      ['Neck Rotation', null, 46],
    ]);
    expect(out.sets[1]?.countedTowardRollRep).toBe(true);
    expect(out.sets[1]).toMatchObject({ stoppedEarly: false, planned: 10 });
    expect(out.summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          exerciseId: 'cervical-rotation',
          sets: 2,
          first: 46,
          latest: 52,
        }),
      ]),
    );
    expect(out.note).toMatch(/not clinical/);
  });

  it('leaves a stopped set out of first → latest, and counts it (D55)', async () => {
    await record({ day: '2026-10-19', completedAt: 1_000, avgPeakDeg: 46 });
    await record({ completedAt: 2_000, avgPeakDeg: 52 });
    await record({ completedAt: 3_000, avgPeakDeg: 20, count: 1, stoppedEarly: true });
    const out = (await run('list_flux_sets')) as SetsOut;
    expect(out.sets[0]).toMatchObject({ stoppedEarly: true, planned: 10 });
    expect(out.summary).toEqual([
      expect.objectContaining({ sets: 3, stoppedEarly: 1, first: 46, latest: 52 }),
    ]);
  });

  it('filters by range and exercise, and says one day in a line', async () => {
    await record({ day: '2026-10-19', completedAt: 1_000 });
    await record({ completedAt: 2_000 });
    await record({
      exerciseId: 'upper-trap-stretch',
      kind: 'holdAtTarget',
      side: 'b',
      avgPeakDeg: null,
      completedAt: 3_000,
    });
    const day = (await run('list_flux_sets', { from: '2026-10-20', to: '2026-10-20' })) as SetsOut;
    expect(day.sets).toHaveLength(2);
    expect(day.daySummary).toBe('1 set rotation, 1 upper trap');
    const one = (await run('list_flux_sets', { exerciseId: 'upper-trap-stretch' })) as SetsOut;
    expect(one.sets.map((s) => s.side)).toEqual(['left']);
  });

  it('refuses half a range, a non-date, and an unknown exercise — naming list_flux_exercises', async () => {
    await expect(run('list_flux_sets', { from: '2026-10-20' })).rejects.toBeInstanceOf(
      RpcParamError,
    );
    await expect(run('list_flux_sets', { from: 'monday', to: '2026-10-20' })).rejects.toThrow(
      'ISO date',
    );
    await expect(run('list_flux_sets', { exerciseId: 'neck' })).rejects.toThrow(
      'list_flux_exercises',
    );
  });
});

describe('list_flux_exercises', () => {
  it('lists all 19, one-sided exactly for the three stretches, with their side names', async () => {
    const list = (await run('list_flux_exercises')) as {
      id: string;
      sided: boolean;
      sides?: object;
    }[];
    expect(list).toHaveLength(19);
    expect(list.filter((e) => e.sided).map((e) => e.id)).toEqual([
      'upper-trap-stretch',
      'levator-scapulae-stretch',
      'scalene-stretch',
    ]);
    expect(list.find((e) => e.id === 'scalene-stretch')?.sides).toEqual({ a: 'left', b: 'right' });
  });
});
