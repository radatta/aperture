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

// GitHub with free locks (or slot A held by `heldA`), no prior dev deploys, and a run that takes `minutes` then ends
// with `conclusion`. Each slot's lock is its own ref (refs/locks/dev, refs/locks/devb).
function github(
  clock: { now: () => number },
  minutes: number,
  conclusion: string,
  heldA?: { branch: string; sha: string; expiresAt: string },
) {
  const refs: Record<string, string | null> = { dev: null, devb: null };
  let tags = 0;
  const messages = new Map<string, string>();
  if (heldA) {
    messages.set('held', JSON.stringify(heldA));
    refs.dev = 'held';
  }
  const slotOf = (path: string) => path.split('/').pop() ?? '';
  let dispatchedAt = 0;
  let title = '';
  const inputs: Record<string, string>[] = [];
  const h = fakeApi({
    [`POST ${R}/git/tags`]: (c: Call) => {
      const sha = `t${++tags}`;
      messages.set(sha, (c.body as { message: string }).message);
      return { sha };
    },
    [`POST ${R}/git/refs`]: (c: Call) => {
      const { ref, sha } = c.body as { ref: string; sha: string };
      if (refs[slotOf(ref)]) throw ghError(422);
      refs[slotOf(ref)] = sha;
      return {};
    },
    [`GET ${R}/git/ref/locks/`]: (c: Call) => {
      const ref = refs[slotOf(c.path)];
      if (!ref) throw ghError(404);
      return { object: { sha: ref, type: 'tag' } };
    },
    [`GET ${R}/git/tags/`]: (c: Call) => ({ message: messages.get(c.path.split('/').pop() ?? '') }),
    [`PATCH ${R}/git/refs/locks/`]: (c: Call) => {
      refs[slotOf(c.path)] = (c.body as { sha: string }).sha;
      return {};
    },
    [`DELETE ${R}/git/refs/locks/`]: (c: Call) => {
      refs[slotOf(c.path)] = null;
      return undefined;
    },
    [`GET ${R}/actions/workflows/deploy.yml/runs`]: () => ({ workflow_runs: [] }),
    [`POST ${R}/actions/workflows/deploy-dev.yml/dispatches`]: (c: Call) => {
      inputs.push((c.body as { inputs: Record<string, string> }).inputs);
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
  const lockOf = (slot: 'dev' | 'devb') => {
    const ref = refs[slot];
    return ref
      ? (JSON.parse(messages.get(ref) ?? 'null') as { branch: string; expiresAt: string })
      : null;
  };
  return { ...h, lock: () => lockOf('dev'), lockOf, inputs };
}

describe('deployDev', () => {
  it('takes slot B when another branch holds A, dispatches devb, and leaves A alone', async () => {
    const clock = fakeClock(Date.parse('2026-10-13T20:00:00Z'));
    const flux = {
      branch: 'flux',
      sha: SHA,
      expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
    };
    const g = github(clock, 3, 'success', flux);
    const slots: string[] = [];
    const lines: string[] = [];
    await deployDev(
      repo().run,
      g.api,
      clock,
      (l) => lines.push(l),
      (_, slot) => slots.push(slot),
    );
    expect(g.inputs).toHaveLength(1);
    expect(g.inputs[0]).toMatchObject({ sha: SHA, base: 'unknown', slot: 'devb' }); // never deployed → full
    expect(g.lockOf('devb')?.branch).toBe('ci-bot');
    expect(g.lockOf('dev')).toEqual(flux);
    expect(new Set(slots)).toEqual(new Set(['devb']));
    expect(lines.at(-1)).toMatch(/^devb now serves .*`pnpm devcheck` aims at devb/);
  });

  it('sends slot A no slot input, so an older main YAML still accepts it', async () => {
    const clock = fakeClock(Date.parse('2026-10-13T20:00:00Z'));
    const g = github(clock, 3, 'success');
    await deployDev(repo().run, g.api, clock, quiet);
    expect(g.inputs).toHaveLength(1);
    expect(g.inputs[0]).toMatchObject({ sha: SHA, base: '' });
    expect(g.inputs[0]).not.toHaveProperty('slot');
    expect(g.lockOf('devb')).toBeNull();
  });

  it('releases slot B, not A, when a devb run fails', async () => {
    const clock = fakeClock(Date.parse('2026-10-13T20:00:00Z'));
    const flux = {
      branch: 'flux',
      sha: SHA,
      expiresAt: new Date(clock.now() + 30 * 60_000).toISOString(),
    };
    const g = github(clock, 3, 'failure', flux);
    await expect(deployDev(repo().run, g.api, clock, quiet)).rejects.toThrow(/lock released/);
    expect(g.lockOf('devb')).toBeNull();
    expect(g.lockOf('dev')).toEqual(flux);
  });

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
  it("reports every lock change to onLock (the board's cache), and a throwing one changes nothing", async () => {
    const clock = fakeClock();
    const g = github(clock, 40, 'success'); // long enough for a renew while it waits
    const seen: (string | null)[] = [];
    await deployDev(repo().run, g.api, clock, quiet, (h) => void seen.push(h?.expiresAt ?? null));
    expect(seen.length).toBeGreaterThanOrEqual(3); // acquire, a renew while waiting, the final renew
    expect(seen.every((e) => e !== null)).toBe(true);
    expect(seen.at(-1)).toBe(g.lock()?.expiresAt);

    const again = github(clock, 5, 'success');
    const r = await deployDev(repo().run, again.api, clock, quiet, () => {
      throw new Error('board gone');
    });
    expect(r.conclusion).toBe('success');
  });

  it('reports a release as null, and nothing when the release itself fails', async () => {
    const clock = fakeClock();
    const g = github(clock, 5, 'failure');
    const seen: (string | null)[] = [];
    await deployDev(
      repo().run,
      g.api,
      clock,
      quiet,
      (h) => void seen.push(h?.branch ?? null),
    ).catch(() => undefined);
    expect(seen.at(-1)).toBeNull();

    const stuck = github(clock, 5, 'failure');
    const api = (async (method: string, path: string, body?: unknown) => {
      if (method === 'DELETE') throw ghError(500);
      return stuck.api(method, path, body);
    }) as typeof stuck.api;
    const kept: (string | null)[] = [];
    await deployDev(repo().run, api, clock, quiet, (h) => void kept.push(h?.branch ?? null)).catch(
      () => undefined,
    );
    expect(kept).not.toContain(null);
    expect(stuck.lock()).not.toBeNull();
  });
});
