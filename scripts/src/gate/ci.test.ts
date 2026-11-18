import { describe, expect, it } from 'vitest';
import { fakeRun } from '../bot/fakes.ts';
import type { Run } from '../bot/sh.ts';
import { check, main, pick, verdict, type GhRun } from './ci.ts';

const SHA = '35fe83b8b91cfe2d445e94e1e0e9f08ce81d35b4';
const r = (over: Partial<GhRun>): GhRun => ({
  databaseId: 1,
  workflowName: 'Branch',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  createdAt: '2026-11-17T22:00:00Z',
  url: 'https://github.com/x/runs/1',
  ...over,
});

describe('pick', () => {
  it('the PR run wins over a Branch run; the newest of each; nothing else counts', () => {
    const branch = r({ databaseId: 1 });
    const pr = r({ databaseId: 2, workflowName: 'PR', event: 'pull_request' });
    const older = r({
      databaseId: 3,
      workflowName: 'PR',
      event: 'pull_request',
      createdAt: '2026-11-17T21:00:00Z',
    });
    expect(pick([branch, older, pr])!.databaseId).toBe(2);
    expect(pick([branch])!.databaseId).toBe(1);
    expect(
      pick([
        r({ workflowName: 'Deploy' }),
        r({ workflowName: 'Dev deploy', event: 'workflow_dispatch' }),
      ]),
    ).toBe(undefined);
  });
});

describe('verdict', () => {
  it('green 0, running or missing 75, anything else 1 with the jobs named', () => {
    expect(verdict(SHA, r({})).code).toBe(0);
    expect(verdict(SHA, r({ status: 'in_progress', conclusion: '' })).code).toBe(75);
    expect(verdict(SHA, undefined)).toEqual({
      code: 75,
      line: expect.stringMatching(/^35fe83b8: no PR or Branch run/),
    });
    const red = verdict(SHA, r({ conclusion: 'failure' }), ['branch / check']);
    expect(red).toEqual({ code: 1, line: expect.stringContaining('failure (branch / check)') });
    expect(verdict(SHA, r({ conclusion: 'cancelled' })).code).toBe(1);
  });
});

describe('main', () => {
  const list = (runs: GhRun[]) => JSON.stringify(runs);

  it('reads HEAD, names the failed jobs of a red run', async () => {
    const { run } = fakeRun([
      ['git rev-parse --verify HEAD^{commit}', SHA],
      [`gh run list --commit ${SHA}`, list([r({ conclusion: 'failure' })])],
      [
        'gh run view 1 --json jobs',
        JSON.stringify({
          jobs: [
            { name: 'branch / check', conclusion: 'failure' },
            { name: 'branch / test-app-1', conclusion: 'success' },
          ],
        }),
      ],
    ]);
    const out: string[] = [];
    expect(
      await main(
        [],
        run,
        async () => {},
        (l) => out.push(l),
      ),
    ).toBe(1);
    expect(out[0]).toMatch(/Branch run 1 on 35fe83b8: failure \(branch \/ check\)/);
  });

  // The miss check (miss.ts) runs after a failed verdict's line, and never changes the exit code.
  const red = (conclusion: string) =>
    fakeRun([
      ['git rev-parse --verify HEAD^{commit}', SHA],
      [`gh run list --commit ${SHA}`, list([r({ conclusion })])],
      ['gh run view 1 --json jobs', JSON.stringify({ jobs: [] })],
    ]).run;
  const go = async (
    conclusion: string,
    miss: Parameters<typeof main>[5],
    out: string[],
  ): Promise<number> =>
    main(
      [],
      red(conclusion),
      async () => {},
      (l) => out.push(l),
      Date.now,
      miss,
    );

  it('a failed run: the verdict line first, then the miss check; its error is printed, the exit stays 1', async () => {
    const out: string[] = [];
    const seen: unknown[] = [];
    expect(
      await go(
        'failure',
        async (run, sha) => {
          seen.push([run.databaseId, sha]);
          out.push('!! miss');
          return null;
        },
        out,
      ),
    ).toBe(1);
    expect(seen).toEqual([[1, SHA]]);
    expect(out).toEqual([expect.stringMatching(/: failure/), '!! miss']);
    const broken: string[] = [];
    const boom = async () => {
      throw new Error('gh: log not found');
    };
    expect(await go('failure', boom, broken)).toBe(1);
    expect(broken[1]).toBe('gate:ci — miss check failed: gh: log not found (the verdict stands)');
  });

  it.each([['cancelled'], ['success'], ['timed_out']])(
    'a %s run has no miss check',
    async (conclusion) => {
      const out: string[] = [];
      let called = false;
      await go(
        conclusion,
        async () => {
          called = true;
          return null;
        },
        out,
      );
      expect(called).toBe(false);
    },
  );

  it('--wait polls until the run finishes', async () => {
    let n = 0;
    const { run } = fakeRun([
      [`git rev-parse --verify ${SHA}`, SHA],
      [
        `gh run list --commit ${SHA}`,
        () => list([n++ < 2 ? r({ status: 'in_progress', conclusion: '' }) : r({})]),
      ],
    ]);
    const slept: number[] = [];
    expect(
      await main(
        ['--wait', '--sha', SHA],
        run,
        async (ms) => void slept.push(ms),
        () => {},
      ),
    ).toBe(0);
    expect(slept).toEqual([30_000, 30_000]);
  });

  it('--wait gives up at the timeout with 75; without --wait one look', async () => {
    const { run } = fakeRun([
      [`git rev-parse --verify ${SHA}`, SHA],
      [`gh run list --commit ${SHA}`, list([])],
    ]);
    const slept: number[] = [];
    let t = 0;
    expect(
      await main(
        ['--wait', '--sha', SHA, '--timeout', '60'],
        run,
        async (ms) => void (slept.push(ms), (t += ms)),
        () => {},
        () => t,
      ),
    ).toBe(75);
    expect(slept).toEqual([30_000, 30_000]);
    // a gh that takes 50 s each look counts too: one sleep, then the timeout
    const slow = fakeRun([
      [`git rev-parse --verify ${SHA}`, SHA],
      [`gh run list --commit ${SHA}`, () => ((t += 50_000), list([]))],
    ]);
    const naps: number[] = [];
    t = 0;
    expect(
      await main(
        ['--wait', '--sha', SHA, '--timeout', '60'],
        slow.run,
        async (ms) => void (naps.push(ms), (t += ms)),
        () => {},
        () => t,
      ),
    ).toBe(75);
    expect(naps).toEqual([30_000]);
    expect(
      await main(
        ['--sha', SHA],
        run,
        async () => {},
        () => {},
      ),
    ).toBe(75);
  });

  it('every gh call carries a timeout, so a hung gh is a failure', () => {
    const seen: unknown[] = [];
    const run = ((_cmd: string, args: string[], opts?: unknown) => {
      seen.push(opts);
      return args[1] === 'list'
        ? JSON.stringify([r({ conclusion: 'failure' })])
        : JSON.stringify({ jobs: [] });
    }) as Run;
    check(run, SHA);
    expect(seen).toEqual([{ timeoutMs: 60_000 }, { timeoutMs: 60_000 }]);
  });

  it('an abbreviated sha is resolved to the full one before gh sees it', async () => {
    const { run, calls } = fakeRun([
      [`git rev-parse --verify ${SHA.slice(0, 7)}^{commit}`, SHA],
      [`gh run list --commit ${SHA}`, list([r({})])],
    ]);
    expect(
      await main(
        ['--sha', SHA.slice(0, 7)],
        run,
        async () => {},
        () => {},
      ),
    ).toBe(0);
    expect(calls.at(-1)!.args).toContain(SHA);
  });

  it('gh failing is no verdict (2), never red; --wait retries it', async () => {
    let n = 0;
    const { run } = fakeRun([
      [`git rev-parse --verify ${SHA}`, SHA],
      [
        `gh run list --commit ${SHA}`,
        () => {
          if (n++ < 1) throw new Error('gh: could not resolve host');
          return list([r({})]);
        },
      ],
    ]);
    const out: string[] = [];
    expect(
      await main(
        ['--wait', '--sha', SHA],
        run,
        async () => {},
        (l) => out.push(l),
      ),
    ).toBe(0);
    expect(out[0]).toMatch(/gh failed \(gh: could not resolve host\): retrying/);
    const down = fakeRun([
      [`git rev-parse --verify ${SHA}`, SHA],
      [
        `gh run list`,
        () => {
          throw new Error('gh: not logged in');
        },
      ],
    ]);
    const lines: string[] = [];
    expect(
      await main(
        ['--sha', SHA],
        down.run,
        async () => {},
        (l) => lines.push(l),
      ),
    ).toBe(2);
    expect(lines).toEqual(['gate:ci — gh failed: gh: not logged in']);
  });

  it('refuses a bad flag or sha, and --help runs nothing', async () => {
    const { run, calls } = fakeRun([]);
    expect(
      await main(
        ['--sha', 'HEAD;rm'],
        run,
        async () => {},
        () => {},
      ),
    ).toBe(2);
    expect(
      await main(
        ['--help'],
        run,
        async () => {},
        () => {},
      ),
    ).toBe(0);
    expect(calls).toEqual([]);
  });
});
