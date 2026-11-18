import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeRun } from '../bot/fakes.ts';
import { run as shRun } from '../bot/sh.ts';
import type { GhRun } from './ci.ts';
import { failingFiles, judge, missCheck, vitestDeps, type Deps, type MissEvent } from './miss.ts';
import { plan, type Change } from './plan.ts';

const SHA = '35fe83b8b91cfe2d445e94e1e0e9f08ce81d35b4';
const ROOT = '/repo';
const z = (...xs: string[]) => xs.map((x) => `${x}\0`).join('');
const ch = (...paths: string[]): Change[] => paths.map((path) => ({ path, deleted: false }));
const E = '\x1b';
// The real shape (run 44213262154's --log-failed): job, step, timestamp, pnpm's `<dir> test:` prefix, vitest's ANSI.
const pnpmLine = (dir: string, path: string) =>
  `ci / check\tUNKNOWN STEP\t2026-11-18T01:09:17.7942470Z ${dir} test: ${E}[41m${E}[1m FAIL ${E}[22m${E}[49m ${path}${E}[2m > ${E}[22mthe overlay${E}[2m > ${E}[22mthe pill survives a reload`;
const TESTS = [
  'extension/test/overlay.test.ts',
  'app/src/pages/Home/Home.test.tsx',
  'app/src/pages/Home/HomeCard.test.tsx',
  'scripts/src/gate/plan.test.ts',
  'scripts/src/lone.test.ts',
];
const run1 = (over: Partial<GhRun> = {}): GhRun => ({
  databaseId: 7,
  workflowName: 'Branch',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  createdAt: '2026-11-18T22:00:00Z',
  url: 'https://github.com/x/runs/7',
  ...over,
});

describe('failingFiles', () => {
  it('reads the package from pnpm’s prefix, an app shard’s job name, or a unique match', () => {
    const log = [
      pnpmLine('extension', 'test/overlay.test.ts'),
      pnpmLine('extension', 'test/overlay.test.ts'), // a second failing test in the same file
      `ci / test-app-2\tRun tests\t2026-11-18T01:09:17Z  FAIL  |app| src/pages/Home/Home.test.tsx > Home > shows`,
      `ci / lambdas\tRun tests\t2026-11-18T01:09:17Z  FAIL  src/lone.test.ts [ src/lone.test.ts ]`,
      `ci / check\tUNKNOWN STEP\t2026-11-18T01:09:17Z [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @aperture/extension test failed`,
      `ci / check\tUNKNOWN STEP\t2026-11-18T01:09:17Z  FAIL  not-a-test.ts`,
    ].join('\n');
    expect(failingFiles(log, TESTS)).toEqual([
      'extension/test/overlay.test.ts',
      'app/src/pages/Home/Home.test.tsx',
      'scripts/src/lone.test.ts',
    ]);
  });

  it('no FAIL line → none (a typecheck or lint failure)', () => {
    expect(
      failingFiles('ci / check\tlint\t2026-11-18T01:09:17Z error  x is unused\n', TESTS),
    ).toEqual([]);
  });
});

describe('judge', () => {
  const deps: Deps = (_dir, files) =>
    Object.fromEntries(
      files.map((f) => [
        f,
        f.endsWith('HomeCard.test.tsx') ? ['app/src/pages/Home/HomeCard.tsx'] : ['app/src/x.ts'],
      ]),
    );
  const p = plan(ch('app/src/pages/Home/HomeCard.tsx'), TESTS);

  it('full or named → ran; a skipped package → missed', () => {
    const j = judge(
      ['app/src/pages/Home/HomeCard.test.tsx', 'extension/test/overlay.test.ts'],
      p,
      deps,
      true,
    );
    expect(j.ran).toEqual(['app/src/pages/Home/HomeCard.test.tsx']); // its sibling, by name
    expect(j.missed).toEqual([
      { file: 'extension/test/overlay.test.ts', why: expect.stringMatching(/skipped/) },
    ]);
    expect(judge(['extension/test/overlay.test.ts'], plan([], TESTS), deps, true).ran).toHaveLength(
      1,
    );
  });

  it('a fast package’s un-named file: the graph decides, else unsure', () => {
    const q = plan(
      ch('app/src/pages/Home/HomeCard.tsx'),
      TESTS.filter((t) => !t.endsWith('HomeCard.test.tsx')),
    );
    const both = ['app/src/pages/Home/Home.test.tsx'];
    expect(judge(both, q, deps, true).missed).toEqual([
      { file: both[0], why: expect.stringMatching(/no changed module reaches it/) },
    ]);
    const reaches: Deps = (_d, fs) =>
      Object.fromEntries(fs.map((f) => [f, ['app/src/pages/Home/HomeCard.tsx']]));
    expect(judge(both, q, reaches, true).ran).toEqual(both);
    expect(judge(both, q, deps, false).unsure).toEqual([
      { file: both[0], why: expect.stringMatching(/isn’t the run’s/) },
    ]);
    const broken: Deps = () => {
      throw new Error('vitest: no config');
    };
    expect(judge(both, q, broken, true).unsure[0]!.why).toMatch(
      /couldn't be read \(vitest: no config\)/,
    );
    expect(judge(both, q, () => ({}), true).unsure[0]!.why).toMatch(/doesn’t collect/);
  });

  it('a file in no package is unsure', () => {
    expect(judge(['tools/x.test.ts'], p, deps, true).unsure).toHaveLength(1);
  });
});

describe('missCheck', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const board = () => {
    const d = mkdtempSync(join(tmpdir(), 'miss-'));
    dirs.push(d);
    return d;
  };
  const NOW = Date.parse('2026-11-18T22:05:00Z');
  const world = (log: string, diff = z('M', 'docs/ops/LANES.md'), status = '') =>
    fakeRun([
      ['gh run view 7 --log-failed', log],
      ['git rev-parse --show-toplevel', ROOT],
      [`git ls-tree -r --name-only -z ${SHA}`, z(...TESTS)],
      [`git merge-base origin/main ${SHA}`, 'abc'],
      [`git diff --name-status --no-renames -z abc ${SHA}`, diff],
      ['git rev-parse HEAD', SHA],
      ['git status --porcelain -z', status],
      ['git rev-parse --abbrev-ref HEAD', 'some-lane'],
    ]);

  it('a failing file the plan skipped: printed loudly, logged once per run', async () => {
    const dir = board();
    const out: string[] = [];
    const o = {
      run: world(pnpmLine('extension', 'test/overlay.test.ts')).run,
      log: (l: string) => out.push(l),
      now: () => NOW,
      board: dir,
      deps: () => ({}),
    };
    const e = await missCheck(run1(), SHA, o);
    expect(e).toMatchObject({
      v: 1,
      kind: 'gate-miss',
      branch: 'some-lane',
      sha: SHA,
      run: 7,
      failing: ['extension/test/overlay.test.ts'],
      missed: [{ file: 'extension/test/overlay.test.ts' }],
      unsure: [],
    });
    expect(e).not.toHaveProperty('class'); // the job-row readers (slowdown, staleness) skip it
    expect(out[0]).toMatch(/^!! gate:ci — GATE MISS: 1 failing test file/);
    const rows = readFileSync(join(dir, 'history', 'events-2026-11-18.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(rows.map((r) => (JSON.parse(r) as MissEvent).kind)).toEqual(['gate-miss']);
    out.length = 0;
    await missCheck(run1(), SHA, o);
    expect(out.join('\n')).toMatch(/already logged for run 7/);
    expect(
      readFileSync(join(dir, 'history', 'events-2026-11-18.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });

  it('every failing file ran → one line, no event', async () => {
    const dir = board();
    const out: string[] = [];
    const log = pnpmLine('scripts', 'src/gate/plan.test.ts');
    const e = await missCheck(run1(), SHA, {
      run: world(log, z('M', 'scripts/src/gate/plan.ts')).run,
      log: (l) => out.push(l),
      now: () => NOW,
      board: dir,
    });
    expect(e).toBeNull();
    expect(out).toEqual(['gate:ci — the local gate:fast plan ran all 1 failing test file(s)']);
  });

  it('no failing test file in the logs → no check, no event', async () => {
    const out: string[] = [];
    const e = await missCheck(run1(), SHA, {
      run: world('ci / check\tlint\tts error\n').run,
      log: (l) => out.push(l),
      now: () => NOW,
      board: board(),
    });
    expect(e).toBeNull();
    expect(out[0]).toMatch(/no failing test file in run 7's failed logs/);
  });

  it('a dirty tree can’t read imports: unsure, logged; no board → printed only', async () => {
    const out: string[] = [];
    const q = world(
      pnpmLine('app', 'src/pages/Home/Home.test.tsx'),
      z('M', 'app/src/pages/Home/HomeCard.tsx'),
      z(' M app/x.ts'),
    );
    const e = await missCheck(run1(), SHA, {
      run: q.run,
      log: (l) => out.push(l),
      now: () => NOW,
      board: null,
      deps: () => ({}),
    });
    expect(e!.unsure).toEqual([
      { file: 'app/src/pages/Home/Home.test.tsx', why: expect.stringMatching(/isn’t the run’s/) },
    ]);
    expect(out.join('\n')).toMatch(/no board here: not logged/);
  });
});

describe('vitestDeps (related.ts, on the real tree)', () => {
  it('a gate test’s deps include the module it imports', () => {
    const root = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
    const d = vitestDeps(shRun, root)('scripts', ['scripts/src/gate/plan.test.ts']);
    expect(d['scripts/src/gate/plan.test.ts']).toContain('scripts/src/gate/plan.ts');
  }, 60_000);
});
