import { describe, expect, it } from 'vitest';
import { fakeApi, ghError } from './fakes.ts';
import { RunRefused, refusal, runCommand } from './run.ts';
import type { WorkflowRun } from './run.ts';

const BASE = '/repos/radatta/aperture/actions/runs/42';
const PR_RUN: WorkflowRun = {
  id: 42,
  path: '.github/workflows/pr.yml',
  event: 'pull_request',
  head_branch: 'mailroom-v2',
  head_repository: { full_name: 'radatta/aperture' },
  status: 'in_progress',
  conclusion: null,
  html_url: 'https://github.com/radatta/aperture/actions/runs/42',
};

function setup(run: Partial<WorkflowRun> | 'missing', post?: () => unknown) {
  const { api, calls } = fakeApi({
    [`GET ${BASE}`]: () => {
      if (run === 'missing') throw ghError(404);
      return { ...PR_RUN, ...run };
    },
    [`POST ${BASE}/`]: post ?? (() => undefined),
  });
  const logs: string[] = [];
  return { api, calls, logs, log: (s: string) => logs.push(s) };
}
const writes = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.method !== 'GET').map((c) => c.path);

describe('bot run: which runs it may touch', () => {
  it('a PR check run on a feature branch from this repo qualifies, a @ref suffix too', () => {
    expect(refusal(PR_RUN)).toBeNull();
    expect(refusal({ ...PR_RUN, path: '.github/workflows/pr.yml@refs/pull/9/merge' })).toBeNull();
  });

  it.each([
    [
      'the deploy workflow',
      { path: '.github/workflows/deploy.yml', event: 'push', head_branch: 'main' },
    ],
    [
      'a dispatched dev deploy',
      { path: '.github/workflows/deploy-dev.yml', event: 'workflow_dispatch' },
    ],
    ['dev logs', { path: '.github/workflows/fetch-dev-logs.yml', event: 'workflow_dispatch' }],
    ['the reusable ci on a push', { path: '.github/workflows/ci.yml', event: 'push' }],
    ['pr.yml on another event', { event: 'push' }],
    ['a look-alike path', { path: '.github/workflows/pr.yml.bak' }],
    ['a fork', { head_repository: { full_name: 'someone/aperture' } }],
    ['no head repo', { head_repository: null }],
    ['main', { head_branch: 'main' }],
    ['dev', { head_branch: 'dev' }],
    ['no branch', { head_branch: null }],
  ])('refuses %s before any write, for cancel and rerun', async (_name, over) => {
    for (const action of ['cancel', 'rerun']) {
      const { api, calls, log } = setup({
        ...over,
        status: action === 'rerun' ? 'completed' : 'queued',
      });
      await expect(runCommand(api, action, '42', false, log)).rejects.toThrow(RunRefused);
      expect(writes(calls)).toEqual([]);
    }
  });
});

describe('bot run cancel', () => {
  it('cancels a running PR check', async () => {
    const { api, calls, logs, log } = setup({});
    expect(await runCommand(api, 'cancel', '42', false, log)).toBe(0);
    expect(writes(calls)).toEqual([`${BASE}/cancel`]);
    expect(logs[0]).toMatch(/^cancelled run 42 \(mailroom-v2, in_progress\)/);
  });

  it('says a finished run is already finished, and writes nothing', async () => {
    const { api, calls, logs, log } = setup({ status: 'completed', conclusion: 'success' });
    expect(await runCommand(api, 'cancel', '42', false, log)).toBe(0);
    expect(writes(calls)).toEqual([]);
    expect(logs[0]).toMatch(/already finished/);
  });

  it('treats a 409 (it finished meanwhile) as done', async () => {
    const { api, logs, log } = setup({}, () => {
      throw ghError(409);
    });
    expect(await runCommand(api, 'cancel', '42', false, log)).toBe(0);
    expect(logs[0]).toMatch(/finished before the cancel landed/);
  });
});

describe('bot run rerun', () => {
  it('reruns a finished PR check, or only its failed jobs', async () => {
    const a = setup({ status: 'completed', conclusion: 'failure' });
    expect(await runCommand(a.api, 'rerun', '42', false, a.log)).toBe(0);
    expect(writes(a.calls)).toEqual([`${BASE}/rerun`]);
    const b = setup({ status: 'completed', conclusion: 'failure' });
    expect(await runCommand(b.api, 'rerun', '42', true, b.log)).toBe(0);
    expect(writes(b.calls)).toEqual([`${BASE}/rerun-failed-jobs`]);
  });

  it('refuses a run still going', async () => {
    const { api, calls, log } = setup({ status: 'in_progress' });
    await expect(runCommand(api, 'rerun', '42', false, log)).rejects.toThrow(/still going/);
    expect(writes(calls)).toEqual([]);
  });
});

describe('bot run usage', () => {
  it.each([
    ['merge', '42'],
    ['cancel', undefined],
    ['cancel', '42; rm'],
    ['cancel', '../1'],
    ['cancel', '0'],
  ])('refuses %s %s before any call', async (action, id) => {
    const { api, calls, log } = setup({});
    await expect(runCommand(api, action, id, false, log)).rejects.toThrow(RunRefused);
    expect(calls).toEqual([]);
  });

  it('refuses --failed on a cancel, and an unknown run', async () => {
    const a = setup({});
    await expect(runCommand(a.api, 'cancel', '42', true, a.log)).rejects.toThrow(
      /--failed goes with rerun/,
    );
    const b = setup('missing');
    await expect(runCommand(b.api, 'cancel', '42', false, b.log)).rejects.toThrow(/no run 42/);
  });
});
