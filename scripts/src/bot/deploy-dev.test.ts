import { describe, expect, it } from 'vitest';
import { deployDev, deployTitle } from './deploy-dev.ts';
import { fakeApi, fakeClock, fakeRun, ghError } from './fakes.ts';
import type { Call } from './fakes.ts';

const R = '/repos/radatta/aperture';
const SHA = 'e'.repeat(40);
const quiet = () => undefined;

// A pushed feature branch that contains main.
const repo = () =>
  fakeRun([
    ['git symbolic-ref', 'ci-bot'],
    ['git rev-parse HEAD', SHA],
    ['git ls-remote', `${SHA}\trefs/heads/ci-bot`],
    ['git fetch', ''],
    ['git merge-base', ''],
    ['git diff --quiet', ''],
  ]);

// GitHub with a free lock, no prior dev deploys, and a run that takes `minutes` then ends with `conclusion`.
function github(clock: { now: () => number }, minutes: number, conclusion: string) {
  let ref: string | null = null;
  let tags = 0;
  const messages = new Map<string, string>();
  let dispatchedAt = 0;
  let title = '';
  const h = fakeApi({
    [`POST ${R}/git/tags`]: (c: Call) => {
      const sha = `t${++tags}`;
      messages.set(sha, (c.body as { message: string }).message);
      return { sha };
    },
    [`POST ${R}/git/refs`]: (c: Call) => {
      if (ref) throw ghError(422);
      ref = (c.body as { sha: string }).sha;
      return {};
    },
    [`GET ${R}/git/ref/locks/dev`]: () => {
      if (!ref) throw ghError(404);
      return { object: { sha: ref, type: 'tag' } };
    },
    [`GET ${R}/git/tags/`]: (c: Call) => ({ message: messages.get(c.path.split('/').pop() ?? '') }),
    [`PATCH ${R}/git/refs/locks/dev`]: (c: Call) => {
      ref = (c.body as { sha: string }).sha;
      return {};
    },
    [`DELETE ${R}/git/refs/locks/dev`]: () => {
      ref = null;
      return undefined;
    },
    [`GET ${R}/actions/workflows/deploy.yml/runs`]: () => ({ workflow_runs: [] }),
    [`POST ${R}/actions/workflows/deploy-dev.yml/dispatches`]: (c: Call) => {
      dispatchedAt = clock.now();
      title = deployTitle(SHA, (c.body as { inputs: { key: string } }).inputs.key);
      return undefined;
    },
    [`GET ${R}/actions/workflows/deploy-dev.yml/runs`]: () => ({
      workflow_runs: dispatchedAt
        ? [
            {
              id: 7,
              display_title: title,
              created_at: new Date(dispatchedAt).toISOString(),
              status: 'queued',
              conclusion: null,
              html_url: 'u',
            },
          ]
        : [],
    }),
    [`GET ${R}/actions/runs/7`]: () => {
      const done = clock.now() - dispatchedAt >= minutes * 60_000;
      return {
        id: 7,
        display_title: title,
        created_at: '',
        html_url: 'u',
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? conclusion : null,
      };
    },
  });
  const lock = () =>
    ref ? (JSON.parse(messages.get(ref) ?? 'null') as { expiresAt: string }) : null;
  return { ...h, lock };
}

describe('deployDev', () => {
  it('keeps the lock alive through a long deploy and hands the devcheck a full TTL', async () => {
    const clock = fakeClock();
    const g = github(clock, 60, 'success'); // longer than the 45-minute TTL
    const { run } = repo();
    const r = await deployDev(run, g.api, clock, quiet).catch((e: Error) => e);
    // 60 minutes > the 45-minute dispatch timeout → a timeout, and the lock is NOT released (the run may still go).
    expect(r).toBeInstanceOf(Error);
    expect(String(r)).toMatch(/left to expire/);
    expect(g.lock()).not.toBeNull();
    expect(Date.parse(g.lock()?.expiresAt ?? '')).toBeGreaterThan(clock.now()); // renewed while waiting
  });

  it('renews on success so the devcheck starts with 45 minutes', async () => {
    const clock = fakeClock();
    const g = github(clock, 30, 'success');
    const { run } = repo();
    const r = await deployDev(run, g.api, clock, quiet);
    expect(r.conclusion).toBe('success');
    expect(Date.parse(g.lock()?.expiresAt ?? '') - clock.now()).toBe(45 * 60_000);
  });

  it('releases the lock when the run finishes unsuccessfully', async () => {
    const clock = fakeClock();
    const g = github(clock, 5, 'failure');
    const { run } = repo();
    await expect(deployDev(run, g.api, clock, quiet)).rejects.toThrow(
      /deploy-dev failure: u — lock released/,
    );
    expect(g.lock()).toBeNull();
  });

  it('refuses a commit that is not pushed, before touching the lock', async () => {
    const clock = fakeClock();
    const g = github(clock, 5, 'success');
    const { run } = fakeRun([
      ['git symbolic-ref', 'ci-bot'],
      ['git rev-parse HEAD', SHA],
      ['git ls-remote', ''],
    ]);
    await expect(deployDev(run, g.api, clock, quiet)).rejects.toThrow(/pnpm bot push/);
    expect(g.calls).toHaveLength(0);
  });

  it('dispatches a branch that changes .github/ on its own ref, so its workflows run', async () => {
    const clock = fakeClock();
    const g = github(clock, 5, 'success');
    const { run } = fakeRun([
      ['git symbolic-ref', 'ci-bot'],
      ['git rev-parse HEAD', SHA],
      ['git ls-remote', `${SHA}\trefs/heads/ci-bot`],
      ['git fetch', ''],
      ['git merge-base', ''],
      [
        'git diff --quiet',
        () => {
          throw new Error('differs');
        },
      ],
    ]);
    const logs: string[] = [];
    await deployDev(run, g.api, clock, (s: string) => void logs.push(s));
    const dispatch = g.calls.find((c) => c.path.endsWith('/dispatches'));
    expect((dispatch?.body as { ref: string }).ref).toBe('ci-bot');
    // Only a branch the user admitted to the `dev` environment can deploy on its own ref.
    expect(logs.join('\n')).toMatch(/must admit ci-bot by name/);
    expect(g.calls.some((c) => c.path.includes('runs?event=workflow_dispatch&branch=ci-bot'))).toBe(
      true,
    );
  });

  it('runs main’s YAML for an ordinary branch', async () => {
    const clock = fakeClock();
    const g = github(clock, 5, 'success');
    await deployDev(repo().run, g.api, clock, quiet);
    const dispatch = g.calls.find((c) => c.path.endsWith('/dispatches'));
    expect((dispatch?.body as { ref: string }).ref).toBe('main');
  });

  it('releases the lock when GitHub refuses the dispatch itself — no run exists', async () => {
    const clock = fakeClock();
    const g = github(clock, 5, 'success');
    const refusing = fakeApi({
      [`POST ${R}/actions/workflows/deploy-dev.yml/dispatches`]: () => {
        throw ghError(422);
      },
    });
    const api = (async (method: string, path: string, body?: unknown) =>
      path.endsWith('/dispatches')
        ? refusing.api(method, path, body)
        : g.api(method, path, body)) as typeof g.api;
    const { run } = repo();
    await expect(deployDev(run, api, clock, quiet)).rejects.toThrow(
      /no run started; lock released/,
    );
    expect(g.lock()).toBeNull();
  });
});
