import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { IDS } from '../../identifiers.ts';
import { accountKind, powerSummary, readCosts, readMacStats, sumCosts } from './health.ts';

const T = Date.parse('2026-11-13T20:00:00Z');
const stats = (t: number, over: object = {}) =>
  JSON.stringify({
    v: 1,
    t: new Date(t).toISOString(),
    host: 'mac',
    memTotalMiB: 36864,
    mem: {
      freeMiB: 1124,
      activeMiB: 8192,
      inactiveMiB: 4096,
      wiredMiB: 3072,
      compressedMiB: 4096,
      usedMiB: 15360,
      freePct: 3,
      pressure: 'warn',
    },
    swap: { totalMiB: 2048, usedMiB: 1024 },
    load: [3.2, 2.7, 2.4],
    cpus: 12,
    vm: { pid: 512, comm: 'com.apple.Virtualization.VirtualMachine', rssMiB: 22528 },
    agentVersion: 'abc',
    ...over,
  });
const at = (text: string) => () => text;

describe('readMacStats', () => {
  it('fresh to 60 s, stale to 300 s, silent after', () => {
    expect(readMacStats('x', T, at(stats(T - 59000))).state).toBe('ok');
    expect(readMacStats('x', T, at(stats(T - 61000))).state).toBe('stale');
    expect(readMacStats('x', T, at(stats(T - 300000))).state).toBe('stale');
    expect(readMacStats('x', T, at(stats(T - 301000))).state).toBe('silent');
    expect(readMacStats('x', T, at(stats(T - 1000))).stats!.vm!.rssMiB).toBe(22528);
  });
  it('missing is "missing"; bad JSON or a bad field is "bad" with the reason', () => {
    expect(readMacStats(join(tmpdir(), 'no-such-mac-stats.json'), T)).toEqual({
      state: 'missing',
      at: null,
      error: null,
      stats: null,
    });
    expect(readMacStats('x', T, at('{oops'))).toMatchObject({
      state: 'bad',
      error: expect.stringMatching(/JSON/),
    });
    expect(readMacStats('x', T, at(stats(T, { memTotalMiB: 'lots' })))).toMatchObject({
      state: 'bad',
      error: 'memTotalMiB is not a number',
    });
    expect(readMacStats('x', T, at(stats(T, { v: 2 })))).toMatchObject({
      state: 'bad',
      error: 'v is 2, want 1',
    });
  });
  it('a null vm stays null', () => {
    expect(readMacStats('x', T, at(stats(T, { vm: null }))).stats!.vm).toBeNull();
  });
});

const ce = (days: [string, string, string][]) =>
  JSON.stringify({
    ResultsByTime: days.map(([day, acct, amt]) => ({
      TimePeriod: { Start: day, End: day },
      Groups: [
        { Keys: [acct, 'AWS Lambda'], Metrics: { UnblendedCost: { Amount: amt, Unit: 'USD' } } },
      ],
    })),
  });

describe('AWS costs (costs-daily.json)', () => {
  it('labels dev by its id and prod by its id’s hash, anything else other', () => {
    const fake = '444455556666';
    const ids = {
      ...IDS,
      aws: { ...IDS.aws, prodAccountSha256: createHash('sha256').update(fake).digest('hex') },
    };
    expect([
      accountKind(IDS.aws.devAccountId, ids),
      accountKind(fake, ids),
      accountKind('111111111111', ids),
    ]).toEqual(['dev', 'prod', 'other']);
  });

  it('sums this month only, split dev / prod / other, with the last day it covers', () => {
    const c = sumCosts(
      ce([
        ['2026-10-31', '111111111111', '5'],
        ['2026-11-01', '111111111111', '0.25'],
        ['2026-11-02', '222222222222', '0.10'],
        ['2026-11-12', '333333333333', '0.05'],
      ]),
      '2026-11',
      (id) => ({ '111111111111': 'dev', '222222222222': 'prod' })[id] ?? 'other',
    );
    expect(c.total).toBeCloseTo(0.4);
    expect(c.byAccount).toEqual({ dev: 0.25, prod: 0.1, other: 0.05 });
    expect(c.through).toBe('2026-11-12');
  });
  it('reads a BOM-prefixed file; dates "as of" by mtime and goes stale past 3 days', () => {
    const d = mkdtempSync(join(tmpdir(), 'costs-'));
    const p = join(d, 'costs-daily.json');
    writeFileSync(p, '﻿' + ce([['2026-11-01', '111111111111', '1']]));
    utimesSync(p, (T - 3600e3) / 1000, (T - 3600e3) / 1000);
    expect(readCosts(p, T, '2026-11')).toMatchObject({ state: 'ok', at: T - 3600e3, total: 1 });
    utimesSync(p, (T - 4 * 86400e3) / 1000, (T - 4 * 86400e3) / 1000);
    expect(readCosts(p, T, '2026-11').state).toBe('stale');
    expect(readCosts(join(d, 'none.json'), T, '2026-11').state).toBe('missing');
    writeFileSync(p, '{"x":1}');
    expect(readCosts(p, T, '2026-11')).toMatchObject({ state: 'bad', error: 'no ResultsByTime' });
  });
});

describe('round 1 health fixes', () => {
  it('a Mac time over a minute ahead is bad, not fresh', () => {
    expect(readMacStats('x', T, at(stats(T + 120000)))).toMatchObject({
      state: 'bad',
      error: 't is 120 s in the future',
    });
    expect(readMacStats('x', T, at(stats(T + 30000))).state).toBe('ok');
  });
  it('an unreadable swap is null, never 0 of 0', () => {
    expect(readMacStats('x', T, at(stats(T, { swap: null }))).stats!.swap).toBeNull();
    expect(readMacStats('x', T, at(stats(T, { swap: { totalMiB: 'x' } }))).stats!.swap).toBeNull();
  });
  it('a pull with no rows for this month is stale with a reason, not $0.00 ok', () => {
    const d = mkdtempSync(join(tmpdir(), 'costs-'));
    const p = join(d, 'costs-daily.json');
    writeFileSync(p, ce([['2026-10-31', '111111111111', '5']]));
    expect(readCosts(p, Date.now(), '2026-11')).toMatchObject({
      state: 'stale',
      total: 0,
      error: 'no rows for 2026-11: re-pull',
    });
  });
});

// F120: the battery / Low Power Mode / thermal line (docs/ops/TOWER.md → HEALTH)
describe('powerSummary', () => {
  const calm = {
    source: 'ac',
    batteryPct: 82,
    state: 'charging',
    remainingMin: 40,
    lowPowerMode: false,
    thermal: {
      warningLevel: null,
      performanceWarningLevel: null,
      cpuSpeedLimit: null,
      cpuSchedulerLimit: null,
      cpuAvailableCpus: null,
    },
  };
  const sum = (power: object | undefined, t = T) =>
    powerSummary(readMacStats('x', T, at(stats(t, power === undefined ? {} : { power }))));
  const thermal = (o: object) => ({ ...calm, thermal: { ...calm.thermal, ...o } });

  it("an old agent's JSON (no power key) is unknown, never red", () => {
    expect(sum(undefined)).toEqual({ known: false, line: '', alerts: [], advice: null });
  });

  it('a silent, missing or bad read is unknown', () => {
    expect(sum(calm, T - 400_000).known).toBe(false);
    expect(powerSummary(readMacStats('x', T, at('{oops'))).known).toBe(false);
  });

  it('calm on AC: one line, no alerts, no advice', () => {
    expect(sum(calm)).toEqual({
      known: true,
      line: 'AC 82% charging (0:40 to full) · no thermal limit',
      alerts: [],
      advice: null,
    });
  });

  it('red on Low Power Mode, on battery under 20%, a limit under 100, a recorded warning level', () => {
    expect(sum({ ...calm, lowPowerMode: true }).alerts).toEqual(['Low Power Mode']);
    const low = sum({
      ...calm,
      source: 'battery',
      batteryPct: 12,
      state: 'discharging',
      remainingMin: 50,
    });
    expect(low.alerts).toEqual(['battery 12%']);
    expect(low.line).toBe('battery 12% discharging (0:50 left) · no thermal limit');
    expect(sum(thermal({ cpuSpeedLimit: 80 })).alerts).toEqual(['CPU speed 80%']);
    expect(sum(thermal({ cpuSchedulerLimit: 50 })).alerts).toEqual(['scheduler 50%']);
    expect(sum(thermal({ warningLevel: 2 })).line).toMatch(/limit: thermal warning 2$/);
    expect(sum(thermal({ performanceWarningLevel: 'recorded' })).alerts).toEqual([
      'performance warning recorded',
    ]);
  });

  it('not red: 20% on battery, 12% on AC, limits at 100, a warning level of 0', () => {
    expect(sum({ ...calm, source: 'battery', batteryPct: 20 }).alerts).toEqual([]);
    expect(sum({ ...calm, batteryPct: 12 }).alerts).toEqual([]);
    expect(
      sum(thermal({ cpuSpeedLimit: 100, cpuSchedulerLimit: 100, warningLevel: 0 })).alerts,
    ).toEqual([]);
  });

  it('an unreadable Low Power Mode says so on the line (never a silent "off")', () => {
    expect(sum({ ...calm, lowPowerMode: null }).line).toBe(
      'AC 82% charging (0:40 to full) · Low Power Mode unknown · no thermal limit',
    );
  });

  it('advice: ≤ 3 lanes on battery under 30% or with Low Power Mode on', () => {
    expect(sum({ ...calm, source: 'battery', batteryPct: 29 }).advice).toMatch(/^≤ 3 lanes/);
    expect(sum({ ...calm, source: 'battery', batteryPct: 30 }).advice).toBeNull();
    expect(sum({ ...calm, batteryPct: 10 }).advice).toBeNull(); // on AC
    expect(sum({ ...calm, lowPowerMode: true }).advice).toMatch(/^≤ 3 lanes/);
  });

  it('pmset gave nothing: all null is known, says thermal unknown; wrong types read as null', () => {
    const none = {
      source: null,
      batteryPct: null,
      state: null,
      remainingMin: null,
      lowPowerMode: null,
      thermal: null,
    };
    expect(sum(none)).toEqual({ known: true, line: 'thermal unknown', alerts: [], advice: null });
    expect(sum({ ...calm, batteryPct: '82', lowPowerMode: 'yes', source: 'mains' }).line).toBe(
      'no thermal limit',
    );
  });
});
