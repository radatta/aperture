import { describe, it, expect } from 'vitest';
import { formatReport, rollup, slope, stat, type JobEvent, type Sample } from './rollup.ts';

const since = new Date('2026-10-13T00:00:00Z');

const sample = (
  t: string,
  working: number,
  idle: number,
  heavy: number,
  anonMiB: number,
  pids = 260,
): Sample => ({
  t,
  cg: { anonMiB, pids, cpuCores: working * 0.5 },
  sessions: [
    ...Array.from({ length: idle }, () => ({ state: 'idle', rssMiB: 300, thr: 15 })),
    ...Array.from({ length: working }, () => ({ state: 'working', rssMiB: 500, thr: 25 })),
  ],
  mix: { working, idle, heavy },
  gapSec: null,
});

const job = (cls: string, dAnonMiB: number, extra: Partial<JobEvent> = {}): JobEvent => ({
  kind: 'job',
  t: '2026-10-13T12:00:00Z',
  class: cls,
  wallSec: 30,
  verdict: 'clean',
  peak: { dPids: 200, dAnonMiB, pids: 460, anonMiB: 4000 },
  ...extra,
});

describe('rollup', () => {
  const samples = [
    sample('2026-10-13T10:00:00Z', 0, 5, 0, 1800),
    sample('2026-10-13T10:00:30Z', 1, 5, 0, 2100),
    sample('2026-10-13T10:01:00Z', 1, 5, 1, 5200, 480),
    sample('2026-10-13T10:01:30Z', 0, 6, 0, 2100),
    { ...sample('2026-10-13T10:05:00Z', 0, 5, 0, 1800), gapSec: 180 },
    sample('2026-10-12T10:00:00Z', 5, 0, 0, 9999), // before the window
  ];
  const events = [
    job('test', 3000),
    job('test', 3400, { verdict: 'throttled' }),
    job('test', 9000, { guard: true }), // load test — excluded
    { kind: 'lease', t: '2026-10-13T12:00:00Z' } as unknown as JobEvent, // not a job
    job('typecheck', 900),
  ];
  const r = rollup(samples, events, since);

  it('buckets ticks by mix, most common first, inside the window', () => {
    expect(r.ticks).toBe(5);
    expect(r.gaps).toBe(1);
    expect(r.mixes.map((m) => [m.mix, m.ticks])).toEqual([
      ['0w 5i 0h', 2],
      ['1w 5i 0h', 1],
      ['1w 5i 1h', 1],
      ['0w 6i 0h', 1],
    ]);
    expect(r.mixes.find((m) => m.mix === '1w 5i 1h')?.anonMiB.max).toBe(5200);
  });

  it('measures the idle session directly and estimates the per-session cost on heavy-free ticks', () => {
    expect(r.idleSession).toMatchObject({ rssMiB: { median: 300 }, thr: { median: 15 } });
    expect(r.perSessionAnonMiB).toBe(300); // 5 sessions ≈ 1800, 6 ≈ 2100
  });

  it('summarises real jobs per class, excluding load-test and lease events', () => {
    expect(r.jobs).toEqual([
      expect.objectContaining({
        class: 'test',
        runs: 2,
        notClean: 1,
        dAnonMiB: { median: 3000, p95: 3400, max: 3400 },
      }),
      expect.objectContaining({ class: 'typecheck', runs: 1 }),
    ]);
  });

  it('formats a readable report', () => {
    const text = formatReport(r);
    expect(text).toMatch(/5 ticks, 1 gaps/);
    expect(text).toMatch(/0w 5i 0h\s+2 ticks · anon 1800 MiB/);
    expect(text).toMatch(/each extra session adds ~300 MiB anon/);
    expect(text).toMatch(/test\s+2 runs · Δanon 3000 MiB \/ 3400 MiB \/ 3400 MiB .* · 1 not clean/);
  });
});

describe('stat and slope', () => {
  it('computes nearest-rank stats', () => {
    expect(stat([])).toEqual({ median: 0, p95: 0, max: 0 });
    expect(stat([3, 1, 2])).toEqual({ median: 2, p95: 3, max: 3 });
  });

  it('returns null when the session count never varied', () => {
    expect(slope([5, 5, 5], [1, 2, 3])).toBeNull();
    expect(slope([1], [1])).toBeNull();
    expect(slope([1, 2, 3], [10, 20, 30])).toBe(10);
  });
});
