import { describe, expect, it } from 'vitest';
import type { Job, Run } from './dispatch.ts';
import { fakeApi, ghError } from './fakes.ts';
import { mainPendingGuard, pendingMainDeploy } from './main-pending.ts';

const R = '/repos/radatta/aperture';
const run = (id: number, status = 'in_progress'): Run => ({
  id,
  display_title: `merge ${id}`,
  created_at: '2026-11-17T20:00:00Z',
  status,
  conclusion: status === 'completed' ? 'success' : null,
  html_url: `https://github.com/radatta/aperture/actions/runs/${id}`,
});
const job = (name: string, status: string, conclusion: string | null = null): Job => ({
  name,
  status,
  conclusion,
  completed_at: status === 'completed' ? '2026-11-17T20:05:00Z' : null,
});

function github(runs: Run[], jobs: Record<number, Job[]>) {
  return fakeApi({
    [`GET ${R}/actions/workflows/deploy.yml/runs?`]: (c) => {
      expect(c.path).toContain('event=push&branch=main');
      return { workflow_runs: runs };
    },
    [`GET ${R}/actions/runs/`]: (c) => ({ jobs: jobs[Number(c.path.split('/')[6])] ?? [] }),
  });
}

describe('pendingMainDeploy', () => {
  it('is null with no runs, or only finished ones', async () => {
    expect(await pendingMainDeploy(github([], {}).api, 'dev')).toBeNull();
    const g = github([run(1, 'completed')], { 1: [] });
    expect(await pendingMainDeploy(g.api, 'dev')).toBeNull();
    expect(g.calls.some((c) => c.path.includes('/runs/1/jobs'))).toBe(false); // never reads a finished run's jobs
  });

  it('counts a run still queued in the concurrency group, with no jobs yet, for both slots', async () => {
    const g = github([run(1, 'queued')], { 1: [] });
    expect((await pendingMainDeploy(g.api, 'dev'))?.id).toBe(1);
    expect((await pendingMainDeploy(g.api, 'devb'))?.id).toBe(1);
  });

  it('counts a run still classifying or waiting', async () => {
    const g = github([run(1)], {
      1: [job('changes', 'in_progress'), job('wait-dev', 'queued')],
    });
    expect((await pendingMainDeploy(g.api, 'dev'))?.id).toBe(1);
  });

  it('skips a slot whose wait was skipped: main deploys nothing there', async () => {
    const g = github([run(1)], {
      1: [
        job('changes', 'completed', 'success'),
        job('wait-dev', 'in_progress'),
        job('wait-devb', 'completed', 'skipped'),
      ],
    });
    expect(await pendingMainDeploy(g.api, 'devb')).toBeNull();
    expect((await pendingMainDeploy(g.api, 'dev'))?.id).toBe(1);
  });

  it('is done with a slot once its deploy job completed, however it ended, while prod still runs', async () => {
    for (const conclusion of ['success', 'failure']) {
      const g = github([run(1)], {
        1: [
          job('wait-dev', 'completed', 'success'),
          job('deploy-dev / deploy', 'completed', conclusion),
          job('deploy-prod / deploy', 'in_progress'),
        ],
      });
      expect(await pendingMainDeploy(g.api, 'dev')).toBeNull();
    }
  });

  it('keeps the slots apart: devb deploying is not dev, and the bare skipped call counts as done', async () => {
    const g = github([run(1)], {
      1: [
        job('deploy-dev / deploy', 'completed', 'success'),
        job('deploy-devb / deploy', 'in_progress'),
      ],
    });
    expect(await pendingMainDeploy(g.api, 'dev')).toBeNull();
    expect((await pendingMainDeploy(g.api, 'devb'))?.id).toBe(1);
    const skipped = github([run(2)], {
      2: [job('deploy-devb', 'completed', 'skipped'), job('deploy-dev / deploy', 'in_progress')],
    });
    expect(await pendingMainDeploy(skipped.api, 'devb')).toBeNull();
    expect((await pendingMainDeploy(skipped.api, 'dev'))?.id).toBe(2);
  });

  it('reads a run from before the wait jobs by its deploy job alone', async () => {
    const g = github([run(1)], { 1: [job('check / check', 'in_progress')] });
    expect((await pendingMainDeploy(g.api, 'dev'))?.id).toBe(1);
  });

  it('names the oldest pending run, the one that deploys first', async () => {
    const g = github([run(3, 'queued'), run(2), run(1, 'completed')], { 3: [], 2: [] });
    expect((await pendingMainDeploy(g.api, 'dev'))?.id).toBe(2);
    expect(await mainPendingGuard(g.api)('dev')).toBe(
      'https://github.com/radatta/aperture/actions/runs/2',
    );
  });

  it('lets an API error through, so the caller fails closed', async () => {
    const g = fakeApi({
      [`GET ${R}/actions/workflows/deploy.yml/runs?`]: () => {
        throw ghError(502);
      },
    });
    await expect(pendingMainDeploy(g.api, 'dev')).rejects.toThrow(/502/);
  });
});
