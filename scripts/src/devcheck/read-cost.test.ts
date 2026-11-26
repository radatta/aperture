import { describe, expect, it } from 'vitest';
import { analyse, checkCap, FETCH_CAP, parseLogs, render, windows } from './read-cost';
import { parseArgs, run, USAGE } from './read-cost-cli';
import type { RunResult, StepResult } from './report';

// A synthetic run: start 10_000; deployWait 100, open 200, setup 300, steps 1000, cleanup 400 → ends at 12_000.
const step = (
  scenario: string,
  id: string,
  at: number | undefined,
  status: StepResult['status'] = 'pass',
) =>
  ({
    scenario,
    step: id,
    title: id,
    status,
    ms: 50,
    ...(at === undefined ? {} : { at }),
  }) as StepResult;
const report = (over: Partial<RunResult> = {}): RunResult =>
  ({
    runId: 'run-x',
    startedAt: 10_000,
    phases: { deployWaitMs: 100, openMs: 200, setupMs: 300, stepsMs: 1000, cleanupMs: 400 },
    steps: [
      step('a', 's1', 10_600),
      step('a', 's2', 10_900),
      step('b', 's1', 11_200),
      step('b', 's2', undefined, 'skipped'),
    ],
    ...over,
  }) as RunResult;

let seq = 0;
const units = (
  at: number,
  op: string,
  ru: number,
  by: unknown[] = [['q:task', 1, ru, 4, 1]],
  id = `req-${++seq}`,
) =>
  `2026-11-25T00:00:00.000Z 2026/11/25/[$LATEST]abc 2026-11-25T00:00:00.000Z\t${id}\tINFO\t${JSON.stringify({ event: 'ddb_units', v: 1, edge: 'bff', op, status: 200, at, ms: 7, ru, wu: 1, n: 1, by })}`;
const reportLine = (id: string, ms: number) =>
  `2026-11-25T00:00:00.000Z 2026/11/25/[$LATEST]abc REPORT RequestId: ${id}\tDuration: ${ms} ms\tBilled Duration: ${Math.ceil(ms)} ms\tMemory Size: 512 MB`;

describe('windows', () => {
  it('lays out the phases and the run steps contiguously, steps to the next one start', () => {
    expect(windows(report()).map((w) => [w.label, w.from, w.to])).toEqual([
      ['deployWait', 10_000, 10_100],
      ['open', 10_100, 10_300],
      ['setup', 10_300, 10_600],
      ['a/s1', 10_600, 10_900],
      ['a/s2', 10_900, 11_200],
      ['b/s1', 11_200, 11_600],
      ['cleanup', 11_600, 12_000],
    ]);
  });
  it('refuses a report written before the stamps', () => {
    expect(() => windows(report({ startedAt: undefined }))).toThrow(/startedAt/);
    expect(() =>
      windows(report({ steps: [{ ...step('a', 's1', undefined), status: 'pass' }] })),
    ).toThrow(/no `at`/);
  });
});

describe('parseLogs + analyse', () => {
  const a = () => {
    seq = 0;
    const text = [
      units(9_000, 'getDay', 99), // before the run
      units(10_400, 'getSettings', 1, [['gc:settings', 1, 1, 1, 0]], 'r-setup'),
      units(10_650, 'listTasks', 10, undefined, 'r-a1'),
      units(10_950, 'listTasks', 20, undefined, 'r-a2'),
      units(11_210, 'getDay', 30, undefined, 'r-b1'),
      units(11_700, 'deleteTask', 5, undefined, 'r-clean'),
      units(12_500, 'getDay', 77), // after the run
      units(10_650, 'listTasks', 10, undefined, 'r-a1'), // an overlapping fetch's duplicate
      `2026-11-25T00:00:00.000Z s 2026-11-25T00:00:00.000Z\tr-bad\tINFO\t{"event":"ddb_units",broken`,
      'not a fetched line',
    ].join('\n');
    const reports = [
      reportLine('r-a1', 40.5),
      reportLine('r-a2', 60),
      reportLine('r-b1', 80),
      reportLine('r-gone', 15000),
    ].join('\n');
    return analyse(report(), parseLogs([text, reports]));
  };

  it('attributes each request to its window and sums it once', () => {
    const r = a();
    expect([r.before, r.after, r.duplicates, r.malformed]).toEqual([1, 1, 1, 1]);
    expect(r.totals).toMatchObject({ reqs: 5, ru: 66, wu: 5, calls: 5 });
    expect(r.phases.map((p) => [p.label, p.ru])).toEqual([
      ['setup', 1],
      ['steps', 60],
      ['cleanup', 5],
    ]);
    expect(r.steps.map((s) => [s.label, s.ru, s.harnessMs])).toEqual([
      ['a/s1', 10, 50],
      ['a/s2', 20, 50],
      ['b/s1', 30, 50],
    ]);
    expect(r.scenarios.map((s) => [s.label, s.ru])).toEqual([
      ['a', 30], // a tie keeps run order
      ['b', 30],
    ]);
  });

  it('joins REPORT Duration by request id, else the handler ms, and counts the unmatched both ways', () => {
    const r = a();
    expect(r.steps[0]!.lambdaMs).toBe(40.5);
    expect(r.phases[0]!.lambdaMs).toBe(7); // the setup request has no REPORT line
    expect(r.unitsWithoutReport).toBe(2); // setup, cleanup
    expect(r.reportsWithoutUnits).toBe(1); // r-gone: a timeout's REPORT with no units line
  });

  it('ranks ops and accesses by units, with the dead share', () => {
    const r = a();
    expect(r.ops.map((o) => [o.label, o.reqs, o.ru, o.items])).toEqual([
      ['bff:listTasks', 2, 30, 8],
      ['bff:getDay', 1, 30, 4],
      ['bff:deleteTask', 1, 5, 4],
      ['bff:getSettings', 1, 1, 1],
    ]);
    expect(r.access[0]).toEqual({ access: 'q:task', calls: 4, units: 65, items: 16, dead: 4 });
    expect(r.top[0]).toMatchObject({ op: 'getDay', where: 'b/s1', ru: 30 });
  });

  it('renders the tables, and with --before the deltas and the steps run in one run only', () => {
    const now = a();
    const md = render(now);
    expect(md).toContain('**66 read units**');
    expect(md).toContain('| a/s1 | 1 | 10 | 1 | 1 | 10 | 41 | 50 |');
    const was = {
      ...now,
      runId: 'run-w',
      totals: { ...now.totals, ru: 132 },
      steps: [...now.steps, { ...now.steps[0]!, label: 'c/s9' }],
    };
    const diff = render(now, was);
    expect(diff).toContain('Before (`run-w`): 132 read units');
    expect(diff).toContain('-50%');
    expect(diff).toContain('before only c/s9; this run only none');
  });

  it('refuses a parallel two-lane run', () => {
    expect(() => analyse(report({ lanes: { mode: 'parallel' } }), parseLogs([]))).toThrow(
      /parallel/,
    );
  });
});

describe('checkCap', () => {
  it('refuses a fetch at the cap and a failed fetch, takes one below it', () => {
    expect(() => checkCap('f', 'x\n'.repeat(FETCH_CAP))).toThrow(/fetch cap/);
    expect(() => checkCap('f', '(fetch failed: AccessDenied)\n')).toThrow(/AccessDenied/);
    expect(() => checkCap('f', 'x\n'.repeat(FETCH_CAP - 1))).not.toThrow();
  });
});

describe('CLI', () => {
  it('--help prints the usage and reads nothing', () => {
    let out = '';
    expect(run(['--help'], (s) => (out += s))).toBe(0);
    expect(out).toBe(`${USAGE}\n`);
  });
  it('refuses missing or unknown arguments with exit 2', () => {
    let out = '';
    expect(run([], (s) => (out += s))).toBe(2);
    expect(out).toMatch(/--report and --logs are required/);
    expect(() => parseArgs(['--report'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
  it('a missing file is a refusal (exit 1), never a partial table', () => {
    let out = '';
    expect(
      run(['--report', '/nonexistent/r.json', '--logs', '/nonexistent'], (s) => (out += s)),
    ).toBe(1);
    expect(out).toMatch(/^devcheck:cost: /);
  });
});
