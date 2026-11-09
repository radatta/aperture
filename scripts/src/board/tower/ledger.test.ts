import { describe, expect, it } from 'vitest';
import { foldRuns, ttlProof, type Run } from './ledger.ts';

const rec = (op: string, run: string, t: string, status?: string) => ({ op, run, t, status });

describe('foldRuns', () => {
  it('pairs run-start and run-end by id and ignores other ops', () => {
    const m = new Map<string, Run>();
    foldRuns(m, [
      rec('run-start', 'a-full', '2026-11-08T05:00:00Z'),
      rec('created', 'a-full', '2026-11-08T05:01:00Z'),
      { op: 'run-end' },
    ]);
    foldRuns(m, [
      rec('run-end', 'a-full', '2026-11-08T05:10:00Z', 'PASS'),
      rec('run-start', 'b-delta', '2026-11-08T05:20:00Z'),
    ]);
    expect([...m.values()]).toEqual([
      {
        run: 'a-full',
        start: Date.parse('2026-11-08T05:00:00Z'),
        end: Date.parse('2026-11-08T05:10:00Z'),
        status: 'PASS',
        full: true,
        slot: 'dev',
      },
      {
        run: 'b-delta',
        start: Date.parse('2026-11-08T05:20:00Z'),
        end: null,
        status: null,
        full: false,
        slot: 'dev',
      },
    ]);
  });

  it("keeps each slot's runs apart, even under one id", () => {
    const m = new Map<string, Run>();
    foldRuns(m, [rec('run-end', 'x-full', '2026-11-08T05:10:00Z', 'PASS')]);
    foldRuns(m, [rec('run-end', 'x-full', '2026-11-08T05:11:00Z', 'FAIL')], 'devb');
    expect([...m.values()].map((r) => [r.slot, r.status])).toEqual([
      ['dev', 'PASS'],
      ['devb', 'FAIL'],
    ]);
  });
});

describe('ttlProof', () => {
  const at = (h: number) => Date.parse('2026-11-08T00:00:00Z') + h * 3600000;
  const run = (id: string, h: number, status: string, full = true): Run => ({
    run: id,
    start: at(h) - 600000,
    end: at(h),
    status,
    full,
    slot: 'dev',
  });
  it('counts full PASS runs since the window opened, minus the hub exclusions', () => {
    const runs = [
      run('old', -1, 'PASS'),
      run('a', 1, 'PASS'),
      run('b', 2, 'FAIL'),
      run('c', 3, 'PASS'),
      run('d', 4, 'PASS', false),
      run('e', 5, 'PASS'),
      { ...run('f', 6, 'PASS'), end: null },
    ];
    expect(ttlProof(runs, { since: at(0), target: 12, excludedRuns: ['c'] })).toEqual({
      passed: 2,
      failed: 1,
      target: 12,
      since: at(0),
    });
  });
  it("counts slot A's runs only: devb's rows are in another table", () => {
    const runs = [run('a', 1, 'PASS'), { ...run('b', 2, 'PASS'), slot: 'devb' as const }];
    expect(ttlProof(runs, { since: at(0), target: 12, excludedRuns: [] }).passed).toBe(1);
  });
});
