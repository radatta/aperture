import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { p95, parseLimits, staleness, thresholds, type Limits } from './limits.ts';

const shipped = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../board/limits.json', import.meta.url)), 'utf8'),
);
const GiB = 1073741824;
const now = new Date('2026-10-14T12:00:00Z');

const limits = (patch: Partial<Limits> = {}): Limits => ({
  ...parseLimits(structuredClone(shipped)),
  ...patch,
});

describe('limits.json', () => {
  it('ships valid, nudge-only, and unmeasured', () => {
    const l = parseLimits(shipped);
    expect(l.enforce).toBe(false);
    expect(l.measuredLimits).toBeNull();
    expect(Object.keys(l.classes)).toEqual(
      expect.arrayContaining(['test', 'ui', 'typecheck', 'lint', 'dev', 'build']),
    );
  });

  it('rejects broken fractions', () => {
    const bad = (container: object) => () =>
      parseLimits({ ...shipped, container: { ...shipped.container, ...container } });
    expect(bad({ pidsSoftFrac: 0 })).toThrow(/fractions/);
    expect(bad({ anonHardFrac: 1.5 })).toThrow(/fractions/);
    expect(bad({ pidsSoftFrac: 0.95, pidsHardFrac: 0.9 })).toThrow(/soft fraction/);
    expect(() => parseLimits({ ...shipped, enforce: 'yes' })).toThrow(/enforce/);
  });
});

describe('thresholds', () => {
  it('scales with the live limits — today and before the upgrade', () => {
    expect(thresholds(limits(), { pidsMax: 4096, highBytes: 18 * GiB })).toEqual({
      pidsSoft: 3276,
      pidsHard: 3768,
      anonSoft: Math.floor(0.6 * 18 * GiB),
      anonHard: Math.floor(0.8 * 18 * GiB),
    });
    expect(thresholds(limits(), { pidsMax: 2048, highBytes: 12 * GiB })).toMatchObject({
      pidsSoft: 1638,
      pidsHard: 1884,
    });
  });
});

describe('staleness', () => {
  const live = { pidsMax: 4096, highBytes: 18 * GiB };
  const ev = (
    cls: string,
    dPids: number,
    dAnonMiB: number,
    t = '2026-10-13T12:00:00Z',
    guard = false,
  ) => ({
    class: cls,
    t,
    guard,
    peak: { dPids, dAnonMiB },
  });

  it('flags placeholders and changed limits', () => {
    expect(staleness(limits(), live, [], now)).toEqual([expect.stringMatching(/placeholders/)]);
    const measured = limits({
      measuredAt: '2026-10-14',
      measuredLimits: { pidsMax: 4096, highMiB: 18432 },
    });
    expect(staleness(measured, live, [], now)).toEqual([]);
    expect(staleness(measured, { pidsMax: 8192, highBytes: 18 * GiB }, [], now)).toEqual([
      expect.stringMatching(/measured at 4096 pids \/ 18432 MiB, running at 8192/),
    ]);
  });

  it('flags a class whose real p95 outgrew its budget, ignoring guarded and old runs', () => {
    const measured = limits({
      measuredAt: '2026-10-14',
      measuredLimits: { pidsMax: 4096, highMiB: 18432 },
    });
    const runs = [ev('test', 300, 4500), ev('test', 310, 4400), ev('test', 290, 4600)];
    expect(staleness(measured, live, runs, now)).toEqual([
      expect.stringMatching(/class test: p95 Δanon 4600 MiB vs 3300/),
    ]);
    const guarded = runs.map((r) => ({ ...r, guard: true }));
    const old = runs.map((r) => ({ ...r, t: '2026-09-01T00:00:00Z' }));
    expect(staleness(measured, live, [...guarded, ...old], now)).toEqual([]);
    expect(staleness(measured, live, runs.slice(0, 2), now)).toEqual([]); // < 3 runs: not enough to judge
  });

  it('computes p95 as a nearest-rank max over small samples', () => {
    expect(p95([])).toBe(0);
    expect(p95([5, 1, 3])).toBe(5);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
});
