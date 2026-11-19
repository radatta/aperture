import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devcheckDetail, SLOWEST, writeHeavyDetail } from './heavy-detail';
import type { RunResult, StepResult } from './report';

const step = (
  scenario: string,
  n: number,
  ms: number,
  status: StepResult['status'] = 'pass',
): StepResult => ({
  scenario,
  step: `s${n}`,
  title: '',
  status,
  ms,
});
const run = (steps: StepResult[]) =>
  ({
    tier: 'full',
    status: 'FAIL',
    durationMs: 90_000,
    phases: { deployWaitMs: 30_000, openMs: 2000, setupMs: 8000, stepsMs: 45_000, cleanupMs: 5000 },
    steps,
  }) as unknown as RunResult;

describe('devcheckDetail', () => {
  it('phases, per-scenario totals over the steps that ran, and the slowest steps', () => {
    const steps = [
      step('tasks', 1, 4000),
      step('tasks', 2, 1000, 'fail'),
      step('tasks', 3, 0, 'skipped'),
      ...Array.from({ length: 12 }, (_, i) => step('coach', i, 100 * (i + 1))),
    ];
    const d = devcheckDetail(run(steps), '/r/report.json');
    expect(d.ms).toEqual({
      total: 90_000,
      deployWaitMs: 30_000,
      openMs: 2000,
      setupMs: 8000,
      stepsMs: 45_000,
      cleanupMs: 5000,
    });
    expect(d.scenarios).toEqual({
      tasks: { ms: 5000, steps: 2, failed: 1 },
      coach: { ms: 7800, steps: 12, failed: 0 },
    });
    expect(d.slow).toHaveLength(SLOWEST);
    expect(d.slow.slice(0, 3)).toEqual([
      { step: 'tasks-s1', ms: 4000 },
      { step: 'coach-s11', ms: 1200 },
      { step: 'coach-s10', ms: 1100 },
    ]);
    expect(d).toMatchObject({ tier: 'full', status: 'FAIL', report: '/r/report.json' });
  });

  it('a report from before phases still has its total', () => {
    const r = { ...run([]), phases: undefined } as RunResult;
    expect(devcheckDetail(r, 'x').ms).toEqual({ total: 90_000 });
  });

  it('writes devcheck.json only under heavy.sh, and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dcd-'));
    writeHeavyDetail(run([]), 'x', dir);
    expect(JSON.parse(readFileSync(join(dir, 'devcheck.json'), 'utf8')).ms.total).toBe(90_000);
    expect(() => writeHeavyDetail(run([]), 'x', join(dir, 'gone', 'x'))).not.toThrow();
  });

  it('defaults to HEAVY_DETAIL_DIR, and writes nothing without it', () => {
    const saved = process.env.HEAVY_DETAIL_DIR; // set when this suite itself runs under heavy.sh
    const dir = mkdtempSync(join(tmpdir(), 'dcd-'));
    try {
      process.env.HEAVY_DETAIL_DIR = dir;
      writeHeavyDetail(run([]), 'x');
      expect(readdirSync(dir)).toEqual(['devcheck.json']);
      rmSync(join(dir, 'devcheck.json'));
      delete process.env.HEAVY_DETAIL_DIR;
      writeHeavyDetail(run([]), 'x');
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.HEAVY_DETAIL_DIR;
      else process.env.HEAVY_DETAIL_DIR = saved;
    }
  });
});
