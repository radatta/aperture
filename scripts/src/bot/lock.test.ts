import { describe, expect, it } from 'vitest';
import { fakeApi, fakeClock, ghError } from './fakes.ts';
import {
  LockHeld,
  TTL_MS,
  acquire,
  parseWaitMax,
  queueNotes,
  release,
  renew,
  status,
  waitForLock,
} from './lock.ts';
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
    const err = await acquire(g.api, 'ci-bot', SHA, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockHeld); // typed: the CLI prints whom to tell from its holder
    expect((err as LockHeld).holder?.branch).toBe('dev-e2e');
    expect(String(err)).toMatch(/locked by dev-e2e .*`pnpm bot lock wait`/);
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

// The lock as a function of time: a holder, null (no ref), or 'error' (GitHub hiccup).
function timeline(clock: { now: () => number }, at: (t: number) => Holder | null | 'error') {
  return fakeApi({
    [`GET ${R}/git/ref/locks/dev`]: () => {
      const h = at(clock.now());
      if (h === 'error') throw ghError(502);
      if (!h) throw ghError(404);
      return { object: { sha: `t-${h.expiresAt}`, type: 'tag' } };
    },
    [`GET ${R}/git/tags/`]: () => ({ message: JSON.stringify(at(clock.now())) }),
  });
}
const until = (branch: string, ms: number): Holder => ({
  branch,
  sha: SHA,
  expiresAt: new Date(NOW + ms).toISOString(),
});
const reads = (calls: { path: string }[]) =>
  calls.filter((c) => c.path.includes('/git/ref/')).length;
const MIN = 60_000;

describe('lock wait', () => {
  it('returns free at once when no lock exists', async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, () => null);
    expect(await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN })).toEqual({
      outcome: 'free',
      holder: null,
    });
    expect(clock.t).toBe(NOW);
  });

  it("treats its own branch's lock as free", async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, () => until('ci-bot', 30 * MIN));
    expect((await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN })).outcome).toBe('ours');
  });

  it('polls every 30 s and returns when the holder releases', async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, (t) => (t < NOW + 70_000 ? until('flux', 30 * MIN) : null));
    expect((await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN })).outcome).toBe('free');
    expect(clock.t).toBe(NOW + 90_000); // reads at 0, 30, 60 (held) and 90 s
    expect(reads(g.calls)).toBe(4);
  });

  it("wakes at the holder's expiry instead of the next 30 s tick", async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, () => until('flux', 45_000));
    const r = await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN });
    expect(r).toMatchObject({ outcome: 'expired', holder: { branch: 'flux' } });
    expect(clock.t).toBe(NOW + 46_000); // 0, 30, then expiry + 1 s
  });

  it('gives up after the cap, naming the holder', async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, () => until('flux', 40 * MIN));
    const r = await waitForLock(g.api, 'ci-bot', clock, { maxMs: 2 * MIN });
    expect(r).toMatchObject({ outcome: 'gave-up', holder: { branch: 'flux' } });
    expect(clock.t).toBe(NOW + 2 * MIN);
  });

  it('logs the holder once, and again when a renew moves the expiry', async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, (t) => until('flux', t < NOW + MIN ? 20 * MIN : 50 * MIN));
    const lines: string[] = [];
    await waitForLock(g.api, 'ci-bot', clock, {
      maxMs: 3 * MIN,
      log: (l) => lines.push(l),
      sessionOf: (b) => (b === 'flux' ? 'flux-session' : undefined),
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^waiting: dev locked by flux @ aaaaaaa until \d\d:\d\d \(20 min\) — session flux-session$/,
    );
    expect(lines[1]).toMatch(/\(49 min\)/); // renewed at 60 s, read at 60 s
  });

  it('keeps polling through two API errors and throws on the third', async () => {
    const clock = fakeClock(NOW);
    const two = timeline(clock, (t) => (t < NOW + 60_000 ? 'error' : null));
    const lines: string[] = [];
    const r = await waitForLock(two.api, 'ci-bot', clock, {
      maxMs: 45 * MIN,
      log: (l) => lines.push(l),
    });
    expect(r.outcome).toBe('free');
    expect(lines.filter((l) => l.startsWith('lock read failed'))).toHaveLength(2);
    const three = timeline(clock, () => 'error');
    await expect(waitForLock(three.api, 'ci-bot', clock, { maxMs: 45 * MIN })).rejects.toThrow(
      /502/,
    );
  });

  it('rides out a GitHub blip at the holder’s expiry, a full poll apart', async () => {
    const clock = fakeClock(NOW);
    // Held until 45 s; then 40 s of 502s; then the ref is gone.
    const g = timeline(clock, (t) =>
      t < NOW + 45_000 ? until('flux', 45_000) : t < NOW + 85_000 ? 'error' : null,
    );
    const r = await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN });
    expect(r.outcome).toBe('free');
    expect(clock.t).toBe(NOW + 106_000); // 0, 30, 46 (502), 76 (502), 106
  });

  it('an unreadable holder counts as expired', async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, () => ({ branch: 'flux', sha: SHA }) as Holder);
    expect(await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN })).toEqual({
      outcome: 'expired',
      holder: null,
    });
  });

  it('follows real renew, release and a new taker on the lock while it waits', async () => {
    const g = github(live('flux'));
    // A clock whose sleeps run what other sessions do at those times.
    const events: [number, () => Promise<unknown>][] = [
      [NOW + 30_000, () => renew(g.api, 'flux', NOW + 30_000)],
      [
        NOW + 60_000,
        () => release(g.api, 'flux').then(() => acquire(g.api, 'flux-2', SHA, NOW + 60_000)),
      ],
      [NOW + 90_000, () => release(g.api, 'flux-2')],
    ];
    const clock = {
      t: NOW,
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.t += ms;
        while (events.length && (events[0]?.[0] ?? Infinity) <= clock.t)
          await events.shift()?.[1]();
      },
    };
    const lines: string[] = [];
    const r = await waitForLock(g.api, 'ci-bot', clock, {
      maxMs: 45 * MIN,
      log: (l) => lines.push(l),
    });
    expect(r.outcome).toBe('free');
    expect(clock.t).toBe(NOW + 90_000);
    expect(lines.map((l) => l.match(/locked by (\S+)/)?.[1])).toEqual(['flux', 'flux', 'flux-2']);
  });

  it("reports each read to onRead (the board's lock cache)", async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, (t) => (t < NOW + 30_000 ? until('flux', 30 * MIN) : null));
    const seen: (string | null)[] = [];
    await waitForLock(g.api, 'ci-bot', clock, {
      maxMs: 45 * MIN,
      onRead: (cur) => seen.push(cur?.holder?.branch ?? null),
    });
    expect(seen).toEqual(['flux', null]);
  });

  it("refuses a --max past the token's hour", () => {
    expect(parseWaitMax(undefined)).toBe(45 * MIN);
    expect(parseWaitMax('55')).toBe(55 * MIN);
    for (const bad of ['56', '0', '-5', 'soon'])
      expect(() => parseWaitMax(bad)).toThrow(/at most 55/);
  });

  it('writes the hub note always and the holder note only for a known session', () => {
    const h = until('flux', 30 * MIN);
    expect(queueNotes('ci-bot', h, 'dispatch')).toEqual([
      'SendMessage dispatch: "[lock] ci-bot — queued behind flux; lock wait next."',
    ]);
    const both = queueNotes('ci-bot', h, 'dispatch', 'flux-session');
    expect(both).toHaveLength(2);
    expect(both[0]).toMatch(/queued behind flux \(flux-session\)/);
    expect(both[1]).toMatch(/^SendMessage flux-session: "Queued behind you for the dev lock/);
  });
});
