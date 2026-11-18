import { describe, expect, it } from 'vitest';
import type { Job } from './model.ts';
import { SLOW_STALE_MS, slowdown, slowdownLine, slowdownShort } from './slowdown.ts';

const NOW = Date.parse('2026-11-17T20:00:00Z');
const MIN = 60_000;
const job = (cls: string, agoMin: number, wallSec: number, o: Partial<Job> = {}): Job => ({
  t: NOW - agoMin * MIN,
  start: NOW - agoMin * MIN - wallSec * 1000,
  cls,
  label: cls,
  name: 'x',
  branch: 'x',
  exit: 0,
  signal: null,
  wallSec,
  verdict: 'clean',
  excluded: false,
  ...o,
});
// n baseline runs of `sec`, spread over the 24 h before the window
const base = (cls: string, n: number, sec: number, fromMin = 60) =>
  Array.from({ length: n }, (_, i) => job(cls, fromMin + i * 60, sec));
// UTC, so the test doesn't depend on the container's zone
const hm = (t: number) => new Date(t).toISOString().slice(11, 16);
const sd = (jobs: Job[], now = NOW) => slowdown(jobs, now, hm);
const of = (jobs: Job[], cls: string) => sd(jobs).classes.find((c) => c.cls === cls)!;
const ALL = ['typecheck', 'lint', 'test', 'ui', 'gate-lint', 'gate-narrow', 'gate-wide'];

describe('slowdown', () => {
  it('leaves cold-cache runs out of both windows (F314): a first typecheck is the cache, not the box', () => {
    const jobs = [
      ...base('typecheck', 6, 4),
      job('typecheck', 70, 40, { cold: true }), // a baseline cold run would lower the ratio
      job('typecheck', 5, 4.4),
      job('typecheck', 10, 4.4),
      job('typecheck', 15, 45, { cold: true }), // a recent one would raise it
    ];
    expect(of(jobs, 'typecheck')).toMatchObject({
      recentSec: 4.4,
      baseSec: 4,
      nRecent: 2,
      nBase: 6,
      ratio: 1.1,
    });
  });

  it('median of the last 30 min over the 24 h before it, per class', () => {
    const jobs = [
      ...base('typecheck', 6, 4),
      job('typecheck', 5, 7),
      job('typecheck', 20, 8),
      job('typecheck', 25, 7.4),
    ];
    expect(of(jobs, 'typecheck')).toEqual({
      cls: 'typecheck',
      recentSec: 7.4,
      baseSec: 4,
      ratio: 1.9,
      nRecent: 3,
      nBase: 6,
      base: '24h',
      lastAt: NOW - 5 * MIN,
      stale: false,
    });
    const s = sd(jobs);
    expect(s.worst).toEqual({ cls: 'typecheck', ratio: 1.9 });
    expect(s.tone).toBe('warn');
  });

  it('under 2 recent or 5 baseline runs is no ratio, with the counts', () => {
    const one = of([...base('lint', 6, 4), job('lint', 5, 8)], 'lint');
    expect(one).toMatchObject({ ratio: null, nRecent: 1, nBase: 6 });
    const thin = of(
      [...base('lint', 4, 4, 60 * 24 * 8), job('lint', 5, 8), job('lint', 6, 8)],
      'lint',
    );
    expect(thin).toMatchObject({ ratio: null, nRecent: 2, nBase: 0, base: null });
    expect(sd([])).toEqual({
      windowMin: 30,
      classes: ALL.map((cls) => ({
        cls,
        recentSec: null,
        baseSec: null,
        ratio: null,
        nRecent: 0,
        nBase: 0,
        base: null,
        lastAt: null,
        stale: true,
      })),
      worst: null,
      tone: 'ok',
      line: ALL.map((c) => `${c} – (no data in 7 d)`).join(' · '),
      short: 'slow: no data in 7 d',
    });
  });

  it('widens the baseline to 7 d when the day is thin', () => {
    const jobs = [
      ...base('test', 2, 160),
      ...base('test', 4, 160, 60 * 30),
      job('test', 3, 330),
      job('test', 9, 320),
    ];
    expect(of(jobs, 'test')).toMatchObject({ base: '7d', nBase: 6, ratio: 2 });
    // test is in the line, never the headline: it mixes whole suites with filtered runs
    expect(sd(jobs)).toMatchObject({ worst: null, tone: 'ok' });
  });

  it("failed, load-test and guard runs don't count", () => {
    const jobs = [
      ...base('ui', 5, 40),
      job('ui', 5, 41),
      job('ui', 6, 39),
      job('ui', 7, 400, { exit: 1 }),
      job('ui', 8, 400, { excluded: true }),
      job('ui', 90, 1, { exit: 134 }),
    ];
    expect(of(jobs, 'ui')).toMatchObject({ nRecent: 2, nBase: 5, ratio: 1 });
  });

  it('test-file, dev, build, other and the gate steps but lint are left out', () => {
    const out = [
      'test-file',
      'dev',
      'build',
      'other',
      'gate-typecheck',
      'gate-test',
      'gate-test-fast',
      'test-fast',
    ];
    const jobs = out.flatMap((c) => [...base(c, 6, 1), job(c, 1, 9), job(c, 2, 9)]);
    expect(sd(jobs).classes.map((c) => c.cls)).toEqual(ALL);
    expect(sd(jobs).worst).toBeNull();
  });

  it('gate-narrow and gate-wide each against their own baseline, and never the headline', () => {
    const jobs = [
      ...base('gate-narrow', 6, 20),
      job('gate-narrow', 3, 40),
      job('gate-narrow', 9, 40),
      ...base('gate-wide', 6, 200),
      job('gate-wide', 4, 600),
      job('gate-wide', 8, 600),
    ];
    expect(of(jobs, 'gate-narrow')).toMatchObject({ ratio: 2, nRecent: 2, nBase: 6 });
    expect(of(jobs, 'gate-wide')).toMatchObject({ ratio: 3, nRecent: 2, nBase: 6 });
    expect(sd(jobs)).toMatchObject({ worst: null, tone: 'ok' });
    // narrow only: wide says it has none, narrow still rates
    const narrow = jobs.filter((j) => j.cls === 'gate-narrow');
    expect(of(narrow, 'gate-wide')).toMatchObject({ ratio: null, stale: true, lastAt: null });
    expect(of(narrow, 'gate-narrow').ratio).toBe(2);
  });

  it('gate-lint rates against its own baseline, never pooled with lint, and sets the headline', () => {
    const jobs = [
      ...base('lint', 6, 3),
      ...base('gate-lint', 6, 10),
      job('gate-lint', 2, 25),
      job('gate-lint', 6, 25),
    ];
    expect(of(jobs, 'gate-lint')).toMatchObject({ ratio: 2.5, nBase: 6 });
    expect(of(jobs, 'lint')).toMatchObject({ ratio: null, nRecent: 0, nBase: 6 });
    expect(sd(jobs)).toMatchObject({ worst: { cls: 'gate-lint', ratio: 2.5 }, tone: 'bad' });
  });

  it('stale past 2 h: since HH:MM under 20 h, then hours, then days', () => {
    const at = (ms: number) => of([job('lint', 0, 4, { t: NOW - ms })], 'lint');
    expect(at(SLOW_STALE_MS)).toMatchObject({ stale: false, lastAt: NOW - SLOW_STALE_MS });
    expect(at(SLOW_STALE_MS + 1)).toMatchObject({ stale: true });
    const line = (ms: number) =>
      slowdownLine(sd([job('lint', 0, 4, { t: NOW - ms })]), NOW, hm).split(' · ')[1];
    expect(line(SLOW_STALE_MS)).toBe('lint – (0 recent)');
    expect(line(SLOW_STALE_MS + 1)).toBe('lint – (no data since 17:59)');
    expect(line(20 * 60 * MIN - 1)).toBe('lint – (no data since 00:00)');
    expect(line(20 * 60 * MIN)).toBe('lint – (no data in 20 h)');
    expect(line(48 * 60 * MIN - 1)).toBe('lint – (no data in 47 h)');
    expect(line(48 * 60 * MIN)).toBe('lint – (no data in 2 d)');
    expect(line(3 * 24 * 60 * MIN + MIN)).toBe('lint – (no data in 3 d)');
  });

  it('the last run ignores failed, excluded and future runs', () => {
    const jobs = [
      job('typecheck', 300, 4),
      job('typecheck', 10, 4, { exit: 1 }),
      job('typecheck', 11, 4, { excluded: true }),
      job('typecheck', -5, 4),
    ];
    expect(of(jobs, 'typecheck')).toMatchObject({ lastAt: NOW - 300 * MIN, stale: true });
  });

  it('the line: ratio with counts, or why there is none', () => {
    const jobs = [
      ...base('test', 6, 100),
      job('test', 3, 180),
      job('test', 4, 180),
      job('lint', 2, 4),
    ];
    expect(slowdownLine(sd(jobs), NOW, hm)).toBe(
      'typecheck – (no data in 7 d) · lint – (1 recent) · test ×1.8 (2/6) · ui – (no data in 7 d) · gate-lint – (no data in 7 d) · gate-narrow – (no data in 7 d) · gate-wide – (no data in 7 d)',
    );
    // a 7 d baseline says so
    const wide = [
      ...base('gate-wide', 5, 200, 60 * 30),
      job('gate-wide', 3, 220),
      job('gate-wide', 5, 220),
    ];
    expect(slowdownLine(sd(wide), NOW, hm)).toContain('gate-wide ×1.1 (2/5 7d)');
  });

  describe('the status line cut', () => {
    const rated = (cls: string, sec = 4) => [
      ...base(cls, 6, 4),
      job(cls, 2, sec),
      job(cls, 3, sec),
    ];
    const short = (jobs: Job[]) => sd(jobs).short;
    it('all rated', () => {
      expect(
        short([
          ...rated('typecheck', 4.8),
          ...rated('lint'),
          ...rated('gate-lint', 6),
          ...rated('gate-narrow', 5.6),
          ...rated('gate-wide', 4.4),
        ]),
      ).toBe('slow 30m tc×1.2 lint×1.0 gl×1.5 gn×1.4 gw×1.1');
    });
    it('thin keeps a dash; test and ui stay off', () => {
      expect(
        short([
          ...rated('typecheck', 4.8),
          job('lint', 20, 4),
          ...rated('test'),
          ...rated('ui'),
          job('gate-lint', 90, 4),
          job('gate-narrow', 5, 4),
          ...rated('gate-wide', 4.4),
        ]),
      ).toBe('slow 30m tc×1.2 lint– gl– gn– gw×1.1');
    });
    it('stale classes share one tail at the newest last run', () => {
      expect(
        short([
          ...rated('typecheck', 4.8),
          job('lint', 182, 4),
          ...rated('gate-lint'),
          ...rated('gate-narrow'),
          ...rated('gate-wide'),
        ]),
      ).toBe('slow 30m tc×1.2 gl×1.0 gn×1.0 gw×1.0 · lint no data since 16:58');
      // a never-seen class rides the dated one's time, which is true of both
      expect(
        short([
          job('lint', 300, 4),
          job('typecheck', 181, 4),
          ...rated('gate-lint'),
          ...rated('gate-narrow'),
          ...rated('gate-wide'),
        ]),
      ).toBe('slow 30m gl×1.0 gn×1.0 gw×1.0 · tc, lint no data since 16:59');
    });
    it('all stale', () => {
      expect(short([job('gate-wide', 200, 4), job('ui', 1, 4)])).toBe('slow: no data since 16:40');
      expect(short([job('gate-wide', 3 * 24 * 60, 4)])).toBe('slow: no data in 3 d');
      expect(slowdownShort(sd([]), NOW, hm)).toBe('slow: no data in 7 d');
      // a class named like an Object prototype key isn't one of the cut's
      const proto = { ...of([], 'lint'), cls: 'constructor', stale: false };
      expect(slowdownShort({ classes: [proto] }, NOW, hm)).toBe('slow: no data in 7 d');
    });
  });
});
