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

  it('holds no slot up for a run still queued, classifying or checking: its wait reads the lock later', async () => {
    for (const jobs of [
      [],
      [job('changes', 'in_progress')],
      [job('changes', 'completed', 'success'), job('check / check', 'in_progress')],
      [job('check / check', 'in_progress'), job('wait-dev', 'queued')],
    ]) {
      const g = github([run(1, 'queued')], { 1: jobs });
      expect(await pendingMainDeploy(g.api, 'dev')).toBeNull();
      expect(await pendingMainDeploy(g.api, 'devb')).toBeNull();
    }
  });

  it('is pending on a slot from the moment its wait starts until its deploy job completes', async () => {
    const waiting = github([run(1)], {
      1: [job('wait-dev', 'in_progress'), job('wait-devb', 'completed', 'skipped')],
    });
    expect((await pendingMainDeploy(waiting.api, 'dev'))?.id).toBe(1);
    expect(await pendingMainDeploy(waiting.api, 'devb')).toBeNull(); // skipped wait: main deploys nothing there
    for (const conclusion of ['success', 'failure']) {
      // a wait that ended, however (a crash is fail-open too), until the deploy job is done
      const deploying = github([run(1)], {
        1: [job('wait-dev', 'completed', conclusion), job('deploy-dev / deploy', 'in_progress')],
      });
      expect((await pendingMainDeploy(deploying.api, 'dev'))?.id).toBe(1);
      const between = github([run(1)], { 1: [job('wait-dev', 'completed', conclusion)] });
      expect((await pendingMainDeploy(between.api, 'dev'))?.id).toBe(1);
    }
  });

  it('is done with a slot once its deploy job completed, however it ended, while prod still runs', async () => {
    for (const conclusion of ['success', 'failure', 'skipped']) {
      const g = github([run(1)], {
        1: [
          job('wait-dev', 'completed', 'success'),
          job(
            conclusion === 'skipped' ? 'deploy-dev' : 'deploy-dev / deploy',
            'completed',
            conclusion,
          ),
          job('deploy-prod / deploy', 'in_progress'),
        ],
      });
      expect(await pendingMainDeploy(g.api, 'dev')).toBeNull();
    }
  });

  it('keeps the slots apart: devb deploying is not dev, and the bare skipped call counts as done', async () => {
    const g = github([run(1)], {
      1: [
        job('wait-dev', 'completed', 'success'),
        job('wait-devb', 'completed', 'success'),
        job('deploy-dev / deploy', 'completed', 'success'),
        job('deploy-devb / deploy', 'in_progress'),
      ],
    });
    expect(await pendingMainDeploy(g.api, 'dev')).toBeNull();
    expect((await pendingMainDeploy(g.api, 'devb'))?.id).toBe(1);
    const skipped = github([run(2)], {
      2: [
        job('wait-dev', 'in_progress'),
        job('wait-devb', 'completed', 'success'),
        job('deploy-devb', 'completed', 'skipped'),
      ],
    });
    expect(await pendingMainDeploy(skipped.api, 'devb')).toBeNull();
    expect((await pendingMainDeploy(skipped.api, 'dev'))?.id).toBe(2);
  });

  it('reads a run from before the wait jobs by its deploy job alone', async () => {
    const running = github([run(1)], {
      1: [job('check / check', 'completed', 'success'), job('deploy-dev / deploy', 'in_progress')],
    });
    expect((await pendingMainDeploy(running.api, 'dev'))?.id).toBe(1);
    expect(await pendingMainDeploy(running.api, 'devb')).toBeNull();
    const done = github([run(1)], {
      1: [
        job('deploy-dev / deploy', 'completed', 'success'),
        job('deploy-prod / deploy', 'queued'),
      ],
    });
    expect(await pendingMainDeploy(done.api, 'dev')).toBeNull();
  });

  it('names the oldest pending run, the one that deploys first', async () => {
    const waits = [job('wait-dev', 'in_progress')];
    const g = github([run(3), run(2), run(1, 'completed')], { 3: waits, 2: waits });
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
