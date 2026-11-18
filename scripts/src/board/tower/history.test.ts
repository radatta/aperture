import { describe, expect, it } from 'vitest';
import {
  CARRY_MS,
  bucket,
  compactJob,
  compactSample,
  failed,
  failuresByConcurrency,
  ticks,
} from './history.ts';
import type { Job, Point } from './model.ts';
import type { Run } from './ledger.ts';

const T0 = Date.parse('2026-11-08T05:00:00Z');
const pt = (sec: number, v: Partial<Point> = {}): Point => ({
  t: T0 + sec * 1000,
  anon: 4000,
  pids: 400,
  cpu: 1,
  heavy: 0,
  working: 1,
  names: ['a'],
  ...v,
});
const job = (
  endSec: number,
  wallSec: number,
  cls = 'test',
  exit: number | null = 0,
  x: Partial<Job> = {},
): Job => ({
  t: T0 + endSec * 1000,
  start: T0 + (endSec - wallSec) * 1000,
  cls,
  label: cls,
  name: 'a',
  branch: null,
  exit,
  signal: null,
  wallSec,
  verdict: 'clean',
  excluded: false,
  ...x,
});

describe('compact', () => {
  it('keeps what the charts need from a sample', () => {
    const p = compactSample({
      t: '2026-11-08T05:00:00Z',
      cg: { anonMiB: 4860, pids: 603, cpuCores: 0.91 },
      mix: { working: 2, idle: 9, heavy: 1 },
      sessions: [
        { name: 'a', state: 'working' },
        { name: 'b', state: 'idle' },
      ],
      gapSec: 120,
    });
    expect(p).toEqual({
      t: T0,
      anon: 4860,
      pids: 603,
      cpu: 0.91,
      heavy: 1,
      working: 2,
      names: ['a'],
    });
    expect(compactSample({ t: 'nope', cg: {} })).toBeNull();
  });

  it('a bad cpu tick is unknown, and stray sessions or text are survived', () => {
    const at = '2026-11-08T05:38:53Z';
    expect(compactSample({ t: at, cg: { cpuCores: 62763.68 } }, 18)!.cpu).toBeNull(); // the real 05:38:53Z tick
    expect(compactSample({ t: at, cg: { cpuCores: null } })!.cpu).toBeNull(); // the fixed sampler's null
    expect(compactSample({ t: at, cg: { cpuCores: 8.4 } }, 18)!.cpu).toBe(8.4);
    const p = compactSample({
      t: at,
      cg: {},
      sessions: [null, { name: 'a\x1b[2Jb\nc', state: 'working' }],
    });
    expect(p!.names).toEqual(['a[2Jbc']);
    expect(compactSample({ t: at, cg: {}, sessions: 'x' })!.names).toEqual([]);
  });

  it('turns a job event into an interval, marking load tests and guards', () => {
    const j = compactJob({
      kind: 'job',
      t: '2026-11-08T05:01:00Z',
      class: 'test',
      label: 'test',
      name: 'a',
      exit: 1,
      wallSec: 60,
      loadTest: true,
    });
    expect(j).toMatchObject({ t: T0 + 60000, start: T0, cls: 'test', exit: 1, excluded: true });
    expect(compactJob({ kind: 'lease', t: '2026-11-08T05:01:00Z' })).toBeNull();
  });

  it('counts red tests and container kills as failures, not interrupts', () => {
    expect([0, 1, 130, 134, 137, 143, null].map((e) => failed(job(1, 1, 'test', e)))).toEqual([
      false,
      true,
      false,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('bucket', () => {
  it('takes each bucket max and leaves a real gap empty', () => {
    const pts = [pt(0, { cpu: 1 }), pt(10, { cpu: 3 }), pt(30, { cpu: 2 }), pt(400, { cpu: 5 })];
    const b = bucket(pts, T0, T0 + 600 * 1000, 10); // 60 s buckets
    expect(bucket([pt(0, { cpu: null, pids: 9 })], T0, T0 + 60000, 1)[0]).toMatchObject({
      cpu: null,
      pids: 9,
    });
    expect(b[0]!.cpu).toBe(3);
    expect(b[0]!.last?.cpu).toBe(2);
    expect(b[1]!.cpu).toBe(2); // carried: within CARRY_MS of the 30 s tick
    expect(b[2]!.cpu).toBeNull(); // 120 s after the last tick: a gap
    expect(b[6]!.cpu).toBe(5);
    expect(b).toHaveLength(10);
  });

  it('carries the previous tick into buckets narrower than the sampler cadence', () => {
    const pts = [0, 30, 60, 90].map((s) => pt(s, { pids: 400 + s }));
    const b = bucket(pts, T0, T0 + 120 * 1000, 12); // 10 s buckets, ticks every 30 s
    expect(b.every((x) => x.pids !== null)).toBe(true);
    expect(b[4]!.pids).toBe(430);
    expect(b[4]!.src?.t).toBe(T0 + 30000);
    expect(CARRY_MS).toBeGreaterThan(60000);
  });

  it('uses a tick before the window to fill its first buckets', () => {
    const b = bucket([pt(-20, { anon: 7000 })], T0, T0 + 60000, 6);
    expect(b[0]!.anon).toBe(7000);
  });
});

describe('ticks', () => {
  const runs: Run[] = [
    { run: 'r1-full', start: T0, end: T0 + 50_000, status: 'PASS', full: true, slot: 'dev' },
    { run: 'r2-full', start: T0, end: T0 + 70_000, status: 'FAIL', full: true, slot: 'dev' },
  ];
  it('puts the highest-ranked event of each column in it', () => {
    const t = ticks(
      10,
      T0,
      T0 + 100_000,
      [job(5, 1), job(15, 1, 'test', 1), job(16, 1), job(80, 1, 'lint')],
      runs,
      [T0 + 55_000, T0 + 75_000],
    );
    // col 5: a merge outranks a devcheck pass · col 7: a devcheck failure outranks a merge
    expect(t).toEqual([
      'suite',
      'fail',
      null,
      null,
      null,
      'merge',
      null,
      'devcheck-fail',
      null,
      null,
    ]);
    expect(ticks(10, T0, T0 + 100_000, [], runs, [])[5]).toBe('devcheck-pass');
  });
});

describe('failuresByConcurrency', () => {
  it('bins suites by how many other slot jobs overlapped them', () => {
    const jobs = [
      job(100, 60), // alone, passes
      job(300, 60, 'test', 1), // overlaps the next one: 1 other
      job(290, 60),
      job(600, 300, 'dev'), // a dev server spanning the next suite
      job(500, 60, 'test', 137),
      job(510, 30, 'typecheck'),
      job(900, 60, 'test', 143), // interrupted: a run, not a failure
      job(1000, 60, 'test', 1, { excluded: true }), // a load test: not counted
      job(950, 500, 'other'), // takes no slot
    ];
    const rows = failuresByConcurrency(jobs, T0);
    expect(rows.map((r) => [r.bin, r.runs, r.failed])).toEqual([
      ['alone', 2, 0],
      ['1 other', 2, 1],
      ['2 others', 1, 1],
      ['3+ others', 0, 0],
    ]);
    expect(rows[0]!.p50Sec).toBe(60);
    expect(rows[3]!.p50Sec).toBeNull();
  });

  it('counts a gate:fast run (test-fast) as an overlapping slot job', () => {
    const rows = failuresByConcurrency([job(100, 60), job(110, 30, 'test-fast')], T0);
    expect(rows.map((r) => r.runs)).toEqual([0, 1, 0, 0]);
  });

  it('counts a concurrent gate:fast once, as its outer run; its steps hold no slot', () => {
    const gate = [
      job(110, 40, 'gate-wide'),
      job(112, 30, 'gate-typecheck'),
      job(112, 10, 'gate-lint'),
      job(112, 35, 'gate-test-fast'),
      job(112, 20, 'gate-test'),
    ];
    for (const outer of ['gate-wide', 'gate-narrow']) {
      const jobs = [
        job(100, 60),
        ...gate.map((j) => (j.cls === 'gate-wide' ? { ...j, cls: outer } : j)),
      ];
      expect(
        failuresByConcurrency(jobs, T0).map((r) => r.runs),
        outer,
      ).toEqual([0, 1, 0, 0]);
    }
  });

  it('ignores suites before the window', () => {
    expect(failuresByConcurrency([job(-100, 10, 'test', 1)], T0)[0]!.runs).toBe(0);
  });
});
