import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeRun } from '../bot/fakes.ts';
import { run as shRun } from '../bot/sh.ts';
import type { GhRun } from './ci.ts';
import { failingFiles, judge, missCheck, vitestDeps, type Deps, type MissEvent } from './miss.ts';
import { plan, type Change } from './plan.ts';

const RULES_TEXT = readFileSync(new URL('./rules.ts', import.meta.url), 'utf8');

const SHA = '35fe83b8b91cfe2d445e94e1e0e9f08ce81d35b4';
const ROOT = '/repo';
const z = (...xs: string[]) => xs.map((x) => `${x}\0`).join('');
const ch = (...paths: string[]): Change[] => paths.map((path) => ({ path, deleted: false }));
// Byte for byte from run 44213262154's `gh run view --log-failed`: gh prints each ESC as the two characters `^[`.
const REAL =
  'ci / check\tUNKNOWN STEP\t2026-11-18T01:09:17.7942470Z extension test: ^[[41m^[[1m FAIL ^[[22m^[[49m test/overlay.test.ts^[[2m > ^[[22mthe overlay on a LeetCode problem^[[2m > ^[[22mthe pill survives a reload and is the dismissed pr';
// The same shape for another package and path; `E` is the escape a raw (unpiped) log would carry.
const E = '\x1b';
const pnpmLine = (dir: string, path: string, esc = '^[') =>
  `ci / check\tUNKNOWN STEP\t2026-11-18T01:09:17.7942470Z ${dir} test: ${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m ${path}${esc}[2m > ${esc}[22mthe overlay`;
const TESTS = [
  'extension/test/overlay.test.ts',
  'app/src/pages/Home/Home.test.tsx',
  'app/src/pages/Home/HomeCard.test.tsx',
  'scripts/src/gate/plan.test.ts',
  'scripts/src/mailroom/runner-fixtures.test.ts',
  'scripts/src/lone.test.ts',
];
const OK = { here: null, merged: null };
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
  it('reads the real log line (gh’s caret-escaped colours)', () => {
    expect(failingFiles(REAL, TESTS)).toEqual(['extension/test/overlay.test.ts']);
  });

  it('reads the package from pnpm’s prefix, an app shard’s job name, or a unique match', () => {
    const log = [
      pnpmLine('extension', 'test/overlay.test.ts', E), // raw escapes
      pnpmLine('extension', 'test/overlay.test.ts'), // a second failing test in the same file
      // the app shards' lines are built from vitest's source (no failed shard log yet): a project label, `|app|`
      // plain or ` app ` coloured, before the path
      `ci / test-app-2\tRun tests\t2026-11-18T01:09:17Z  FAIL  |app| src/pages/Home/Home.test.tsx > Home > shows`,
      `ci / test-app-1\tRun tests\t2026-11-18T01:09:17Z ^[[41m^[[1m FAIL ^[[22m^[[49m ^[[46m app ^[[49m src/pages/Home/HomeCard.test.tsx^[[2m > ^[[22mx`,
      `ci / test-scripts-1\tRun tests\t2026-11-25T01:09:17Z  FAIL  src/gate/cli.test.ts > main > x`,
      `ci / fixtures-2\tMailroom fixture suite\t2026-11-25T01:09:17Z  FAIL  src/mailroom/runner-fixtures.test.ts > r`,
      pnpmLine('cdk', 'test/stack.test.ts').replace('ci / check', 'ci / test-packages'), // -r: prefixed
      `ci / check\tMailroom fixture suite\t2026-11-25T01:09:17Z  FAIL  src/mailroom/runner-fixtures.test.ts > r`, // slice 1: by unique match
      `ci / lambdas\tRun tests\t2026-11-18T01:09:17Z  FAIL  src/lone.test.ts [ src/lone.test.ts ]`,
      `ci / check\tUNKNOWN STEP\t2026-11-18T01:09:17Z [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @aperture/extension test failed`,
      `ci / check\tUNKNOWN STEP\t2026-11-18T01:09:17Z  FAIL  not-a-test.ts`,
    ].join('\n');
    expect(failingFiles(log, TESTS)).toEqual([
      'extension/test/overlay.test.ts',
      'app/src/pages/Home/Home.test.tsx',
      'app/src/pages/Home/HomeCard.test.tsx',
      'scripts/src/gate/cli.test.ts',
      'scripts/src/mailroom/runner-fixtures.test.ts',
      'cdk/test/stack.test.ts',
      'scripts/src/lone.test.ts',
    ]);
  });

  it('a path two packages hold is kept as printed: judge calls it unsure', () => {
    const two = ['app/src/x.test.ts', 'lambdas/src/x.test.ts'];
    const f = failingFiles('ci / other\tRun\tts  FAIL  src/x.test.ts > a', two);
    expect(f).toEqual(['src/x.test.ts']);
    expect(judge(f, plan(ch('docs/a.md'), two), () => ({}), OK).unsure).toEqual([
      { file: 'src/x.test.ts', why: expect.stringMatching(/in no test package/) },
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
      OK,
    );
    expect(j.ran).toEqual(['app/src/pages/Home/HomeCard.test.tsx']); // its sibling, by name
    expect(j.missed).toEqual([
      { file: 'extension/test/overlay.test.ts', why: expect.stringMatching(/skipped/) },
    ]);
    expect(judge(['extension/test/overlay.test.ts'], plan([], TESTS), deps, OK).ran).toHaveLength(
      1,
    );
  });

  it('a fast package’s un-named file: the graph decides, else unsure', () => {
    const q = plan(
      ch('app/src/pages/Home/HomeCard.tsx'),
      TESTS.filter((t) => !t.endsWith('HomeCard.test.tsx')),
    );
    const both = ['app/src/pages/Home/Home.test.tsx'];
    expect(judge(both, q, deps, OK).missed).toEqual([
      { file: both[0], why: expect.stringMatching(/no changed module reaches it/) },
    ]);
    const reaches: Deps = (_d, fs) =>
      Object.fromEntries(fs.map((f) => [f, ['app/src/pages/Home/HomeCard.tsx']]));
    expect(judge(both, q, reaches, OK).ran).toEqual(both);
    // another sha or edits here: nothing can be judged, not even the named or whole ones
    const away = { here: 'this checkout isn’t at 35fe83b8', merged: null };
    expect(judge([...both, 'app/src/pages/Home/HomeCard.test.tsx'], q, deps, away)).toEqual({
      ran: [],
      missed: [],
      unsure: [
        { file: both[0], why: away.here },
        { file: 'app/src/pages/Home/HomeCard.test.tsx', why: away.here },
      ],
    });
    const broken: Deps = () => {
      throw new Error('vitest: no config');
    };
    expect(judge(both, q, broken, OK).unsure[0]!.why).toMatch(
      /couldn't be read \(vitest: no config\)/,
    );
    expect(judge(both, q, () => ({}), OK).unsure[0]!.why).toMatch(/doesn’t collect/);
  });

  it('named tests only, and this one not named → missed; a rerun trigger in related → ran', () => {
    const q = plan(ch('scripts/board/limits.json'), TESTS); // named board tests, related only the JSON
    const r = plan(ch('docs/ops/LANES.md'), TESTS); // named scanners only
    expect(judge(['scripts/src/lone.test.ts'], r, deps, OK).missed).toEqual([
      { file: 'scripts/src/lone.test.ts', why: expect.stringMatching(/named tests only/) },
    ]);
    expect(
      judge(['scripts/src/lone.test.ts'], q, () => ({ 'scripts/src/lone.test.ts': [] }), OK).missed,
    ).toHaveLength(1);
    const cfg = plan(ch('app/src/nested/vite.config.ts'), TESTS);
    expect(judge(['app/src/pages/Home/Home.test.tsx'], cfg, deps, OK).ran).toHaveLength(1);
  });

  it('a PR run on a moved main: a miss is only unsure', () => {
    const merged = { here: null, merged: 'main moved' };
    expect(judge(['extension/test/overlay.test.ts'], p, deps, merged)).toEqual({
      ran: [],
      missed: [],
      unsure: [
        {
          file: 'extension/test/overlay.test.ts',
          why: expect.stringMatching(/skipped.*, but main moved$/),
        },
      ],
    });
  });

  it('a file in no package is unsure', () => {
    expect(judge(['tools/x.test.ts'], p, deps, OK).unsure).toHaveLength(1);
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
  const world = (
    log: string,
    diff = z('M', 'docs/ops/LANES.md'),
    status = '',
    show: () => string = () => RULES_TEXT,
  ) =>
    fakeRun([
      ['gh run view 7 --log-failed', log],
      ['git rev-parse --show-toplevel', ROOT],
      [`git ls-tree -r --name-only -z ${SHA}`, z(...TESTS)],
      [`git merge-base origin/main ${SHA}`, 'abc'],
      [`git diff --name-status --no-renames -z abc ${SHA}`, diff],
      ['git show abc:scripts/src/gate/rules.ts', show],
      ['git rev-parse HEAD', SHA],
      ['git rev-parse origin/main', 'abc'],
      ['git status --porcelain -z --untracked-files=no', status],
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

  it('a rules.ts diff plans with the base copy too; a base git can’t show runs whole, so all ran', async () => {
    const out: string[] = [];
    const diff = z('M', 'scripts/src/gate/rules.ts');
    const o = (show?: () => string) => ({
      run: world(REAL, diff, '', show).run,
      log: (l: string) => out.push(l),
      now: () => NOW,
      board: null,
      deps: () => ({}),
    });
    expect((await missCheck(run1(), SHA, o()))!.missed).toHaveLength(1); // extension skipped either way
    out.length = 0;
    const gone = () => {
      throw new Error('fatal: bad object abc');
    };
    expect(await missCheck(run1(), SHA, o(gone))).toBeNull();
    expect(out).toEqual(['gate:ci — the local gate:fast plan ran all 1 failing test file(s)']);
  });

  it('dedupe spans yesterday’s file; another failing set on the same run logs again', async () => {
    const dir = board();
    const o = (log: string, now: number) => ({
      run: world(log).run,
      log: () => {},
      now: () => now,
      board: dir,
      deps: () => ({}),
    });
    await missCheck(run1(), SHA, o(REAL, Date.parse('2026-11-18T23:59:00Z')));
    await missCheck(run1(), SHA, o(REAL, Date.parse('2026-11-19T00:01:00Z')));
    expect(() => readFileSync(join(dir, 'history', 'events-2026-11-19.jsonl'))).toThrow();
    const both = `${REAL}\n${pnpmLine('scripts', 'src/lone.test.ts')}`;
    await missCheck(run1(), SHA, o(both, Date.parse('2026-11-19T00:02:00Z')));
    expect(
      readFileSync(join(dir, 'history', 'events-2026-11-19.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
  });

  it('the branch comes from the run when gh names it', async () => {
    const e = await missCheck(run1({ headBranch: 'the-run-branch' }), SHA, {
      run: world(REAL).run,
      log: () => {},
      now: () => NOW,
      board: null,
      deps: () => ({}),
    });
    expect(e!.branch).toBe('the-run-branch');
  });

  it('a PR run on a moved main: unsure, not missed', async () => {
    const w = world(REAL);
    const run: typeof w.run = (cmd, args, o) =>
      args.join(' ') === 'rev-parse origin/main' ? 'def' : w.run(cmd, args, o);
    const e = await missCheck(run1({ event: 'pull_request', workflowName: 'PR' }), SHA, {
      run,
      log: () => {},
      now: () => NOW,
      board: null,
      deps: () => ({}),
    });
    expect(e!.missed).toEqual([]);
    expect(e!.unsure[0]!.why).toMatch(/tests the merge with main/);
  });

  it('tracked edits here: unsure, logged; no board → printed only', async () => {
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
      {
        file: 'app/src/pages/Home/Home.test.tsx',
        why: expect.stringMatching(/uncommitted edits/),
      },
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
