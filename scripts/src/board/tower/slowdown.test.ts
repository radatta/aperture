import { describe, expect, it } from 'vitest';
import type { Job } from './model.ts';
import { slowdown, slowdownLine } from './slowdown.ts';

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
const of = (jobs: Job[], cls: string) => slowdown(jobs, NOW).classes.find((c) => c.cls === cls)!;

describe('slowdown', () => {
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
    });
    const s = slowdown(jobs, NOW);
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
    expect(slowdown([], NOW)).toEqual({
      windowMin: 30,
      classes: ['typecheck', 'lint', 'test', 'ui'].map((cls) => ({
        cls,
        recentSec: null,
        baseSec: null,
        ratio: null,
        nRecent: 0,
        nBase: 0,
        base: null,
      })),
      worst: null,
      tone: 'ok',
      line: 'typecheck – (0 recent) · lint – (0 recent) · test – (0 recent) · ui – (0 recent)',
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
    expect(slowdown(jobs, NOW)).toMatchObject({ worst: null, tone: 'ok' });
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

  it('test-file, dev, build and other are left out', () => {
    const jobs = ['test-file', 'dev', 'build', 'other'].flatMap((c) => [
      ...base(c, 6, 1),
      job(c, 1, 9),
      job(c, 2, 9),
    ]);
    expect(slowdown(jobs, NOW).classes.map((c) => c.cls)).toEqual([
      'typecheck',
      'lint',
      'test',
      'ui',
    ]);
    expect(slowdown(jobs, NOW).worst).toBeNull();
  });

  it('the line: ratio with counts, or why there is none', () => {
    const jobs = [
      ...base('test', 6, 100),
      job('test', 3, 180),
      job('test', 4, 180),
      job('lint', 2, 4),
    ];
    expect(slowdownLine(slowdown(jobs, NOW))).toBe(
      'typecheck – (0 recent) · lint – (1 recent) · test ×1.8 (2/6) · ui – (0 recent)',
    );
  });
});
