import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyse, checkCap, FETCH_CAP, fetchLines, parseLogs, render, windows } from './read-cost';
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
const reportLine = (id: string, ms: number, at = 11_000) =>
  `${new Date(at).toISOString()} 2026/11/25/[$LATEST]abc REPORT RequestId: ${id}\tDuration: ${ms} ms\tBilled Duration: ${Math.ceil(ms)} ms\tMemory Size: 512 MB`;

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
  it('opens a steps-gap before a late first step, and one steps window when none ran', () => {
    const late = windows(report({ steps: [step('a', 's1', 10_700)] }));
    expect(late.slice(2, 5).map((w) => [w.label, w.from, w.to])).toEqual([
      ['setup', 10_300, 10_600],
      ['steps-gap', 10_600, 10_700],
      ['a/s1', 10_700, 11_600],
    ]);
    const none = windows(report({ steps: [step('a', 's1', undefined, 'skipped')] }));
    expect(none.map((w) => w.label)).toEqual(['deployWait', 'open', 'setup', 'steps', 'cleanup']);
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
      '{"event":"ddb_units"}', // not a fetched line, but names the event: counted, never dropped silently
      units(10_700, 'listTasks', 3, 'not-an-array' as unknown as unknown[], 'r-shape'), // `by` the wrong shape
      units(10_710, 'listTasks', 3, undefined, 'r-str').replace('"ru":3', '"ru":"3"'), // a number as a string
      'not a fetched line',
    ].join('\n');
    const reports = [
      reportLine('r-a1', 40.5),
      reportLine('r-a2', 60),
      reportLine('r-b1', 80),
      reportLine('r-gone', 15000),
      reportLine('r-early', 9, 9_000), // the previous build's poll, before the run: not a join miss
    ].join('\n');
    return analyse(report(), parseLogs([text, reports]));
  };

  it('attributes each request to its window and sums it once', () => {
    const r = a();
    expect([r.before, r.after, r.duplicates, r.malformed]).toEqual([1, 1, 1, 4]);
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
    expect(r.reportsWithoutUnits).toBe(1); // r-gone: a timeout's REPORT with no units line; r-early is outside
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

  it('counts a request near its own window edge, not the run start or end', () => {
    const r = report({
      phases: { deployWaitMs: 100, openMs: 200, setupMs: 300, stepsMs: 3000, cleanupMs: 400 },
      steps: [step('a', 's1', 10_600), step('a', 's2', 12_000)],
    });
    const at = [11_000, 11_900, 12_100, 13_000, 13_990]; // inside · 100 before a/s2 · 100 after it · inside · 10 before the end
    const got = analyse(r, parseLogs([at.map((t) => units(t, 'getDay', 1)).join('\n')]));
    expect(got.nearEdge).toBe(2);
  });

  it('refuses two users in one report: parallel, a serial iPhone lane, or a step before the start', () => {
    const p = parseLogs([units(10_650, 'listTasks', 1)]);
    expect(() => analyse(report({ lanes: { mode: 'parallel' } }), p)).toThrow(/parallel/);
    expect(() =>
      analyse(report({ lanes: { mode: 'serial', browserMs: 9, iphoneMs: 9 } }), p),
    ).toThrow(/two-user/);
    expect(() => analyse(report({ steps: [step('a', 's1', 9_000)] }), p)).toThrow(/before the run/);
    expect(() => analyse(report({ lanes: { mode: 'serial', browserMs: 9 } }), p)).not.toThrow();
  });

  it('refuses fetches with no units line inside the run (wrong window, no meter)', () => {
    expect(() => analyse(report(), parseLogs([units(9_000, 'getDay', 1)]))).toThrow(
      /no ddb_units line inside the run across the fetches \(1 outside it\)/,
    );
  });
});

describe('fetchLines', () => {
  it("prints both fetches over the run padded 1 min before, 2 after, with the slot's groups", () => {
    const t0 = Date.UTC(2026, 10, 25, 6, 0, 0);
    const [u, rep] = fetchLines(report({ startedAt: t0, target: 'devb (https://example.test)' }));
    expect(u).toBe(
      "pnpm bot logs --groups bff-devb,mcp-devb --start 2026-11-25T05:59:00.000Z --end 2026-11-25T06:02:02.000Z --filter '%ddb_units%'",
    );
    expect(rep).toMatch(/--groups bff-devb,mcp-devb .* --filter REPORT$/);
    expect(fetchLines(report({ startedAt: t0, target: 'dev (https://example.test)' }))[0]).toMatch(
      /--groups bff,mcp /,
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
  const cli = (argv: string[]) => {
    const o = { out: '', err: '', code: 0 };
    o.code = run(
      argv,
      (s) => (o.out += s),
      (s) => (o.err += s),
    );
    return o;
  };
  it('--help prints the usage and reads nothing', () => {
    expect(cli(['--help'])).toEqual({ out: `${USAGE}\n`, err: '', code: 0 });
  });
  it('refuses missing or unknown arguments with exit 2, on stderr', () => {
    const o = cli([]);
    expect([o.code, o.out]).toEqual([2, '']);
    expect(o.err).toMatch(/--report is required/);
    expect(() => parseArgs(['--report', 'r'])).toThrow(/--logs is required/);
    expect(() => parseArgs(['--report'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--report', 'r', '--window', '--logs', 'd'])).toThrow(/only --report/);
  });
  it('a missing file is a refusal (exit 1), never a partial table', () => {
    const o = cli(['--report', '/nonexistent/r.json', '--logs', '/nonexistent']);
    expect([o.code, o.out]).toEqual([1, '']);
    expect(o.err).toMatch(/^devcheck:cost: /);
  });
  it("refuses a logs directory with no .log file, or missing one edge's group", () => {
    const root = mkdtempSync(join(tmpdir(), 'read-cost-'));
    const rep = join(root, 'report.json');
    writeFileSync(rep, JSON.stringify(report()));
    const empty = join(root, 'empty');
    mkdirSync(empty);
    writeFileSync(join(empty, 'fetches.jsonl'), '');
    expect(cli(['--report', rep, '--logs', empty]).err).toMatch(/no \.log file/);
    const half = join(root, 'half');
    mkdirSync(half);
    writeFileSync(join(half, 'bff.log'), `${units(10_650, 'listTasks', 1)}\n`);
    const o = cli(['--report', rep, '--logs', half]);
    expect([o.code, o.err]).toEqual([1, expect.stringMatching(/no mcp group's log/)]);
    writeFileSync(join(half, 'mcp.log'), '');
    expect(cli(['--report', rep, '--logs', half]).code).toBe(0);
    const w = cli(['--report', rep, '--window']);
    expect([w.code, w.out.split('\n').length]).toEqual([0, 3]);
    writeFileSync(join(half, 'bff-devb.log'), `${units(10_650, 'listTasks', 1)}\n`);
    expect(cli(['--report', rep, '--logs', half]).err).toMatch(
      /bff-devb\.log is the other slot's group/,
    );
    const b = join(root, 'b.json');
    writeFileSync(b, JSON.stringify(report({ target: 'devb (https://example.test)' })));
    expect(cli(['--report', b, '--logs', half]).err).toMatch(/bff\.log is the other slot's group/);
  });
  it('--window refuses a two-user run too', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-cost-'));
    const rep = join(root, 'report.json');
    writeFileSync(
      rep,
      JSON.stringify(report({ lanes: { mode: 'parallel' } } as Partial<RunResult>)),
    );
    const w = cli(['--report', rep, '--window']);
    expect([w.code, w.out]).toEqual([1, '']);
    expect(w.err).toMatch(/parallel two-lane/);
  });
});
