import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  budgetLine,
  jobBudget,
  laneBudget,
  lanesNow,
  lastSample,
  parseBudget,
  powerFactor,
  unitKey,
} from './budget.ts';
import { barriers, rollup } from './rollup.ts';
import { parseLimits, staleness } from './limits.ts';
import { compactJob } from './tower/history.ts';
import type { MacRead, Power } from './tower/health.ts';

const shipped = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../board/limits.json', import.meta.url)), 'utf8'),
);
const b = parseBudget(shipped.budget)!;
const T = Date.parse('2026-11-18T12:00:00Z');

const power = (p: Partial<Power>): Power => ({
  source: 'ac',
  batteryPct: 90,
  state: 'charging',
  remainingMin: null,
  lowPowerMode: false,
  thermal: null,
  ...p,
});
const read = (p: Power | undefined, state: MacRead['state'] = 'ok'): MacRead => ({
  state,
  at: T,
  error: null,
  stats: p === undefined ? null : ({ power: p } as MacRead['stats']),
});

describe('parseBudget', () => {
  it('parses the shipped block: the spec’s numbers, log-only', () => {
    expect(b).toMatchObject({
      enforce: false,
      base: 0.5,
      lightWorking: 0.3,
      jobUnits: 6.5,
      laneUnits: 4.5,
    });
    expect(b.units).toMatchObject({
      test: 3,
      'test-fast': 2.5,
      'ui-local': 1.5,
      'ui-dev': 0.5,
      dev: 0.75,
    });
    expect(b.phases).toMatchObject({
      plan: 0.1,
      build: 0.4,
      gate: 1,
      review: 0.7,
      local: 1.4,
      parked: 0,
    });
    expect(b).toMatchObject({ sessionsMax: 14, macSimSlots: 1 });
  });

  it('is null for anything missing or malformed, never a throw', () => {
    const with_ = (patch: object) => parseBudget({ ...shipped.budget, ...patch });
    expect(parseBudget(undefined)).toBeNull();
    expect(parseBudget('x')).toBeNull();
    expect(with_({ jobUnits: '6.5' })).toBeNull();
    expect(with_({ laneUnits: 0 })).toBeNull();
    expect(with_({ base: -1 })).toBeNull();
    expect(with_({ enforce: 'no' })).toBeNull();
    expect(with_({ units: { ...shipped.budget.units, 'ui-dev': undefined } })).toBeNull();
    expect(with_({ phases: { ...shipped.budget.phases, review: null } })).toBeNull();
    expect(with_({ power: { ...shipped.budget.power, slow: 0.5 } })).toBeNull();
  });

  it('parseLimits ignores the block, even a broken one (a throw there is a fail-open grant)', () => {
    expect(() => parseLimits({ ...shipped, budget: 'garbage' })).not.toThrow();
  });
});

describe('powerFactor', () => {
  const pw = b.power;
  it.each([
    ['on AC', power({}), 1, 'ac'],
    ['on battery', power({ source: 'battery', state: 'discharging' }), 1.3, 'battery'],
    ['Low Power Mode on AC', power({ lowPowerMode: true }), 1.3, 'lpm'],
    ['a charge under the line, even on AC', power({ batteryPct: 29 }), 1.3, 'low'],
    ['a charge at the line', power({ batteryPct: 30 }), 1, 'ac'],
    [
      'a CPU speed limit',
      power({
        thermal: {
          warningLevel: null,
          performanceWarningLevel: null,
          cpuSpeedLimit: 90,
          cpuSchedulerLimit: null,
          cpuAvailableCpus: null,
        },
      }),
      1.5,
      'thermal',
    ],
    [
      'a CPU scheduler limit',
      power({
        thermal: {
          warningLevel: null,
          performanceWarningLevel: null,
          cpuSpeedLimit: null,
          cpuSchedulerLimit: 50,
          cpuAvailableCpus: null,
        },
      }),
      1.5,
      'thermal',
    ],
    [
      'thermal wins over battery',
      power({
        source: 'battery',
        thermal: {
          warningLevel: null,
          performanceWarningLevel: null,
          cpuSpeedLimit: 80,
          cpuSchedulerLimit: null,
          cpuAvailableCpus: null,
        },
      }),
      1.5,
      'thermal',
    ],
  ])('%s', (_n, p, k, why) => expect(powerFactor(read(p), pw)).toEqual({ k, why }));

  it('a read 1–5 min old still counts; silent, missing, bad or no power is the slow guess', () => {
    expect(powerFactor(read(power({}), 'stale'), pw)).toEqual({ k: 1, why: 'ac' });
    for (const s of ['silent', 'missing', 'bad'] as const)
      expect(powerFactor(read(power({}), s), pw)).toEqual({ k: 1.3, why: 'unknown' });
    expect(
      powerFactor({ state: 'ok', at: T, error: null, stats: {} as MacRead['stats'] }, pw),
    ).toEqual({
      k: 1.3,
      why: 'unknown',
    });
  });
});

describe('unitKey', () => {
  it.each([
    ['test', 'pnpm gate:fast', 'test'],
    ['test-fast', 'pnpm gate:fast', 'test-fast'],
    ['typecheck', 'pnpm typecheck', 'typecheck'],
    ['dev', 'pnpm dev', 'dev'],
    ['warm', 'bash scripts/board/warm.sh --steps', 'warm'], // lanes start's cache warm: its own weight, not other
    ['ui', 'pnpm devcheck:local --tier full --feature x', 'ui-local'],
    ['ui', 'pnpm devcheck --local --tier full', 'ui-local'],
    ['ui', 'pnpm devcheck --tier full --feature x', 'ui-dev'],
    ['ui', 'node localNotes/shot.mjs', 'ui-capture'],
    ['other', 'make', 'other'],
    ['gate-wide', 'x', 'other'],
  ])('%s %s → %s', (cls, cmd, as) => expect(unitKey(cls, cmd)).toEqual({ as }));

  it('a ui slot with no command (an older lease.sh) counts as the heaviest ui, marked a guess', () =>
    expect(unitKey('ui', null)).toEqual({ as: 'ui-local', guess: true }));
});

describe('jobBudget', () => {
  const sample = (sessions: { pid: number; state: string }[], ageSec = 10) => ({
    t: new Date(T - ageSec * 1000).toISOString(),
    sessions,
    cg: { psiCpuSome10: 22, cpuCores: 5.5, anonMiB: 8000 },
  });
  const slot = (pid: number, cls: string, cmd?: string) => ({ pid, class: cls, cmd });

  it('admits at the line: a second wide gate on an otherwise quiet box (2 × 3.0 + 0.5 = 6.5)', () => {
    const j = jobBudget(b, [slot(9, 'test')], sample([]), T, 1, { class: 'test' }, 1);
    expect(j.committed.total).toBe(3.5);
    expect(j.would).toBe('admit');
  });

  it('waits just over: one light working lane tips it', () => {
    const j = jobBudget(
      b,
      [slot(9, 'test')],
      sample([{ pid: 5, state: 'working' }]),
      T,
      1,
      { class: 'test' },
      1,
    );
    expect(j.committed).toMatchObject({
      light: 0.3,
      total: 3.8,
      lightWorking: 1,
      lightKnown: true,
    });
    expect(j.would).toBe('wait');
  });

  it('counts neither the requester nor a slot holder as a light lane, nor an idle one', () => {
    const s = sample([
      { pid: 1, state: 'working' },
      { pid: 9, state: 'working' },
      { pid: 5, state: 'idle' },
      { pid: 6, state: 'working' },
    ]);
    expect(
      jobBudget(b, [slot(9, 'lint')], s, T, 1, { class: 'lint' }, 1).committed.lightWorking,
    ).toBe(1);
  });

  it('no sample, or one past sampleFreshSec: light 0, said so, and no cg', () => {
    for (const s of [null, sample([{ pid: 5, state: 'working' }], b.sampleFreshSec + 1)]) {
      const j = jobBudget(b, [], s, T, 1, { class: 'lint' }, 1);
      expect(j.committed).toMatchObject({ light: 0, lightKnown: false });
      expect(j.cg).toBeNull();
    }
  });

  it('scales by k: a wide gate beside a narrow one fits on AC, not on battery', () => {
    const at = (k: number) =>
      jobBudget(b, [slot(9, 'test-fast')], sample([]), T, 1, { class: 'test' }, k);
    expect(at(1)).toMatchObject({ allowed: 6.5, would: 'admit' });
    expect(at(1.3)).toMatchObject({ allowed: 5, would: 'wait' });
  });

  it('splits held ui slots by their command, and an unknown class counts as other', () => {
    const j = jobBudget(
      b,
      [
        slot(2, 'ui', 'pnpm devcheck:local'),
        slot(3, 'ui', 'pnpm devcheck --tier full'),
        slot(4, 'ui'),
      ],
      null,
      T,
      1,
      { class: 'weird' },
      1,
    );
    expect(j.committed.held.map((h) => [h.as, h.units])).toEqual([
      ['ui-local', 1.5],
      ['ui-dev', 0.5],
      ['ui-local', 1.5],
    ]);
    expect(j.committed.held[2]).toMatchObject({ guess: true });
    expect(j.unit).toEqual({ as: 'other', units: 1 });
  });
});

describe('laneBudget', () => {
  const lanes = (...phases: (string | null)[]) =>
    phases.map((phase, i) => ({ branch: `l${i}`, phase }));

  it('the report’s mixes: 4 build + 2 review + 1 gate is at the line once the new lane is in', () => {
    // 0.5 + 1.6 + 1.4 + 1.0 = 4.5, then the new lane's 0.4: over
    const l = laneBudget(
      b,
      lanes('build', 'build', 'build', 'build', 'review', 'review', 'gate'),
      8,
      1,
    );
    expect(l.units).toEqual({ base: 0.5, lanes: 4, new: 0.4, total: 4.9 });
    expect(l).toMatchObject({ would: 'refuse', wouldWhy: ['units'] });
    expect(
      laneBudget(b, lanes('build', 'build', 'build', 'review', 'review', 'gate'), 8, 1).would,
    ).toBe('admit');
  });

  it('no lane file and an unknown phase count as build; parked is free', () => {
    const l = laneBudget(b, lanes(null, 'weird', 'parked'), 3, 1);
    expect(l.lanes.map((x) => x.units)).toEqual([0.4, 0.4, 0]);
  });

  it('the sessions ceiling binds alone, the hub included', () => {
    expect(laneBudget(b, lanes('pr'), 14, 1)).toMatchObject({
      would: 'refuse',
      wouldWhy: ['sessions'],
    });
    expect(laneBudget(b, lanes('pr'), 13, 1)).toMatchObject({ would: 'admit', wouldWhy: [] });
  });

  it('k 1.3 makes the lane budget 3.5', () => {
    expect(laneBudget(b, lanes('gate', 'local'), 5, 1.3)).toMatchObject({
      allowed: 3.46,
      would: 'admit',
    });
    expect(laneBudget(b, lanes('gate', 'local', 'review'), 5, 1.3)).toMatchObject({
      would: 'refuse',
    });
  });

  it('carries no Simulator count yet', () => expect(laneBudget(b, [], 1, 1).sim).toBeNull());
});

describe('budgetLine and lastSample', () => {
  it('prints the scaled limits and k', () => {
    expect(budgetLine(b, { jobs: 4, lanes: 3.25, sessions: 12 }, { k: 1, why: 'ac' })).toBe(
      'budget (log-only): jobs 4/6.5 · lanes 3.25/4.5 · sessions 12/14 · k 1 ac',
    );
    expect(
      budgetLine(
        b,
        { jobs: null, lanes: lanesNow(b, []), sessions: 2 },
        { k: 1.3, why: 'battery' },
      ),
    ).toBe('budget (log-only): lanes 0.5/3.46 · sessions 2/14 · k 1.3 battery');
  });

  it('takes the last whole line of a tail, skipping a torn one', () => {
    expect(lastSample('{"t":"a"}\n{"t":"b"}\n{"t":"c')).toEqual({ t: 'b' });
    expect(lastSample('xx"}\n')).toBeNull();
    expect(lastSample('')).toBeNull();
  });
});

// The numeric readers of events-*.jsonl run with and without budget events. The rest filter on `kind` before reading a
// field, checked by reading (round 1): tower source.ts's lease feed, usage questions.ts (`kind === 'job'`), bot
// lock-events.ts (`devlock`), measure/matrix.sh (`kind == "job"`).
describe('a budget event changes none of the numeric events readers', () => {
  const job = {
    v: 1,
    t: '2026-11-18T11:00:00Z',
    kind: 'job',
    class: 'typecheck',
    label: 'typecheck',
    exit: 0,
    wallSec: 10,
    verdict: 'clean',
    peak: { dPids: 10, dAnonMiB: 500, pids: 400, anonMiB: 3000, cores: 1 },
  };
  const lease = {
    v: 1,
    t: '2026-11-18T11:05:00Z',
    kind: 'lease',
    lease: 'heavy',
    action: 'waited',
    class: 'test',
    reason: 'cap',
    waitedSec: 30,
    holders: [],
    mix: null,
  };
  const budgetJob = {
    v: 1,
    t: '2026-11-18T11:10:00Z',
    kind: 'budget',
    scope: 'job',
    class: 'test',
    label: 'gate:wide',
    unit: { as: 'test', units: 3 },
    would: 'wait',
    actual: { verdict: 'grant', wait: false },
  };
  const budgetLane = {
    v: 1,
    t: '2026-11-18T11:11:00Z',
    kind: 'budget',
    scope: 'lane',
    branch: 'x',
    would: 'admit',
  };
  const since = new Date('2026-11-17T00:00:00Z');
  const now = new Date('2026-11-18T12:00:00Z');
  const base = [job, lease];
  const all = [job, lease, budgetJob, budgetLane];

  it('rollup, barriers and staleness read the same with and without them', () => {
    expect(rollup([], all as never, since, now)).toEqual(rollup([], base as never, since, now));
    expect(barriers(all, since, now)).toEqual(barriers(base, since, now));
    const l = parseLimits(shipped);
    const live = { pidsMax: 4096, highBytes: 18 * 1073741824 };
    expect(staleness(l, live, all as never, now)).toEqual(staleness(l, live, base as never, now));
  });

  it('the tower’s job reader drops them', () => {
    expect(compactJob(budgetJob)).toBeNull();
    expect(compactJob(budgetLane)).toBeNull();
  });
});
