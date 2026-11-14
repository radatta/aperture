import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCosts, readMacStats, sumCosts } from './health.ts';

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
  it('sums this month only, split dev / prod / other, with the last day it covers', () => {
    const c = sumCosts(
      ce([
        ['2026-10-31', '618015769091', '5'],
        ['2026-11-01', '618015769091', '0.25'],
        ['2026-11-02', '594060113104', '0.10'],
        ['2026-11-12', '111111111111', '0.05'],
      ]),
      '2026-11',
    );
    expect(c.total).toBeCloseTo(0.4);
    expect(c.byAccount).toEqual({ dev: 0.25, prod: 0.1, other: 0.05 });
    expect(c.through).toBe('2026-11-12');
  });
  it('reads a BOM-prefixed file; dates "as of" by mtime and goes stale past 3 days', () => {
    const d = mkdtempSync(join(tmpdir(), 'costs-'));
    const p = join(d, 'costs-daily.json');
    writeFileSync(p, '﻿' + ce([['2026-11-01', '618015769091', '1']]));
    utimesSync(p, (T - 3600e3) / 1000, (T - 3600e3) / 1000);
    expect(readCosts(p, T, '2026-11')).toMatchObject({ state: 'ok', at: T - 3600e3, total: 1 });
    utimesSync(p, (T - 4 * 86400e3) / 1000, (T - 4 * 86400e3) / 1000);
    expect(readCosts(p, T, '2026-11').state).toBe('stale');
    expect(readCosts(join(d, 'none.json'), T, '2026-11').state).toBe('missing');
    writeFileSync(p, '{"x":1}');
    expect(readCosts(p, T, '2026-11')).toMatchObject({ state: 'bad', error: 'no ResultsByTime' });
  });
});
