import { describe, it, expect } from 'vitest';
import {
  barriers,
  formatBarriers,
  formatReport,
  pct,
  rollup,
  slope,
  stat,
  type BarrierEvent,
  type JobEvent,
  type Sample,
} from './rollup.ts';

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
    job('test', 12000, { loadTest: true }), // edge run — excluded too
    { kind: 'lease', t: '2026-10-13T12:00:00Z' } as unknown as JobEvent, // not a job
    job('typecheck', 900),
  ];
  const r = rollup(samples, events, since);

  it('ignores the bot’s devlock rows (lock-events.ts), in the jobs and the barriers alike', () => {
    const devlock = [
      {
        v: 1,
        t: '2026-10-13T12:00:00Z',
        kind: 'devlock',
        action: 'wait-start',
        name: 's',
        branch: 'b',
        slots: ['dev'],
      },
      {
        v: 1,
        t: '2026-10-13T12:10:00Z',
        kind: 'devlock',
        action: 'acquired',
        name: 's',
        branch: 'b',
        slot: 'dev',
        waitSec: 600,
      },
    ] as unknown as JobEvent[];
    const now = new Date('2026-10-14T00:00:00Z');
    expect(rollup(samples, [...events, ...devlock], since, now)).toEqual(
      rollup(samples, events, since, now),
    );
    expect(barriers([...events, ...devlock], since, now)).toEqual(barriers(events, since, now));
  });

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
    // a week of idle-session samples: spreading this many into Math.max throws RangeError
    expect(stat(Array.from({ length: 200_000 }, (_, i) => i % 7)).max).toBe(6);
  });

  it('returns null when the session count never varied', () => {
    expect(slope([5, 5, 5], [1, 2, 3])).toBeNull();
    expect(slope([1], [1])).toBeNull();
    expect(slope([1, 2, 3], [10, 20, 30])).toBe(10);
  });
});

describe('barriers — how limiting the cap is', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const week = new Date('2026-10-13T00:00:00Z');
  const mix = { working: 3, idle: 2, heavy: 4 };
  const ev = (
    action: BarrierEvent['action'],
    t: string,
    pid: number,
    name: string,
    extra: Partial<BarrierEvent> = {},
  ): BarrierEvent => ({
    kind: 'lease',
    lease: 'heavy',
    action,
    t: `2026-10-14T${t}Z`,
    pid,
    name,
    class: 'test',
    reason: 'cap',
    mix,
    holders: [{ name: 'dev-e2e', class: 'test' }],
    ...extra,
  });
  const events = [
    ev('denied', '10:00:00', 10, 'flux'),
    ev('waited', '10:01:00', 10, 'flux', { waitedSec: 30 }), // its re-run, 30 s after the deny: one block
    ev('waited', '11:00:00', 20, 'task-parts', { waitedSec: 12 }),
    ev('gaveUp', '12:00:00', 20, 'task-parts', { waitedSec: 90 }),
    ev('denied', '13:00:00', 30, 'ci-bot'), // never re-run through heavy.sh
    ev('wouldWait', '14:00:00', 30, 'ci-bot'), // enforce off: counterfactual only
    ev('denied', '15:00:00', 40, 'refund', { reason: 'hard' }),
    ev('waited', '15:06:00', 40, 'refund', { reason: 'hard', waitedSec: 10 }), // 5 min later: two blocks
    ev('waited', '16:00:00', 50, 'edge', { loadTest: true, waitedSec: 60 }), // load test: excluded
    { ...ev('waited', '10:00:00', 60, 'old', { waitedSec: 99 }), t: '2026-10-12T10:00:00Z' }, // before
    { kind: 'lease', lease: 'dev', action: 'takeover', t: '2026-10-14T09:00:00Z' }, // not a barrier
  ];
  const b = barriers(events, week, now);

  it('counts blocks, merging a deny with its re-run within two minutes', () => {
    expect(b).toMatchObject({
      days: 7,
      blocks: 6,
      merged: 1,
      waited: 3,
      gaveUp: 1,
      denied: 3,
      wouldWait: 1,
      perDay: 0.9,
    });
  });

  it('sums the waits and their spread (waited + gave up)', () => {
    expect(b.waitSec).toEqual({ total: 142, p50: 12, p90: 90, max: 90 });
  });

  it('says what caused them, counting blocks so the breakdowns add up to the headline', () => {
    expect(b.byReason).toEqual([
      { key: 'cap', n: 4 },
      { key: 'hard', n: 2 },
    ]);
    expect(b.byMix).toEqual([{ key: '3w 2i 4h', n: 6 }]);
    expect(b.byHolder).toEqual([{ key: 'dev-e2e', n: 6 }]);
    expect(b.byBlocked).toEqual([
      { key: 'refund', n: 2 },
      { key: 'task-parts', n: 2 },
      { key: 'ci-bot', n: 1 },
      { key: 'flux', n: 1 }, // its deny + re-run: one block
    ]);
    for (const by of [b.byReason, b.byMix, b.byBlocked])
      expect(by.reduce((a, c) => a + c.n, 0)).toBe(b.blocks);
  });

  it('never merges strangers: pid 0 (no claude ancestor) falls back to the name', () => {
    const x = barriers(
      [
        ev('denied', '10:00:00', 0, 'flux'),
        ev('waited', '10:01:00', 0, 'ci-bot', { waitedSec: 20 }),
      ],
      week,
      now,
    );
    expect(x).toMatchObject({ blocks: 2, merged: 0 });
  });

  it('an interrupted wait is a gave-up block, with its real wait, and says so', () => {
    const x = barriers(
      [ev('gaveUp', '10:00:00', 10, 'flux', { waitedSec: 41, interrupted: true })],
      week,
      now,
    );
    expect(x).toMatchObject({ blocks: 1, gaveUp: 1, interrupted: 1, waitSec: { total: 41 } });
    expect(formatBarriers(x)).toContain('1 gave up (1 interrupted)');
    expect(b.interrupted).toBe(0);
  });

  it('a lock-busy fail-open is reported, not counted as a block', () => {
    const x = barriers(
      [ev('lockBusy', '10:00:00', 10, 'flux', { reason: 'lock', waitedSec: 90 })],
      week,
      now,
    );
    expect(x).toMatchObject({ blocks: 0, lockBusy: 1 });
    expect(formatBarriers(x)).toBe('barriers (7 d): none · 1× ran unslotted (board lock busy)');
  });

  it('uses the real window for the rate', () => {
    const halfDay = new Date(now.getTime() - 12 * 3600_000);
    const x = barriers(
      [{ ...ev('denied', '10:00:00', 10, 'flux'), t: '2026-10-19T18:00:00Z' }],
      halfDay,
      now,
    );
    expect(x).toMatchObject({ days: 0.5, blocks: 1, perDay: 2 });
  });

  it('formats one line for board.sh status, and says none when nothing was held', () => {
    const line = formatBarriers(b);
    expect(line).toContain('6 blocks (0.9/day)');
    expect(line).toContain('3 denied (1 re-run, counted once)');
    expect(line).toContain('waited 142 s total, p50 12 s, p90 90 s');
    expect(line).toContain('would have held 1× (enforce off)');
    expect(formatBarriers(barriers([], week, now))).toBe('barriers (7 d): none');
  });

  it('is part of the report', () => {
    const r = rollup([], events as unknown as JobEvent[], week, now);
    expect(r.barriers.blocks).toBe(6);
    expect(formatReport(r)).toContain('Barriers (test cap / hard-line holds');
    expect(formatReport(r)).toContain('held by: dev-e2e ×6');
  });

  it('pct is nearest-rank', () => {
    expect(pct([], 0.9)).toBe(0);
    expect(pct([10, 12, 30, 90], 0.5)).toBe(12);
    expect(pct([10, 12, 30, 90], 0.9)).toBe(90);
  });
});
