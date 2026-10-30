import { describe, expect, it } from 'vitest';
import { fakeApi, ghError } from './fakes.ts';
import { TTL_MS, acquire, release, renew, status } from './lock.ts';
import type { Holder } from './lock.ts';

const NOW = Date.parse('2026-10-13T20:00:00Z');
const SHA = 'a'.repeat(40);
const R = '/repos/radatta/aperture';

// A tiny GitHub: one lock ref → tag objects by sha.
function github(initial?: Holder) {
  const tags = new Map<string, string>();
  let n = 0;
  let ref: string | null = null;
  if (initial) {
    tags.set('t0', JSON.stringify(initial));
    ref = 't0';
  }
  const h = fakeApi({
    [`POST ${R}/git/tags`]: (c) => {
      const sha = `t${++n}`;
      tags.set(sha, (c.body as { message: string }).message);
      return { sha };
    },
    [`POST ${R}/git/refs`]: (c) => {
      if (ref) throw ghError(422);
      ref = (c.body as { sha: string }).sha;
      return {};
    },
    [`GET ${R}/git/ref/locks/dev`]: () => {
      if (!ref) throw ghError(404);
      return { object: { sha: ref, type: 'tag' } };
    },
    [`GET ${R}/git/tags/`]: (c) => ({ message: tags.get(c.path.split('/').pop() ?? '') }),
    [`PATCH ${R}/git/refs/locks/dev`]: (c) => {
      ref = (c.body as { sha: string }).sha;
      return {};
    },
    [`DELETE ${R}/git/refs/locks/dev`]: () => {
      ref = null;
      return undefined;
    },
  });
  return { ...h, holder: () => (ref ? (JSON.parse(tags.get(ref) ?? 'null') as Holder) : null) };
}

const live = (branch: string): Holder => ({
  branch,
  sha: SHA,
  expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
});
const expired = (branch: string): Holder => ({
  branch,
  sha: SHA,
  expiresAt: new Date(NOW - 1).toISOString(),
});

describe('dev lock', () => {
  it('acquires a free lock with a 45-minute expiry', async () => {
    const g = github();
    const h = await acquire(g.api, 'ci-bot', SHA, NOW);
    expect(h).toEqual({
      branch: 'ci-bot',
      sha: SHA,
      expiresAt: new Date(NOW + TTL_MS).toISOString(),
    });
    expect(g.holder()).toEqual(h);
    expect(g.calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/refs'))?.body).toEqual({
      ref: 'refs/locks/dev',
      sha: 't1',
    });
  });

  it('refuses while another branch holds it, naming the holder', async () => {
    const g = github(live('dev-e2e'));
    await expect(acquire(g.api, 'ci-bot', SHA, NOW)).rejects.toThrow(/locked by dev-e2e/);
    expect(g.holder()?.branch).toBe('dev-e2e');
  });

  it('takes over an expired lock', async () => {
    const g = github(expired('dev-e2e'));
    await acquire(g.api, 'ci-bot', SHA, NOW);
    expect(g.holder()?.branch).toBe('ci-bot');
  });

  it('re-acquiring its own lock renews it', async () => {
    const g = github(live('ci-bot'));
    const h = await acquire(g.api, 'ci-bot', SHA, NOW);
    expect(g.holder()).toEqual(h);
    expect(h.expiresAt).toBe(new Date(NOW + TTL_MS).toISOString());
  });

  it('loses the race when someone else re-takes it between attempts', async () => {
    // Every create collides; after the delete, a third session wins the ref before our retry.
    let deletes = 0;
    const raced = fakeApi({
      [`POST ${R}/git/tags`]: () => ({ sha: 'tX' }),
      [`POST ${R}/git/refs`]: () => {
        throw ghError(422);
      },
      [`GET ${R}/git/ref/locks/dev`]: () => ({
        object: { sha: deletes ? 'tY' : 't0', type: 'tag' },
      }),
      [`GET ${R}/git/tags/`]: (c) => ({
        message: JSON.stringify(c.path.endsWith('tY') ? live('session-board') : expired('dev-e2e')),
      }),
      [`DELETE ${R}/git/refs/locks/dev`]: () => {
        deletes++;
        return undefined;
      },
    });
    await expect(acquire(raced.api, 'ci-bot', SHA, NOW)).rejects.toThrow(/locked by session-board/);
  });

  it('releases only its own lock', async () => {
    const g = github(live('dev-e2e'));
    await expect(release(g.api, 'ci-bot')).rejects.toThrow(/does not hold/);
    expect(g.holder()?.branch).toBe('dev-e2e');
    expect(await release(g.api, 'dev-e2e')).toBe(true);
    expect(g.holder()).toBeNull();
    expect(await release(g.api, 'dev-e2e')).toBe(false);
  });

  it('renews only for the holder', async () => {
    const g = github(live('ci-bot'));
    const h = await renew(g.api, 'ci-bot', NOW + 30 * 60_000);
    expect(h.expiresAt).toBe(new Date(NOW + 30 * 60_000 + TTL_MS).toISOString());
    await expect(renew(g.api, 'dev-e2e', NOW)).rejects.toThrow(/does not hold/);
  });

  it('treats a garbled holder (no expiry) as expired, so it can never block dev forever', async () => {
    const g = github({ branch: 'dev-e2e', sha: SHA } as Holder);
    expect(await status(g.api, NOW)).toMatch(/unreadable holder.*EXPIRED/);
    await acquire(g.api, 'ci-bot', SHA, NOW);
    expect(g.holder()?.branch).toBe('ci-bot');
  });

  it('reports free, held and expired', async () => {
    expect(await status(github().api, NOW)).toBe('dev lock: free');
    expect(await status(github(live('ci-bot')).api, NOW)).toMatch(
      /^dev lock: ci-bot @ aaaaaaa until /,
    );
    expect(await status(github(expired('ci-bot')).api, NOW)).toMatch(/EXPIRED/);
  });
});
