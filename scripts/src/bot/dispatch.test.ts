import { describe, expect, it } from 'vitest';
import { currentBase, deployTitle } from './deploy-dev.ts';
import { mainInFlight } from './main-pending.ts';
import type { Run } from './dispatch.ts';
import { dispatchAndWait } from './dispatch.ts';
import { fakeApi, fakeClock } from './fakes.ts';

const R = '/repos/radatta/aperture';
const SHA = 'c'.repeat(40);
const quiet = () => undefined;

const run = (id: number, title: string, createdMs: number, extra: Partial<Run> = {}): Run => ({
  id,
  display_title: title,
  created_at: new Date(createdMs).toISOString(),
  status: 'queued',
  conclusion: null,
  html_url: `https://github.com/radatta/aperture/actions/runs/${id}`,
  ...extra,
});

describe('dispatchAndWait', () => {
  it('dispatches on main and follows the run whose title matches exactly', async () => {
    const clock = fakeClock();
    const t0 = clock.now();
    let polls = 0;
    const g = fakeApi({
      [`POST ${R}/actions/workflows/deploy-dev.yml/dispatches`]: () => undefined,
      [`GET ${R}/actions/workflows/deploy-dev.yml/runs`]: () => ({
        workflow_runs: [
          run(1, deployTitle(SHA, 'ci-bot-old'), t0 - 3600_000), // older run of the same sha, other key
          run(2, deployTitle(SHA, 'ci-bot-k1') + ' ', t0), // near miss
          run(3, deployTitle(SHA, 'ci-bot-k1'), t0),
        ],
      }),
      [`GET ${R}/actions/runs/3`]: () =>
        ++polls < 3
          ? run(3, '', t0, { status: 'in_progress' })
          : run(3, '', t0, { status: 'completed', conclusion: 'success' }),
    });
    const r = await dispatchAndWait(g.api, clock, {
      workflow: 'deploy-dev.yml',
      inputs: { sha: SHA },
      key: 'ci-bot-k1',
      title: (k) => deployTitle(SHA, k),
      timeoutMs: 60 * 60_000,
      log: quiet,
    });
    expect(r.id).toBe(3);
    expect(r.conclusion).toBe('success');
    expect(g.calls[0]?.body).toEqual({ ref: 'main', inputs: { sha: SHA, key: 'ci-bot-k1' } });
  });

  it('ignores a same-title run created before the dispatch window', async () => {
    const clock = fakeClock();
    const stale = run(9, 'dev-logs k', clock.now() - 2 * 60 * 60_000, {
      status: 'completed',
      conclusion: 'success',
    });
    const g = fakeApi({
      [`POST ${R}/actions/workflows/fetch-dev-logs.yml/dispatches`]: () => undefined,
      [`GET ${R}/actions/workflows/fetch-dev-logs.yml/runs`]: () => ({ workflow_runs: [stale] }),
    });
    await expect(
      dispatchAndWait(g.api, clock, {
        workflow: 'fetch-dev-logs.yml',
        inputs: {},
        key: 'k',
        title: (k) => `dev-logs ${k}`,
        timeoutMs: 2 * 60_000,
        log: quiet,
      }),
    ).rejects.toThrow(/never appeared/);
  });

  it('backs off 5 s → 30 s between polls', async () => {
    const clock = fakeClock();
    const waits: number[] = [];
    const sleep = clock.sleep;
    clock.sleep = async (ms) => {
      waits.push(ms);
      await sleep(ms);
    };
    const g = fakeApi({
      [`POST ${R}/actions/workflows/x.yml/dispatches`]: () => undefined,
      [`GET ${R}/actions/workflows/x.yml/runs`]: () => ({ workflow_runs: [] }),
    });
    await dispatchAndWait(g.api, clock, {
      workflow: 'x.yml',
      inputs: {},
      key: 'k',
      title: (k) => k,
      timeoutMs: 3 * 60_000,
      log: quiet,
    }).catch(() => undefined);
    expect(waits.slice(0, 5)).toEqual([5000, 10000, 20000, 30000, 30000]);
  });

  it('retries a cancelled run once, under a fresh key so titles stay unique', async () => {
    const clock = fakeClock();
    const t0 = clock.now();
    const titles: string[] = [];
    const g = fakeApi({
      [`POST ${R}/actions/workflows/deploy-dev.yml/dispatches`]: (c) => {
        titles.push(deployTitle(SHA, (c.body as { inputs: { key: string } }).inputs.key));
        return undefined;
      },
      [`GET ${R}/actions/workflows/deploy-dev.yml/runs`]: () => ({
        workflow_runs: titles.map((t, i) => run(10 + i, t, t0)),
      }),
      [`GET ${R}/actions/runs/10`]: () =>
        run(10, titles[0] ?? '', t0, { status: 'completed', conclusion: 'cancelled' }),
      [`GET ${R}/actions/runs/11`]: () =>
        run(11, titles[1] ?? '', t0, { status: 'completed', conclusion: 'success' }),
    });
    const r = await dispatchAndWait(g.api, clock, {
      workflow: 'deploy-dev.yml',
      inputs: { sha: SHA },
      key: 'k',
      title: (k) => deployTitle(SHA, k),
      timeoutMs: 30 * 60_000,
      log: quiet,
    });
    expect(r.id).toBe(11);
    expect(titles).toEqual([deployTitle(SHA, 'k'), deployTitle(SHA, 'k-r')]);
  });
});

describe('deploy-dev run-name contract', () => {
  it('is exactly `deploy-dev <40-hex sha> <key>` — dev-e2e matches it', () => {
    expect(deployTitle(SHA, 'ci-bot-mgq1')).toMatch(/^deploy-dev ([0-9a-f]{40}) (\S+)$/);
  });
});

describe('currentBase', () => {
  // Each source: runs newest first, and per run its jobs. Job names as GitHub renders reusable-workflow calls.
  type J = {
    name: string;
    status: string;
    conclusion: string | null;
    completed_at: string | null;
    steps?: { name: string; conclusion: string | null }[];
  };
  const job = (
    name: string,
    conclusion: string | null,
    at: string | null,
    status = 'completed',
    steps?: J['steps'],
  ): J => ({ name, status, conclusion, completed_at: at, ...(steps ? { steps } : {}) });
  const world = (
    main: [Partial<Run>, J[]][],
    dispatched: [Partial<Run>, J[]][],
    devPushes: [Partial<Run>, J[]][] = [],
  ) => {
    const jobs = new Map<number, J[]>();
    let id = 1;
    const toRuns = (src: [Partial<Run>, J[]][]) =>
      src.map(([r, js]) => {
        const rid = id++;
        jobs.set(rid, js);
        return { ...r, id: rid };
      });
    const m = toRuns(main);
    const d = toRuns(dispatched);
    const dv = toRuns(devPushes);
    // Pages of per_page, as GitHub serves them.
    const page = (path: string, rs: unknown[]) => {
      const n = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
      const per = Number(/per_page=(\d+)/.exec(path)?.[1] ?? 30);
      return rs.slice((n - 1) * per, n * per);
    };
    return fakeApi({
      [`GET ${R}/actions/workflows/deploy.yml/runs`]: (c) => ({
        workflow_runs: page(c.path, c.path.includes('branch=dev') ? dv : m),
      }),
      [`GET ${R}/actions/workflows/deploy-dev.yml/runs`]: (c) => ({
        workflow_runs: page(c.path, d),
      }),
      [`GET ${R}/actions/runs/`]: (c) => ({
        jobs: jobs.get(Number(/runs\/(\d+)\/jobs/.exec(c.path)?.[1])) ?? [],
      }),
    }).api;
  };
  const T = (h: number) => `2026-10-13T${String(h).padStart(2, '0')}:00:00Z`;
  // `cdk`: whether the dev job's `Deploy stacks` step ran (a full deploy) or was skipped (app/docs-only).
  const mainRun = (
    devAt: string,
    devConclusion = 'success',
    prodAt = T(23),
    cdk = true,
  ): [Partial<Run>, J[]] => [
    { display_title: 'x' },
    [
      job('check / check', 'success', devAt),
      job('deploy-dev / deploy', devConclusion, devAt, 'completed', [
        { name: 'Deploy stacks', conclusion: cdk ? 'success' : 'skipped' },
      ]),
      job('deploy-prod / deploy', 'success', prodAt),
    ],
  ];
  const dispatch = (
    sha: string,
    devAt: string | null,
    conclusion: string | null = 'success',
    status = 'completed',
  ): [Partial<Run>, J[]] => [
    { display_title: deployTitle(sha, 'k') },
    [job('verify', 'success', devAt), job('deploy / deploy', conclusion, devAt, status)],
  ];

  it('is unknown while a merge is still to land on the slot, whatever main deployed last', async () => {
    const queued: [Partial<Run>, J[]] = [{ status: 'queued' }, []];
    const checking: [Partial<Run>, J[]] = [
      { status: 'in_progress' },
      [job('check / check', null, null, 'in_progress')],
    ];
    for (const inFlight of [queued, checking])
      expect(await currentBase(world([inFlight, mainRun(T(12))], [dispatch(SHA, T(11))]))).toBe(
        'unknown',
      );
    // landed on dev, prod still going: dev serves it
    const landed: [Partial<Run>, J[]] = [
      { status: 'in_progress' },
      [
        job('deploy-dev / deploy', 'success', T(13), 'completed', [
          { name: 'Deploy stacks', conclusion: 'success' },
        ]),
        job('deploy-prod / deploy', null, null, 'in_progress'),
      ],
    ];
    expect(await currentBase(world([landed], [dispatch(SHA, T(11))]))).toBe('');
    // a run that skips devb's deploy (no shape change) never holds devb's base
    const skipsB: [Partial<Run>, J[]] = [
      { status: 'in_progress' },
      [job('deploy-devb', 'skipped', T(13)), job('deploy-dev / deploy', null, null, 'in_progress')],
    ];
    expect(await mainInFlight(world([skipsB], []), 'devb')).toBe(false);
    expect(await mainInFlight(world([skipsB], []), 'dev')).toBe(true);
  });

  it('is the dispatched sha when its dev job finished after main’s dev job', async () => {
    expect(await currentBase(world([mainRun(T(10))], [dispatch(SHA, T(11))]))).toBe(SHA);
  });

  it('judges main by its dev job, not the run — prod finishing later must not hide a dispatch', async () => {
    // main's dev job at 10:00, its prod job at 23:00; the dispatch landed on dev at 11:00.
    expect(
      await currentBase(world([mainRun(T(10), 'success', T(23))], [dispatch(SHA, T(11))])),
    ).toBe(SHA);
  });

  it('is main ("") when main’s dev job is the newest, or nothing was ever dispatched', async () => {
    expect(await currentBase(world([mainRun(T(12))], [dispatch(SHA, T(11))]))).toBe('');
    expect(await currentBase(world([mainRun(T(12))], []))).toBe('');
    expect(await currentBase(world([], []))).toBe('');
  });

  it('skips runs whose dev job never ran (verify or check failed)', async () => {
    const failedVerify: [Partial<Run>, J[]] = [
      { display_title: deployTitle('d'.repeat(40), 'k') },
      [job('verify', 'failure', T(13)), job('deploy / deploy', 'skipped', null)],
    ];
    expect(await currentBase(world([mainRun(T(10))], [failedVerify, dispatch(SHA, T(11))]))).toBe(
      SHA,
    );
  });

  it('is "unknown" (→ full) when the newest dev job failed — dev may hold a half-applied stack', async () => {
    expect(await currentBase(world([mainRun(T(10))], [dispatch(SHA, T(11), 'failure')]))).toBe(
      'unknown',
    );
    expect(await currentBase(world([mainRun(T(12), 'failure')], [dispatch(SHA, T(11))]))).toBe(
      'unknown',
    );
  });

  it('is "unknown" while a dev job is still running', async () => {
    expect(
      await currentBase(world([mainRun(T(10))], [dispatch(SHA, null, null, 'in_progress')])),
    ).toBe('unknown');
  });

  it('is "unknown" on an unparsable title or an API error', async () => {
    const odd: [Partial<Run>, J[]] = [
      { display_title: 'something else' },
      [job('deploy / deploy', 'success', T(11))],
    ];
    expect(await currentBase(world([mainRun(T(10))], [odd]))).toBe('unknown');
    expect(await currentBase(fakeApi({}).api)).toBe('unknown');
  });

  it('looks past an app-only main merge — it never touched the infra a dispatch put on dev', async () => {
    // Dispatch X (11:00) put its infra on dev; an app-only main merge deployed at 12:00.
    expect(
      await currentBase(world([mainRun(T(12), 'success', T(23), false)], [dispatch(SHA, T(11))])),
    ).toBe(SHA);
    // A full main deploy after the dispatch does reset dev to main.
    expect(
      await currentBase(
        world(
          [mainRun(T(12), 'success', T(23), false), mainRun('2026-10-13T11:30:00Z')],
          [dispatch(SHA, T(11))],
        ),
      ),
    ).toBe('');
  });

  it('is "unknown" when five full pages hold no deciding job — the decider is further back', async () => {
    const appOnly = Array.from({ length: 50 }, () => mainRun(T(12), 'success', T(23), false));
    expect(await currentBase(world(appOnly, []))).toBe('unknown');
    // a deciding job on page 2 is found
    expect(await currentBase(world([...appOnly.slice(0, 12), mainRun(T(10))], []))).toBe('');
  });

  it('skips a dev job GitHub never expanded (verify failed) or never listed', async () => {
    const unexpanded: [Partial<Run>, J[]] = [
      { display_title: deployTitle('d'.repeat(40), 'k') },
      [job('verify', 'failure', T(13)), job('deploy', 'skipped', null)],
    ];
    const unlisted: [Partial<Run>, J[]] = [
      { display_title: deployTitle('f'.repeat(40), 'k') },
      [job('verify', 'failure', T(14))],
    ];
    expect(
      await currentBase(world([mainRun(T(10))], [unlisted, unexpanded, dispatch(SHA, T(11))])),
    ).toBe(SHA);
  });

  it('is "unknown" when the user’s `dev` push is the newest dev deploy — its branch is unknown here', async () => {
    const devPush = (at: string, fast = false): [Partial<Run>, J[]] => [
      { display_title: 'x' },
      [
        job('deploy-dev', fast ? 'skipped' : 'success', fast ? null : at),
        job('deploy-dev-fast', fast ? 'success' : 'skipped', fast ? at : null),
      ],
    ];
    expect(
      await currentBase(world([mainRun(T(10))], [dispatch(SHA, T(11))], [devPush(T(12))])),
    ).toBe('unknown');
    expect(
      await currentBase(world([mainRun(T(10))], [dispatch(SHA, T(11))], [devPush(T(12), true)])),
    ).toBe('unknown');
    // An older dev push doesn't matter.
    expect(
      await currentBase(world([mainRun(T(10))], [dispatch(SHA, T(11))], [devPush(T(9))])),
    ).toBe(SHA);
  });

  // Slot B: its own jobs (deploy.yml's `deploy-devb`, deploy-dev.yml's `deploy-b`), and a main job's base is the sha it
  // deployed — main's lane moves devb only on a shape change, so devb's code may be older than main's head.
  describe('on slot B', () => {
    const mainB = (sha: string, at: string, conclusion = 'success'): [Partial<Run>, J[]] => [
      { display_title: 'x', head_sha: sha },
      [
        job('deploy-dev / deploy', 'success', at, 'completed', [
          { name: 'Deploy stacks', conclusion: 'success' },
        ]),
        job('deploy-devb / deploy', conclusion, at, 'completed', [
          { name: 'Deploy stacks', conclusion: conclusion === 'success' ? 'success' : 'failure' },
        ]),
      ],
    ];
    const mainNoB = (sha: string, at: string): [Partial<Run>, J[]] => [
      { display_title: 'x', head_sha: sha },
      [job('deploy-dev / deploy', 'success', at), job('deploy-devb', 'skipped', null)],
    ];
    const dispatchB = (sha: string, at: string, conclusion = 'success'): [Partial<Run>, J[]] => [
      { display_title: deployTitle(sha, 'k') },
      [
        job('verify', 'success', at),
        job('deploy', 'skipped', null),
        job('deploy-b / deploy', conclusion, at),
      ],
    ];
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    const M = 'c'.repeat(40);

    it('is unknown (a full deploy) before devb has ever been deployed', async () => {
      expect(await currentBase(world([mainNoB(M, T(10))], [dispatch(A, T(11))]), 'devb')).toBe(
        'unknown',
      );
    });

    it("takes the sha main's devb job deployed, not main's head", async () => {
      expect(
        await currentBase(world([mainNoB('d'.repeat(40), T(12)), mainB(M, T(10))], []), 'devb'),
      ).toBe(M);
    });

    it("takes the newest devb dispatch's sha, ignoring slot A's dispatches", async () => {
      expect(
        await currentBase(
          world([mainB(M, T(9))], [dispatch(A, T(12)), dispatchB(B, T(11))]),
          'devb',
        ),
      ).toBe(B);
      // and slot A ignores devb's
      expect(
        await currentBase(
          world([mainB(M, T(9))], [dispatchB(B, T(12)), dispatch(A, T(11))]),
          'dev',
        ),
      ).toBe(A);
    });

    it('finds a devb dispatch behind a page of slot A ones', async () => {
      const aRuns = Array.from({ length: 12 }, () => dispatch(A, T(12)));
      expect(await currentBase(world([], [...aRuns, dispatchB(B, T(11))]), 'devb')).toBe(B);
    });

    it('is unknown after a failed devb deploy', async () => {
      expect(await currentBase(world([mainB(M, T(10), 'failure')], []), 'devb')).toBe('unknown');
      expect(await currentBase(world([], [dispatchB(B, T(10), 'failure')]), 'devb')).toBe(
        'unknown',
      );
    });

    it('never reads a `dev` branch push for devb', async () => {
      expect(await currentBase(world([mainB(M, T(9))], [], [mainRun(T(12))]), 'devb')).toBe(M);
    });
  });
});
