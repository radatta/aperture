import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetReport, formatBudgetReport, JOB_PSI_SEC } from './budget-report.ts';
import { main } from './cli.ts';
import type { Sample } from './rollup.ts';

const since = new Date('2026-11-18T00:00:00Z');
const now = new Date('2026-11-18T23:00:00Z');
const at = (hm: string, sec = 0) =>
  new Date(Date.parse(`2026-11-18T${hm}:00Z`) + sec * 1000).toISOString();

const job = (t: string, would: 'admit' | 'wait', wait: boolean, over: object = {}) => ({
  v: 1,
  t,
  kind: 'budget',
  scope: 'job',
  branch: 'a',
  class: 'test',
  unit: { as: 'test', units: 3 },
  committed: { total: 4, lightKnown: true },
  limit: 6.5,
  allowed: 6.5,
  would,
  k: 1,
  kWhy: 'ac',
  actual: { verdict: wait ? 'cap-full' : 'grant', wait },
  loadTest: false,
  ...over,
});
const lane = (t: string, would: 'admit' | 'refuse', capResult: string, over: object = {}) => ({
  v: 1,
  t,
  kind: 'budget',
  scope: 'lane',
  branch: `n-${t.slice(11, 16)}`,
  would,
  wouldWhy: would === 'refuse' ? ['sessions'] : [],
  actual: { active: 5, cap: 5, capResult, pace: capResult === 'refused' ? null : 'ok' },
  ...over,
});
const sample = (t: string, psi: number) =>
  ({
    t,
    cg: { anonMiB: 1, pids: 1, cpuCores: 1, psiCpuSome10: psi },
    mix: { working: 0, idle: 0, heavy: 0 },
  }) as Sample;

describe('budgetReport', () => {
  it('an empty window says nothing happened', () => {
    const r = budgetReport([], [], since, now);
    expect(r.jobs).toMatchObject({ seen: 0, unseen: [] });
    expect(r.lanes).toMatchObject({ seen: 0, refusedWouldAdmit: [], ranWouldRefuse: [] });
    expect(formatBudgetReport(r)).toMatch(/jobs: 0 admissions logged/);
  });

  it('crosses what the budget would do with what the live rules did, by unit', () => {
    const r = budgetReport(
      [
        job(at('10:00'), 'wait', false),
        job(at('10:01'), 'wait', true),
        job(at('10:02'), 'admit', false),
        job(at('10:03'), 'admit', false, { unit: { as: 'ui-dev', units: 0.5 } }),
        job(at('10:04'), 'wait', false, { loadTest: true }), // load tests are left out
      ],
      [],
      since,
      now,
    );
    expect(r.jobs.seen).toBe(4);
    expect(r.jobs.cross).toEqual({ waitWait: 1, waitRan: 1, admitWait: 0, admitRan: 2 });
    expect(r.jobs.byUnit).toEqual({
      test: { n: 3, wouldWait: 2 },
      'ui-dev': { n: 1, wouldWait: 0 },
    });
  });

  it('PSI: only samples inside [t, t + JOB_PSI_SEC] count, against the given line', () => {
    const r = budgetReport(
      [
        job(at('10:00'), 'wait', false),
        job(at('11:00'), 'admit', false),
        job(at('12:00'), 'admit', false),
      ],
      [
        sample(at('10:00', 30), 45), // inside: crossed
        sample(at('11:00', -10), 90), // before: ignored
        sample(at('11:00', 60), 12),
        sample(at('11:00', JOB_PSI_SEC + 5), 80), // after: ignored
        // 12:00 has no sample: not counted at all
      ],
      since,
      now,
      40,
    );
    expect(r.jobs.psi).toEqual({
      wouldWait: { n: 1, crossed: 1 },
      wouldAdmit: { n: 1, crossed: 0 },
    });
  });

  it('k: counts by why, and how many would wait at k 1', () => {
    const r = budgetReport(
      [
        job(at('10:00'), 'wait', false, {
          k: 1.3,
          kWhy: 'battery',
          allowed: 5,
          committed: { total: 2.5 },
        }),
        job(at('10:01'), 'wait', false, { committed: { total: 4, lightKnown: false } }),
      ],
      [],
      since,
      now,
    );
    expect(r.k).toEqual({ byWhy: { battery: 1, ac: 1 }, wouldWaitAtK1: 1 }); // 2.5 + 3 fits 6.5; 4 + 3 doesn't
    expect(r.jobs.lightUnknown).toBe(1);
  });

  it('lanes: refused but the budget would admit, started but it would refuse, PSI after starts', () => {
    const r = budgetReport(
      [
        lane(at('09:00'), 'admit', 'refused'),
        lane(at('09:30'), 'admit', 'ok', { actual: { capResult: 'ok', pace: 'blocked' } }),
        lane(at('10:00'), 'refuse', 'over-cap'),
        lane(at('11:00'), 'admit', 'ok'),
      ],
      [sample(at('10:05'), 41), sample(at('11:05'), 10)],
      since,
      now,
    );
    expect(r.lanes.refusedWouldAdmit).toEqual(['n-09:00', 'n-09:30']);
    expect(r.lanes.ranWouldRefuse).toEqual([{ branch: 'n-10:00', why: ['sessions'] }]);
    expect(r.lanes.psi).toEqual({ n: 2, crossed: 1 });
  });

  it('coverage: slotted job runs from a branch with no budget event are named; steps and unslotted runs are not', () => {
    const run = (branch: string, cls: string) => ({
      t: at('10:00'),
      kind: 'job',
      branch,
      class: cls,
    });
    const r = budgetReport(
      [
        job(at('10:00'), 'admit', false),
        run('a', 'gate-wide'),
        run('old', 'gate-wide'),
        run('old', 'typecheck'),
        run('old', 'gate-typecheck'),
        run('old', 'test-file'),
        run('older', 'ui'),
      ],
      [],
      since,
      now,
    );
    expect(r.jobs.unseen).toEqual([
      { branch: 'old', jobs: 2 },
      { branch: 'older', jobs: 1 },
    ]);
    expect(formatBudgetReport(r)).toMatch(
      /not seen \(worktrees older than the budget\): old 2, older 1/,
    );
  });

  it('leaves out events outside the window', () => {
    const r = budgetReport([job('2026-11-17T23:59:00Z', 'wait', false)], [], since, now);
    expect(r.jobs.seen).toBe(0);
  });
});

describe('budget-report keys and the CLI', () => {
  it('a session off a branch (the hub on detached main) is keyed by its name on both sides, so it is seen', () => {
    const r = budgetReport(
      [
        job(at('10:00'), 'admit', false, { branch: null, name: 'dispatch' }),
        { t: at('10:00'), kind: 'job', branch: '', name: 'dispatch', class: 'typecheck' },
      ],
      [],
      since,
      now,
    );
    expect(r.jobs.unseen).toEqual([]);
  });

  it('cli.ts budget-report reads a day of history into the text lines; a bad day count is a usage error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-report-'));
    mkdirSync(dir, { recursive: true });
    const t = new Date(Date.now() - 3600_000);
    const iso = (s: number) => new Date(t.getTime() + s * 1000).toISOString();
    const day = t.toISOString().slice(0, 10);
    writeFileSync(
      join(dir, `events-${day}.jsonl`),
      [
        job(iso(0), 'wait', false),
        job(iso(60), 'admit', false, { unit: { as: 'ui-dev', units: 0.5 } }),
        lane(iso(120), 'admit', 'refused'),
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    writeFileSync(join(dir, `samples-${day}.jsonl`), JSON.stringify(sample(iso(30), 55)) + '\n');
    const out = main(['budget-report', dir, '1'], () => '').split('\n');
    expect(out[1]).toBe('jobs: 2 admissions logged — test 1 (1 would wait), ui-dev 1');
    expect(out[2]).toBe(
      '  would wait: 1 (live rules held 0, ran 1) · would admit: 1 (live rules held 0)',
    );
    expect(out[3]).toBe('  CPU PSI ≥ 40 within 120 s: would-wait 1/1 (100%) · would-admit 0/0 (-)');
    expect(out[5]).toMatch(
      /^lanes: 1 starts logged · refused by the cap or pace, budget would admit: n-/,
    );
    expect(() => main(['budget-report', dir, 'abc'], () => '')).toThrow(/usage: budget-report/);
  });
});
