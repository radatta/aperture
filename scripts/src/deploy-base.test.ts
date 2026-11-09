import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Diff } from './deploy-base';
import {
  deployedTier,
  gitDiff,
  jobIdOf,
  modeFor,
  outcome,
  run,
  servedBy,
  shapeModeFor,
  slotOfJob,
  SLOTS,
  withTimeout,
} from './deploy-base';
import { fakeApi, ghError } from './bot/fakes';

type Tier = 'full' | 'app' | 'none';

// packages/shared's DEV_SLOTS, read as text: this module runs with no install, so it keeps its own copy.
const sharedSlots = () =>
  JSON.parse(
    (
      /DEV_SLOTS = (\[[^\]]*\])/.exec(
        readFileSync(new URL('../../packages/shared/src/stage.ts', import.meta.url), 'utf8'),
      )?.[1] ?? '[]'
    ).replace(/'/g, '"'),
  ) as string[];
type Row = { sha: string; tier?: Tier; states?: string[]; logUrl?: string };

const step = (name: string, conclusion: string) => ({ name, conclusion });
const stepsFor = (tier: Tier) => [
  step('Deploy stacks', tier === 'full' ? 'success' : 'skipped'),
  step('Publish frontend', tier === 'none' ? 'skipped' : 'success'),
];

// Deployment records, newest first, as GitHub lists them for one environment.
function history(rows: Row[]) {
  const routes: Parameters<typeof fakeApi>[0] = {
    'GET /repos/o/r/deployments?environment=prod': () => rows.map((r, id) => ({ id, sha: r.sha })),
  };
  rows.forEach((r, id) => {
    const logUrl = r.logUrl ?? `https://github.com/o/r/actions/runs/9/job/${1000 + id}`;
    routes[`GET /repos/o/r/deployments/${id}/statuses`] = () =>
      (r.states ?? ['success', 'in_progress', 'queued']).map((state) => ({
        state,
        log_url: logUrl,
      }));
    routes[`GET /repos/o/r/actions/jobs/${1000 + id}`] = () => ({
      steps: stepsFor(r.tier ?? 'full'),
    });
  });
  return fakeApi(routes);
}
const served = (rows: Row[]) => servedBy(history(rows).api, 'o/r', 'prod');

// A tree per commit: the diff is every path whose owner commit sits between the two.
const diffOf =
  (order: [string, string[]][]): Diff =>
  (from, to) => {
    const at = (sha: string) => order.findIndex(([s]) => s === sha);
    return order.slice(at(from) + 1, at(to) + 1).flatMap(([, paths]) => paths);
  };

describe('outcome', () => {
  it('reads the record, with a later failure beating an earlier success', () => {
    expect(outcome([{ state: 'success' }, { state: 'in_progress' }])).toBe('success');
    expect(outcome([{ state: 'inactive' }, { state: 'success' }])).toBe('success');
    expect(outcome([{ state: 'failure' }, { state: 'success' }])).toBe('failure');
    expect(outcome([{ state: 'error' }])).toBe('failure');
    expect(outcome([{ state: 'error' }, { state: 'waiting' }])).toBe('failure'); // a job cancelled while waiting
    expect(outcome([{ state: 'in_progress' }, { state: 'success' }])).toBe('running');
    expect(outcome([{ state: 'queued' }, { state: 'success' }])).toBe('running');
    expect(outcome([{ state: 'in_progress' }, { state: 'queued' }])).toBe('running');
    expect(outcome([{ state: 'inactive' }])).toBe('running');
    expect(outcome([{ state: 'inactive' }, { state: 'failure' }, { state: 'success' }])).toBe(
      'failure',
    );
    expect(outcome([])).toBe('running');
  });
});

describe('deployedTier', () => {
  it('reads the three step patterns', () => {
    expect(deployedTier({ steps: stepsFor('full') })).toBe('full');
    expect(deployedTier({ steps: stepsFor('app') })).toBe('app');
    expect(deployedTier({ steps: stepsFor('none') })).toBe('none');
  });

  it('never reads a shape it does not know as docs-only', () => {
    expect(deployedTier({})).toBe('unknown');
    expect(deployedTier({ steps: [] })).toBe('unknown');
    expect(
      deployedTier({
        steps: [step('Deploy the stacks', 'skipped'), step('Publish frontend', 'skipped')],
      }),
    ).toBe('unknown');
    expect(
      deployedTier({
        steps: [step('Deploy stacks', 'skipped'), step('Publish frontend', 'failure')],
      }),
    ).toBe('unknown');
  });
});

describe('jobIdOf', () => {
  it('takes the job id out of a status log_url', () => {
    expect(jobIdOf('https://github.com/o/r/actions/runs/1/job/42')).toBe('42');
    expect(jobIdOf('https://github.com/o/r/actions/runs/1')).toBeUndefined();
    expect(jobIdOf(undefined)).toBeUndefined();
  });
});

describe('servedBy', () => {
  it('stops at the newest full deploy, older records unread', async () => {
    const { api, calls } = history([{ sha: 'f2' }, { sha: 'f1', states: ['failure'] }]);
    expect(await servedBy(api, 'o/r', 'prod')).toEqual({ infra: 'f2', front: 'f2' });
    expect(calls.some((c) => c.path.includes('deployments/1/'))).toBe(false);
  });

  it('skips a docs-only record, which can never be a base', async () => {
    expect(await served([{ sha: 'd1', tier: 'none' }, { sha: 'f' }])).toEqual({
      infra: 'f',
      front: 'f',
    });
  });

  it('takes the newest publish as front and the full deploy behind it as infra', async () => {
    expect(
      await served([
        { sha: 'd3', tier: 'none' },
        { sha: 'a2', tier: 'app' },
        { sha: 'd2', tier: 'none' },
        { sha: 'a1', tier: 'app' },
        { sha: 'f' },
      ]),
    ).toEqual({ infra: 'f', front: 'a2' });
  });

  it('is unknown when the newest record failed or is still running', async () => {
    expect(await served([{ sha: 'a', states: ['failure', 'in_progress'] }, { sha: 'f' }])).toBe(
      'unknown',
    );
    expect(await served([{ sha: 'a', states: ['in_progress'] }, { sha: 'f' }])).toBe('unknown');
  });

  it('is unknown when a failure sits behind a publish but before any full deploy', async () => {
    expect(
      await served([{ sha: 'a', tier: 'app' }, { sha: 'b', states: ['failure'] }, { sha: 'f' }]),
    ).toBe('unknown');
  });

  it('counts a deployment whose success was later marked inactive', async () => {
    expect(await served([{ sha: 'f', states: ['inactive', 'success', 'queued'] }])).toEqual({
      infra: 'f',
      front: 'f',
    });
  });

  it('is unknown with no history, or only app and docs records in reach', async () => {
    expect(await served([])).toBe('unknown');
    expect(
      await served([
        { sha: 'a', tier: 'app' },
        { sha: 'd', tier: 'none' },
      ]),
    ).toBe('unknown');
  });

  it('is unknown when the status names no job', async () => {
    expect(await served([{ sha: 'f', logUrl: 'https://github.com/o/r/actions/runs/1' }])).toBe(
      'unknown',
    );
  });

  it('is unknown on an API error at any level, naming why', async () => {
    const lines: string[] = [];
    const list = fakeApi({
      'GET /repos/o/r/deployments': () => {
        throw ghError(403);
      },
    });
    expect(await servedBy(list.api, 'o/r', 'prod', (l) => lines.push(l))).toBe('unknown');
    expect(lines.join()).toContain('HTTP 403');

    const job = fakeApi({
      'GET /repos/o/r/deployments?': () => [{ id: 1, sha: 'f' }],
      'GET /repos/o/r/deployments/1/statuses': () => [{ state: 'success', log_url: '/job/7' }],
      'GET /repos/o/r/actions/jobs/7': () => {
        throw ghError(404);
      },
    });
    expect(await servedBy(job.api, 'o/r', 'prod')).toBe('unknown');
  });

  it('reads the environment it was asked about', async () => {
    const { api, calls } = fakeApi({ 'GET /repos/o/r/deployments': () => [] });
    await servedBy(api, 'o/r', 'dev-main');
    expect(calls[0]?.path).toBe('/repos/o/r/deployments?environment=dev-main&per_page=100');
  });
});

// Both dev slots record in dev-main; `job` is the recorded job's name (deploy.yml's call job / the stage job).
type SlotRow = Row & { job: string };
function devMain(rows: SlotRow[]) {
  const routes: Parameters<typeof fakeApi>[0] = {
    'GET /repos/o/r/deployments?environment=dev-main': () =>
      rows.map((r, id) => ({ id, sha: r.sha })),
  };
  rows.forEach((r, id) => {
    routes[`GET /repos/o/r/deployments/${id}/statuses`] = () =>
      (r.states ?? ['success', 'in_progress', 'queued']).map((state) => ({
        state,
        log_url: `https://github.com/o/r/actions/runs/9/job/${1000 + id}`,
      }));
    routes[`GET /repos/o/r/actions/jobs/${1000 + id}`] = () => ({
      name: r.job,
      steps: stepsFor(r.tier ?? 'full'),
    });
  });
  return fakeApi(routes);
}
const A = 'deploy-dev / deploy';
const B = 'deploy-devb / deploy';

describe('servedBy, per dev slot', () => {
  it('keeps its slot list in step with the shared one', () => {
    expect([...SLOTS]).toEqual(sharedSlots());
  });

  it("tells the slots apart by job name, older unnamed records being slot A's", () => {
    expect(slotOfJob(A)).toBe('dev');
    expect(slotOfJob(B)).toBe('devb');
    expect(slotOfJob(undefined)).toBe('dev');
    expect(slotOfJob('deploy-dev')).toBe('dev');
  });

  it("walks past the other slot's records, failed ones included", async () => {
    const rows: SlotRow[] = [
      { sha: 'b2', job: B, states: ['failure'] },
      { sha: 'a2', job: A, tier: 'app' },
      { sha: 'b1', job: B },
      { sha: 'a1', job: A },
    ];
    expect(await servedBy(devMain(rows).api, 'o/r', 'dev-main', undefined, 'dev')).toEqual({
      infra: 'a1',
      front: 'a2',
    });
    expect(await servedBy(devMain(rows).api, 'o/r', 'dev-main', undefined, 'devb')).toBe('unknown'); // its newest failed
    expect(
      await servedBy(devMain(rows.slice(1)).api, 'o/r', 'dev-main', undefined, 'devb'),
    ).toEqual({
      infra: 'b1',
      front: 'b1',
    });
  });

  it('is unknown for devb with no devb record yet (its first main deploy creates or updates it in full)', async () => {
    const rows: SlotRow[] = [{ sha: 'a1', job: A }];
    expect(await servedBy(devMain(rows).api, 'o/r', 'dev-main', undefined, 'devb')).toBe('unknown');
  });

  it("reads each record's job once", async () => {
    const { api, calls } = devMain([{ sha: 'a1', job: A }]);
    await servedBy(api, 'o/r', 'dev-main', undefined, 'dev');
    expect(calls.filter((c) => c.path.includes('/actions/jobs/')).length).toBe(1);
  });
});

describe('shapeModeFor (devb on a main merge)', () => {
  const order: [string, string[]][] = [
    ['f', []],
    ['l1', ['lambdas/z.ts', 'app/x.tsx', 'scripts/y.ts']],
    ['c1', ['cdk/src/lib/app-stack.ts']],
    ['p1', ['pnpm-lock.yaml']],
  ];
  const diff = diffOf(order);
  it('deploys only a shape change: cdk/ or the lockfile', () => {
    expect(shapeModeFor({ infra: 'f', front: 'f' }, 'l1', diff)).toBe('none');
    expect(shapeModeFor({ infra: 'f', front: 'f' }, 'c1', diff)).toBe('full');
    expect(shapeModeFor({ infra: 'c1', front: 'c1' }, 'p1', diff)).toBe('full');
    expect(shapeModeFor({ infra: 'p1', front: 'p1' }, 'p1', diff)).toBe('none');
  });
  it('is full when unknown or when the diff fails', () => {
    expect(shapeModeFor('unknown', 'h', diff)).toBe('full');
    const bad = () => {
      throw new Error('bad object');
    };
    expect(shapeModeFor({ infra: 'f', front: 'f' }, 'h', bad)).toBe('full');
  });
});

describe('modeFor', () => {
  it('is full for an unknown base, without diffing', () => {
    const diff = () => {
      throw new Error('never');
    };
    expect(modeFor('unknown', 'h', diff)).toBe('full');
  });

  it('is full when the diff throws, as with a base git does not have', () => {
    const diff = () => {
      throw new Error('bad object');
    };
    expect(modeFor({ infra: 'f', front: 'f' }, 'h', diff)).toBe('full');
  });

  it('is full for an empty diff, a re-run of what is served', () => {
    expect(modeFor({ infra: 'h', front: 'h' }, 'h', () => [''])).toBe('full');
    const order: [string, string[]][] = [
      ['f', []],
      ['h', ['app/x.tsx']],
    ];
    expect(modeFor({ infra: 'f', front: 'h' }, 'h', diffOf(order))).toBe('full');
  });

  it('classifies infra first, then what the frontend still lacks', () => {
    const order: [string, string[]][] = [
      ['f', []],
      ['a1', ['app/x.tsx']],
      ['d1', ['docs/y.md']],
      ['l1', ['lambdas/z.ts']],
    ];
    const diff = diffOf(order);
    expect(modeFor({ infra: 'f', front: 'f' }, 'a1', diff)).toBe('app');
    expect(modeFor({ infra: 'f', front: 'a1' }, 'd1', diff)).toBe('none');
    expect(modeFor({ infra: 'f', front: 'a1' }, 'l1', diff)).toBe('full');
  });
});

describe('modeFor, on a diff failure', () => {
  it('says why it went full', () => {
    const lines: string[] = [];
    const diff = () => {
      throw new Error('bad object f');
    };
    expect(modeFor({ infra: 'f', front: 'f' }, 'h', diff, (l) => lines.push(l))).toBe('full');
    expect(lines.join()).toContain('bad object f');
  });
});

describe('gitDiff, against a real repo', () => {
  // Isolated from the machine: a GIT_DIR from a hook or `rebase --exec` would aim these at the real repo, and global
  // signing or hooks would change what a commit does.
  const saved = Object.entries(process.env).filter(([k]) => k.startsWith('GIT_'));
  let dir = '';
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
    ).trim();
  beforeAll(() => {
    for (const [k] of saved) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'deploy-base-'));
    git('init', '-q', '-b', 'fixture');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true });
    Object.assign(process.env, Object.fromEntries(saved));
  });
  const commit = () => {
    git('add', '-A');
    git('commit', '-qm', 'x');
    return git('rev-parse', 'HEAD');
  };

  it('classifies a move out of lambdas/ into docs/ by where it came from', () => {
    mkdirSync(join(dir, 'lambdas'));
    mkdirSync(join(dir, 'docs'));
    writeFileSync(
      join(dir, 'lambdas/a.ts'),
      'long enough for rename detection to pair it\n'.repeat(5),
    );
    const before = commit();
    renameSync(join(dir, 'lambdas/a.ts'), join(dir, 'docs/a.md'));
    const after = commit();
    const diff = gitDiff(dir);
    expect(diff(before, after).filter(Boolean).sort()).toEqual(['docs/a.md', 'lambdas/a.ts']);
    expect(modeFor({ infra: before, front: before }, after, diff)).toBe('full');
  });

  it('throws on a base git does not have, which modeFor turns into full', () => {
    const missing = 'a'.repeat(40);
    expect(() => gitDiff(dir)(missing, 'HEAD')).toThrow(/bad object/);
    expect(modeFor({ infra: missing, front: missing }, 'HEAD', gitDiff(dir))).toBe('full');
  });
});

// The bug's shapes, end to end through the walk and the classifier.
describe('the shapes that used to ship a skew', () => {
  const mode = async (rows: Row[], order: [string, string[]][], head: string) =>
    modeFor(await served(rows), head, diffOf(order));

  it('a failed prod deploy, then an app-only merge → full', async () => {
    const order: [string, string[]][] = [
      ['f', []],
      ['A', ['lambdas/a.ts', 'app/a.tsx']],
      ['B', ['app/b.tsx']],
    ];
    expect(
      await mode([{ sha: 'A', states: ['failure', 'in_progress'] }, { sha: 'f' }], order, 'B'),
    ).toBe('full');
  });

  it('a failed prod deploy, then a docs-only merge → full', async () => {
    const order: [string, string[]][] = [
      ['f', []],
      ['A', ['lambdas/a.ts']],
      ['D', ['docs/d.md']],
    ];
    expect(await mode([{ sha: 'A', states: ['failure'] }, { sha: 'f' }], order, 'D')).toBe('full');
  });

  it('prod skipped because dev failed: no record, so the diff reaches back over it', async () => {
    const order: [string, string[]][] = [
      ['f', []],
      ['A', ['lambdas/a.ts']],
      ['B', ['app/b.tsx']],
    ];
    expect(await mode([{ sha: 'f' }], order, 'B')).toBe('full');
  });

  it('cancelled pending runs have no record, so their changes stay in the diff', async () => {
    const order: [string, string[]][] = [
      ['m1', []],
      ['m2', ['lambdas/a.ts']], // cancelled while pending
      ['m3', ['app/b.tsx']], // cancelled while pending
      ['m4', ['app/c.tsx']],
    ];
    expect(await mode([{ sha: 'm1' }], order, 'm4')).toBe('full');
  });

  it('cancelled app-only runs still publish, and only publish', async () => {
    const order: [string, string[]][] = [
      ['m1', []],
      ['m2', ['app/a.tsx']],
      ['m3', ['app/b.tsx']],
    ];
    expect(await mode([{ sha: 'm1' }], order, 'm3')).toBe('app');
  });

  it('a docs chain keeps `none`, with no redundant publish after an app merge', async () => {
    const order: [string, string[]][] = [
      ['f', []],
      ['d1', ['docs/1.md']],
      ['a1', ['app/x.tsx']],
      ['d2', ['docs/2.md']],
    ];
    expect(await mode([{ sha: 'f' }], order, 'd1')).toBe('none');
    expect(await mode([{ sha: 'd1', tier: 'none' }, { sha: 'f' }], order, 'a1')).toBe('app');
    expect(
      await mode(
        [{ sha: 'a1', tier: 'app' }, { sha: 'd1', tier: 'none' }, { sha: 'f' }],
        order,
        'd2',
      ),
    ).toBe('none');
  });
});

// What `x=$(node deploy-base.ts …)` sees: one word on stdout, exit 0, whatever the API does.
describe('run', () => {
  const HEAD = 'a'.repeat(40);
  const go = async (
    fetchImpl: typeof fetch,
    opts: { requestMs?: number; walkMs?: number } = {},
  ) => {
    const writes: string[] = [];
    const lines: string[] = [];
    const code = await run({
      argv: ['prod', HEAD],
      env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
      fetchImpl,
      diff: () => ['app/x.tsx'],
      write: (m) => writes.push(m),
      log: (l) => lines.push(l),
      ...opts,
    });
    return { code, writes, lines: lines.join('\n') };
  };
  const json = (body: unknown) => new Response(JSON.stringify(body));
  // Never answers, and rejects when its signal aborts, as real fetch does.
  const hanging: typeof fetch = (_url, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    });

  it('writes the classified tier once on a good walk', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes('/statuses'))
        return json([{ state: 'success', log_url: 'https://github.com/o/r/actions/runs/1/job/7' }]);
      if (u.includes('/actions/jobs/7')) return json({ steps: stepsFor('full') });
      return json([{ id: 1, sha: 'f' }]);
    };
    expect(await go(fetchImpl)).toMatchObject({ code: 0, writes: ['app'] });
  });

  it('writes full, exit 0, when fetch rejects, and annotates why', async () => {
    const { code, writes, lines } = await go(() => Promise.reject(new Error('socket hang up')));
    expect({ code, writes }).toEqual({ code: 0, writes: ['full'] });
    expect(lines).toContain('::warning::prod: unknown, so full — socket hang up');
  });

  it('writes full on an HTTP error, and on a body that is not JSON', async () => {
    expect(await go(async () => new Response('nope', { status: 500 }))).toMatchObject({
      code: 0,
      writes: ['full'],
    });
    expect(await go(async () => new Response('<html>'))).toMatchObject({
      code: 0,
      writes: ['full'],
    });
  });

  it('writes full when a request hangs, once its timeout fires', async () => {
    expect(await go(hanging, { requestMs: 5 })).toMatchObject({ code: 0, writes: ['full'] });
  });

  it('writes full when a body hangs after the headers came', async () => {
    const stalled: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(c) {
            init?.signal?.addEventListener('abort', () => c.error(init.signal?.reason));
          },
        }),
      );
    expect(await go(stalled, { requestMs: 5 })).toMatchObject({ code: 0, writes: ['full'] });
  });

  it('writes nothing and exits 1 on misuse', async () => {
    const writes: string[] = [];
    const base = {
      fetchImpl: fetch,
      diff: () => [],
      write: (m: string) => writes.push(m),
      log: () => undefined,
    };
    const good = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
    expect(await run({ ...base, argv: ['prod', 'nope'], env: good })).toBe(1);
    expect(await run({ ...base, argv: ['Prod!', HEAD], env: good })).toBe(1);
    expect(await run({ ...base, argv: ['prod', HEAD], env: { GITHUB_REPOSITORY: 'o/r' } })).toBe(1);
    expect(await run({ ...base, argv: ['prod', HEAD], env: { GITHUB_TOKEN: 't' } })).toBe(1);
    expect(await run({ ...base, argv: ['prod', HEAD, '--slot', 'devb'], env: good })).toBe(1);
    expect(await run({ ...base, argv: ['dev-main', HEAD, '--slot', 'devc'], env: good })).toBe(1);
    expect(await run({ ...base, argv: ['dev-main', HEAD, '--slot'], env: good })).toBe(1);
    expect(await run({ ...base, argv: ['dev-main', HEAD, '--slot', 'devb', 'x'], env: good })).toBe(
      1,
    );
    expect(writes).toEqual([]);
  });
});

describe('withTimeout', () => {
  it('shares one walk deadline across requests, so a slow walk ends even when each request is quick', async () => {
    const quick: typeof fetch = (_url, init) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response('[]')), 4);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(init.signal?.reason as Error);
        });
      });
    const timed = withTimeout(quick, 1000, 20);
    await expect(
      (async () => {
        for (let i = 0; i < 100; i++) await timed('https://x.test');
      })(),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

// CI runs this with stock Node and no install: a real import past node: builtins, or syntax Node can't strip, dies here.
describe('the CLI under plain node', () => {
  const cli = fileURLToPath(new URL('./deploy-base.ts', import.meta.url));

  it('loads, and refuses misuse with a non-zero exit', () => {
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [cli, 'prod', 'not-a-sha'], {
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { status: number; stderr: Buffer };
      status = e.status;
      stderr = e.stderr.toString();
    }
    expect(status).toBe(1);
    expect(stderr).toContain('usage: deploy-base.ts');
  });
});
