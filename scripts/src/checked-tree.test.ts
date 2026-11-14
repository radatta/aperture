import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type CheckRun,
  CHECK_JOB,
  FIXTURE_STEP,
  greenSuite,
  plan,
  PR_WORKFLOW,
  REQUIRED_CHECKS,
  run,
  runIdOf,
  SCAN_STEP,
  treeOf,
  TREE_PATH,
  TREE_TITLE,
} from './checked-tree';
import { fakeApi, ghError } from './bot/fakes';

const SHA = 'a'.repeat(40); // the squash commit on main
const HEAD = 'b'.repeat(40); // the PR's head
const TREE = 'c'.repeat(40); // the squash commit's tree
const OTHER = 'd'.repeat(40);
const RUN = 700;
const url = (job: number, runId = RUN) => `https://github.com/o/r/actions/runs/${runId}/job/${job}`;

type Run = CheckRun;
const checkRun = (id: number, name: string, over: Partial<Run> = {}): Run => ({
  id,
  name,
  head_sha: HEAD,
  status: 'completed',
  conclusion: 'success',
  details_url: url(id),
  app: { slug: 'github-actions' },
  check_suite: { id: 50 },
  ...over,
});
// One green PR run: ci / check is job 101, the shards 102 and 103, plus a GitGuardian run from another app.
const greenRuns = (): Run[] => [
  checkRun(101, 'ci / check'),
  checkRun(102, 'ci / test-app-1'),
  checkRun(103, 'ci / test-app-2'),
  checkRun(104, 'GitGuardian Security Checks', {
    app: { slug: 'gitguardian' },
    check_suite: { id: 51 },
  }),
];

interface World {
  pulls?: unknown[] | (() => unknown);
  runs?: Run[] | Run[][];
  run?: Record<string, unknown>;
  notes?: unknown[];
  steps?: { name: string; conclusion: string | null }[];
  job?: Record<string, unknown>;
}
const merged = {
  number: 9,
  state: 'closed',
  merged_at: '2026-11-13T10:00:00Z',
  merge_commit_sha: SHA,
  head: { sha: HEAD },
};
const note = (message = TREE, over: Record<string, unknown> = {}) => ({
  path: TREE_PATH,
  title: TREE_TITLE,
  annotation_level: 'notice',
  message,
  ...over,
});
const steps = (fixtures: string | null = 'success', scan: string | null = 'success') => [
  { name: 'Tested tree', conclusion: 'success' },
  { name: SCAN_STEP, conclusion: scan },
  { name: 'Run pnpm lint', conclusion: 'success' },
  { name: FIXTURE_STEP, conclusion: fixtures },
];

function world(w: World = {}) {
  const pages = Array.isArray(w.runs?.[0])
    ? (w.runs as Run[][])
    : [(w.runs as Run[]) ?? greenRuns()];
  return fakeApi({
    'GET /repos/o/r/commits/aaaa': () =>
      typeof w.pulls === 'function' ? w.pulls() : (w.pulls ?? [merged]),
    [`GET /repos/o/r/commits/${HEAD}/check-runs`]: ({ path }) => {
      const page = Number(/page=(\d+)$/.exec(path)?.[1] ?? 1);
      const got = pages[page - 1];
      if (!got) throw ghError(500);
      return { total_count: pages.flat().length, check_runs: got };
    },
    'GET /repos/o/r/actions/runs/': () => ({
      path: PR_WORKFLOW,
      event: 'pull_request',
      conclusion: 'success',
      head_sha: HEAD,
      ...w.run,
    }),
    'GET /repos/o/r/check-runs/': () => w.notes ?? [note()],
    'GET /repos/o/r/actions/jobs/': () => ({
      conclusion: 'success',
      steps: w.steps ?? steps(),
      ...w.job,
    }),
  });
}
const planOf = async (w: World = {}, tree = TREE) =>
  (await plan(world(w).api, 'o/r', SHA, tree)).plan;

describe('checked-tree plans main’s check', () => {
  it('skips when a green PR run tested this exact tree with the fixture suite', async () => {
    const { api, calls } = world();
    expect(await plan(api, 'o/r', SHA, TREE)).toEqual({
      plan: 'skip',
      why: `run ${RUN} checked tree ${TREE}`,
    });
    expect(calls.map((c) => c.path)).toEqual([
      `/repos/o/r/commits/${SHA}/pulls?per_page=100`,
      `/repos/o/r/commits/${HEAD}/check-runs?filter=all&per_page=100&page=1`,
      `/repos/o/r/actions/runs/${RUN}`,
      '/repos/o/r/check-runs/101/annotations?per_page=100',
      '/repos/o/r/actions/jobs/101',
    ]);
  });

  it('runs the fixture suite alone when the PR run skipped it', async () => {
    expect(await planOf({ steps: steps('skipped') })).toBe('fixtures');
  });

  describe('a tree never checked is always checked', () => {
    it('no tested-tree notice', async () => expect(await planOf({ notes: [] })).toBe('check'));
    it('a notice for another tree', async () =>
      expect(await planOf({ notes: [note(OTHER)] })).toBe('check'));
    it('main moved: the PR run tested a different merge', async () =>
      expect(await planOf({}, OTHER)).toBe('check'));
    it('no PR run at all', async () => expect(await planOf({ runs: [] })).toBe('check'));
    it('no PR owns the commit (a direct push)', async () =>
      expect(await planOf({ pulls: [] })).toBe('check'));
    it('an unreadable tree', async () => expect(await planOf({}, '')).toBe('check'));
  });

  describe('trusts only a green github-actions PR run', () => {
    it('another app', async () => {
      for (const slug of ['aperture-cc-bot', 'gitguardian', undefined])
        expect(await planOf({ runs: greenRuns().map((r) => ({ ...r, app: { slug } })) })).toBe(
          'check',
        );
      expect(await planOf({ runs: greenRuns().map((r) => ({ ...r, app: null })) })).toBe('check');
    });
    it('a dispatched workflow’s runs (the bot can dispatch deploy-dev.yml)', async () => {
      expect(
        await planOf({
          run: { path: '.github/workflows/deploy-dev.yml', event: 'workflow_dispatch' },
        }),
      ).toBe('check');
      expect(await planOf({ run: { event: 'push' } })).toBe('check');
      expect(await planOf({ run: { path: '.github/workflows/ci.yml' } })).toBe('check');
    });
    it('a run on another head', async () => {
      expect(await planOf({ run: { head_sha: OTHER } })).toBe('check');
      expect(await planOf({ runs: greenRuns().map((r) => ({ ...r, head_sha: OTHER })) })).toBe(
        'check',
      );
    });
    it('a failed, missing or unfinished shard', async () => {
      const r = greenRuns();
      expect(
        await planOf({ runs: r.map((x) => (x.id === 103 ? { ...x, conclusion: 'failure' } : x)) }),
      ).toBe('check');
      expect(await planOf({ runs: r.filter((x) => x.id !== 102) })).toBe('check');
      expect(
        await planOf({
          runs: r.map((x) =>
            x.id === 102 ? { ...x, status: 'in_progress', conclusion: null } : x,
          ),
        }),
      ).toBe('check');
      expect(
        await planOf({ runs: r.map((x) => (x.id === 101 ? { ...x, conclusion: 'skipped' } : x)) }),
      ).toBe('check');
    });
    it('shards split across suites', async () => {
      const r = greenRuns().map((x) => (x.id === 103 ? { ...x, check_suite: { id: 60 } } : x));
      expect(await planOf({ runs: r })).toBe('check');
    });
    it('a run that did not finish green', async () => {
      expect(await planOf({ run: { conclusion: 'failure' } })).toBe('check');
      expect(await planOf({ job: { conclusion: 'failure' } })).toBe('check');
    });
    it('a secret scan that did not run green', async () => {
      for (const scan of ['skipped', 'failure', null])
        expect(await planOf({ steps: steps('success', scan) })).toBe('check');
      expect(await planOf({ steps: steps().filter((s) => s.name !== SCAN_STEP) })).toBe('check');
    });
    it('a fixture suite that failed, was cancelled or is missing', async () => {
      for (const f of ['failure', 'cancelled', null])
        expect(await planOf({ steps: steps(f) })).toBe('check');
      expect(await planOf({ steps: steps().filter((s) => s.name !== FIXTURE_STEP) })).toBe('check');
    });
    it('a check run whose link names another job', async () => {
      const r = greenRuns().map((x) => (x.id === 101 ? { ...x, details_url: url(999) } : x));
      expect(await planOf({ runs: r })).toBe('check');
      const none = greenRuns().map((x) => (x.id === 101 ? { ...x, details_url: undefined } : x));
      expect(await planOf({ runs: none })).toBe('check');
    });
  });

  describe('the tested-tree notice', () => {
    it('exactly one: a second (say, printed by a test) is a forgery to refuse, not to pick between', async () =>
      expect(await planOf({ notes: [note(), note()] })).toBe('check'));
    it('on ci.yml, as a notice, a 40-hex tree', async () => {
      expect(await planOf({ notes: [note(TREE, { path: 'scripts/src/x.ts' })] })).toBe('check');
      expect(await planOf({ notes: [note(TREE, { annotation_level: 'warning' })] })).toBe('check');
      expect(await planOf({ notes: [note(`${TREE}\n`)] })).toBe('check');
      expect(await planOf({ notes: [note('')] })).toBe('check');
    });
    it('other annotations are ignored', async () =>
      expect(
        await planOf({
          notes: [
            note(),
            { title: 'Mailroom fixture suite skipped', message: 'x', path: TREE_PATH },
          ],
        }),
      ).toBe('skip'));
  });

  describe('which PR', () => {
    it('the merged PR whose squash is this commit', async () => {
      expect(await planOf({ pulls: [{ ...merged, merge_commit_sha: OTHER }] })).toBe('check');
      expect(await planOf({ pulls: [{ ...merged, merged_at: null }] })).toBe('check');
    });
    it('the dispatch preview: the one open PR whose head is the commit', async () => {
      const open = {
        number: 9,
        state: 'open',
        merged_at: null,
        merge_commit_sha: OTHER,
        head: { sha: SHA },
      };
      const { api } = fakeApi({
        [`GET /repos/o/r/commits/${SHA}/pulls`]: () => [open],
        [`GET /repos/o/r/commits/${SHA}/check-runs`]: () => ({
          check_runs: greenRuns().map((r) => ({ ...r, head_sha: SHA })),
        }),
        'GET /repos/o/r/actions/runs/': () => ({
          path: PR_WORKFLOW,
          event: 'pull_request',
          conclusion: 'success',
          head_sha: SHA,
        }),
        'GET /repos/o/r/check-runs/': () => [note()],
        'GET /repos/o/r/actions/jobs/': () => ({ conclusion: 'success', steps: steps() }),
      });
      expect((await plan(api, 'o/r', SHA, TREE)).plan).toBe('skip');
      expect(await planOf({ pulls: [{ ...open, head: { sha: OTHER } }] })).toBe('check');
    });
    it('two candidates is no answer', async () =>
      expect(await planOf({ pulls: [merged, merged] })).toBe('check'));
  });

  describe('re-runs and pages', () => {
    it('the newest attempt per name decides within a suite', async () => {
      const failedFirst = [
        checkRun(90, 'ci / check', { conclusion: 'failure', details_url: url(90) }),
        ...greenRuns(),
      ];
      expect(await planOf({ runs: failedFirst })).toBe('skip');
      const failedLast = [
        ...greenRuns(),
        checkRun(110, 'ci / test-app-2', { conclusion: 'failure' }),
      ];
      expect(await planOf({ runs: failedLast })).toBe('check');
    });
    it('the newest full suite decides: an older green suite never outvotes a newer red one', async () => {
      const older = greenRuns().map((r) => ({
        ...r,
        id: r.id - 50,
        details_url: url(r.id - 50),
        check_suite: { id: 40 },
      }));
      const newerRed = greenRuns().map((r) => (r.id === 102 ? { ...r, conclusion: 'failure' } : r));
      expect(await planOf({ runs: [...older, ...newerRed] })).toBe('check');
    });
    it('reads past the first page', async () => {
      const filler = Array.from({ length: 100 }, (_, i) =>
        checkRun(1000 + i, `other ${i}`, { check_suite: { id: 77 } }),
      );
      expect(await planOf({ runs: [filler, greenRuns()] })).toBe('skip');
    });
    it('a failing later page, or too many pages, is check', async () => {
      const filler = (n: number) =>
        Array.from({ length: 100 }, (_, i) =>
          checkRun(n * 1000 + i, `o ${i}`, { check_suite: { id: 77 } }),
        );
      const { api } = fakeApi({
        'GET /repos/o/r/commits/aaaa': () => [merged],
        [`GET /repos/o/r/commits/${HEAD}/check-runs`]: ({ path }) => {
          if (path.endsWith('page=1')) return { check_runs: filler(1) };
          throw ghError(502);
        },
      });
      expect((await plan(api, 'o/r', SHA, TREE)).plan).toBe('check');
      expect(await planOf({ runs: [1, 2, 3, 4, 5, 6].map(filler) })).toBe('check');
    });
  });

  it('turns any API error into check, with a warning', async () => {
    for (const fail of [
      () => {
        throw ghError(500);
      },
      () => {
        throw new Error('fetch failed');
      },
    ]) {
      const lines: string[] = [];
      const { api } = fakeApi({ 'GET /repos/o/r/commits/': fail });
      expect((await plan(api, 'o/r', SHA, TREE, (l) => lines.push(l))).plan).toBe('check');
      expect(lines.some((l) => l.startsWith('::warning::'))).toBe(true);
    }
    expect(
      await planOf({
        notes: undefined,
        pulls: () => {
          throw ghError(403);
        },
      }),
    ).toBe('check');
  });
});

describe('greenSuite', () => {
  it('ignores runs from other apps when grouping', () => {
    const forged = checkRun(500, 'ci / check', { app: { slug: 'aperture-cc-bot' } });
    expect(greenSuite([...greenRuns(), forged], HEAD)?.get(CHECK_JOB)?.id).toBe(101);
  });
});

describe('run (the CLI)', () => {
  const ok = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
  const cli = async (argv: string[], env: Record<string, string> = ok, tree = () => TREE) => {
    const out: string[] = [];
    const log: string[] = [];
    const code = await run({
      argv,
      env,
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
      tree,
      write: (p) => out.push(p),
      log: (l) => log.push(l),
    });
    return { code, out, log };
  };

  it('refuses misuse and writes nothing', async () => {
    for (const [argv, env] of [
      [[], ok],
      [['abc'], ok],
      [[SHA, 'extra'], ok],
      [[SHA.toUpperCase()], ok],
      [[SHA], { GITHUB_REPOSITORY: 'o/r' }],
      [[SHA], { GITHUB_TOKEN: 't' }],
    ] as [string[], Record<string, string>][]) {
      const r = await cli(argv, env);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
    }
  });

  it('writes the bare plan once; a network failure is check', async () => {
    const r = await cli([SHA]);
    expect(r).toMatchObject({ code: 0, out: ['check'] });
    expect(r.log.at(-1)).toMatch(/^Check plan: check — /);
  });

  it('a git failure is check, not a crash', async () => {
    const r = await cli([SHA], ok, () => {
      throw new Error('bad object');
    });
    expect(r).toMatchObject({ code: 0, out: ['check'] });
  });
});

describe('pins against the workflows and the docs', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const ci = read('.github/workflows/ci.yml');

  it('ci.yml prints the notice inline, once, on PR runs, under the names the module reads', () => {
    const marker =
      'run: echo "::notice file=.github/workflows/ci.yml,line=1,title=tested-tree::$(git rev-parse HEAD^{tree})"';
    expect(ci.split(marker)).toHaveLength(2);
    expect(ci.match(/tested-tree/g)?.length).toBeGreaterThanOrEqual(1);
    expect(ci).toContain(`- name: ${FIXTURE_STEP}\n`);
    expect(ci).toContain(`- name: ${SCAN_STEP}\n`);
    expect(TREE_PATH).toBe('.github/workflows/ci.yml');
  });

  it('REQUIRED_CHECKS are pr.yml’s `ci` call’s jobs, and the ruleset INFRA §9 records', () => {
    expect(read('.github/workflows/pr.yml')).toMatch(
      /\n {2}ci:\n {4}uses: \.\/\.github\/workflows\/ci\.yml/,
    );
    expect(ci).toMatch(/\n {2}check:/);
    expect(ci).toContain('name: test-app-${{ matrix.shard }}');
    expect(ci).toContain('shard: [1, 2]');
    const infra = read('docs/arch/INFRA.md');
    for (const name of REQUIRED_CHECKS) expect(infra).toContain(`\`${name}\``);
  });

  it('runIdOf / treeOf read what GitHub and git give', () => {
    expect(runIdOf(url(5, 43336996582))).toBe('43336996582');
    expect(runIdOf('https://github.com/o/r/pull/3')).toBeUndefined();
    expect(treeOf('HEAD')).toMatch(/^[0-9a-f]{40}$/);
  });
});
