import { describe, expect, it } from 'vitest';
import { fakeApi, fakeClock, ghError } from './fakes.ts';
import {
  LockHeld,
  MainPending,
  SLOTS,
  TTL_MS,
  acquire,
  acquireSlot,
  heldLock,
  heldSlot,
  lockRef,
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
      takenAt: new Date(NOW).toISOString(), // main's wait counts the holder's turn from it
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

  it('re-acquiring its own live lock keeps when it was taken; a lapsed one is a fresh take', async () => {
    const taken = new Date(NOW - 50 * 60_000).toISOString();
    const g = github({ ...live('ci-bot'), takenAt: taken });
    const h = await acquire(g.api, 'ci-bot', SHA, NOW);
    expect(h.takenAt).toBe(taken); // a redeploy never restarts the turn main's wait counts from
    expect(h.expiresAt).toBe(new Date(NOW + TTL_MS).toISOString());
    expect(g.holder()).toEqual(h);
    const lapsed = github({ ...expired('ci-bot'), takenAt: taken });
    expect((await acquire(lapsed.api, 'ci-bot', SHA, NOW)).takenAt).toBe(
      new Date(NOW).toISOString(),
    );
    const garbled = github({ ...live('ci-bot'), takenAt: 'soon' }); // never kept: a fresh take
    expect((await acquire(garbled.api, 'ci-bot', SHA, NOW)).takenAt).toBe(
      new Date(NOW).toISOString(),
    );
    const old = github(live('ci-bot')); // an older bot's lock: no takenAt to keep
    expect((await acquire(old.api, 'ci-bot', SHA, NOW)).takenAt).toBe(new Date(NOW).toISOString());
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
    const h = await renew(g.api, 'ci-bot', NOW + 5 * 60_000);
    expect(h.expiresAt).toBe(new Date(NOW + 5 * 60_000 + TTL_MS).toISOString());
    await expect(renew(g.api, 'dev-e2e', NOW)).rejects.toThrow(/does not hold/);
  });

  it('a renew keeps when the lock was taken, and a lock without it (an older bot) still reads', async () => {
    const taken = new Date(NOW - 30 * 60_000).toISOString();
    const g = github({ ...live('ci-bot'), takenAt: taken });
    const h = await renew(g.api, 'ci-bot', NOW + 5 * 60_000);
    expect(h.takenAt).toBe(taken);
    expect(g.holder()).toEqual(h);
    const old = github(live('ci-bot'));
    expect((await renew(old.api, 'ci-bot', NOW)).takenAt).toBeUndefined();
  });

  it('never revives a lapsed lock: a merge may already be deploying there', async () => {
    const g = github(expired('ci-bot'));
    await expect(renew(g.api, 'ci-bot', NOW)).rejects.toThrow(
      /lock lapsed at .*`pnpm bot lock acquire`/,
    );
    expect(g.holder()?.expiresAt).toBe(expired('ci-bot').expiresAt); // untouched
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
      slot: 'dev',
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

  it('onBlocked fires once, on the first read that finds nothing open, and never on an immediate free or ours', async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, (t) => (t < NOW + 70_000 ? until('flux', 30 * MIN) : null));
    const seen: string[][] = [];
    const onBlocked = (r: { slot: string; cur: { holder: Holder | null } | null }[]) =>
      void seen.push(r.map((x) => `${x.slot}:${x.cur?.holder?.branch ?? '-'}`));
    expect(
      (await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN, onBlocked })).outcome,
    ).toBe('free');
    expect(seen).toEqual([['dev:flux']]);
    const free = timeline(clock, () => null);
    await waitForLock(free.api, 'ci-bot', clock, { maxMs: 45 * MIN, onBlocked });
    const ours = timeline(clock, () => until('ci-bot', 30 * MIN));
    await waitForLock(ours.api, 'ci-bot', clock, { maxMs: 45 * MIN, onBlocked });
    expect(seen).toHaveLength(1);
    const from = clock.t;
    const boom = timeline(clock, (t) => (t < from + 30_000 ? until('flux', 30 * MIN) : null));
    const r = await waitForLock(boom.api, 'ci-bot', clock, {
      maxMs: 45 * MIN,
      onBlocked: () => {
        throw new Error('board gone');
      },
    });
    expect(r.outcome).toBe('free'); // a throwing hook never ends the wait
  });

  it('heldLock returns the slot and its holder; heldSlot the slot alone', async () => {
    const g = github(live('flux'));
    expect(await heldLock(g.api, 'flux')).toMatchObject({
      slot: 'dev',
      holder: { branch: 'flux' },
    });
    expect(await heldSlot(g.api, 'flux')).toBe('dev');
    expect(await heldLock(g.api, 'other')).toBeNull();
  });

  it('an unreadable holder counts as expired', async () => {
    const clock = fakeClock(NOW);
    const g = timeline(clock, () => ({ branch: 'flux', sha: SHA }) as Holder);
    expect(await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN })).toEqual({
      outcome: 'expired',
      holder: null,
      slot: 'dev',
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
    expect(queueNotes('ci-bot', [{ slot: 'dev', holder: h }], 'dispatch')).toEqual([
      'SendMessage dispatch: "[lock] ci-bot — queued behind flux; lock wait next."',
    ]);
    const both = queueNotes(
      'ci-bot',
      [{ slot: 'dev', holder: h }],
      'dispatch',
      () => 'flux-session',
    );
    expect(both).toHaveLength(2);
    expect(both[0]).toMatch(/queued behind flux \(flux-session\)/);
    expect(both[1]).toMatch(/^SendMessage flux-session: "Queued behind you for the dev lock/);
  });

  it('names both holders and `lock wait --any` when both slots refused', () => {
    const notes = queueNotes(
      'ci-bot',
      [
        { slot: 'dev', holder: until('flux', 30 * MIN) },
        { slot: 'devb', holder: until('lc', 20 * MIN) },
      ],
      'dispatch-2',
      (b) => (b === 'lc' ? 'lc-session' : undefined),
    );
    expect(notes).toEqual([
      'SendMessage dispatch-2: "[lock] ci-bot — queued behind flux on dev and lc (lc-session) on devb; lock wait --any next."',
      'SendMessage lc-session: "Queued behind you for the devb lock (ci-bot) — release at phase 10 rather than letting the TTL run; no rush."',
    ]);
  });
});

// Two slots: refs/locks/dev (A) and refs/locks/devb (B), each its own ref and tag chain.
function slots(initial: Partial<Record<'dev' | 'devb', Holder>> = {}) {
  const tags = new Map<string, string>();
  let n = 0;
  const refs: Record<string, string | null> = { dev: null, devb: null };
  for (const [slot, h] of Object.entries(initial)) {
    tags.set(`i-${slot}`, JSON.stringify(h));
    refs[slot] = `i-${slot}`;
  }
  const slotOf = (path: string) => path.split('/').pop() ?? '';
  const h = fakeApi({
    [`POST ${R}/git/tags`]: (c) => {
      const sha = `t${++n}`;
      tags.set(sha, (c.body as { message: string }).message);
      return { sha };
    },
    [`POST ${R}/git/refs`]: (c) => {
      const { ref, sha } = c.body as { ref: string; sha: string };
      const slot = slotOf(ref);
      if (refs[slot]) throw ghError(422);
      refs[slot] = sha;
      return {};
    },
    [`GET ${R}/git/ref/locks/`]: (c) => {
      const ref = refs[slotOf(c.path)];
      if (!ref) throw ghError(404);
      return { object: { sha: ref, type: 'tag' } };
    },
    [`GET ${R}/git/tags/`]: (c) => ({ message: tags.get(c.path.split('/').pop() ?? '') }),
    [`PATCH ${R}/git/refs/locks/`]: (c) => {
      refs[slotOf(c.path)] = (c.body as { sha: string }).sha;
      return {};
    },
    [`DELETE ${R}/git/refs/locks/`]: (c) => {
      refs[slotOf(c.path)] = null;
      return undefined;
    },
  });
  const holderOf = (slot: 'dev' | 'devb') => {
    const ref = refs[slot];
    return ref ? (JSON.parse(tags.get(ref) ?? 'null') as Holder) : null;
  };
  return { ...h, holderOf };
}

describe('dev slots', () => {
  it('keeps its slot list in step with the shared one', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../../packages/shared/src/stage.ts', import.meta.url),
      'utf8',
    );
    expect([...SLOTS]).toEqual(
      JSON.parse((/DEV_SLOTS = (\[[^\]]*\])/.exec(src)?.[1] ?? '[]').replace(/'/g, '"')),
    );
    expect(lockRef('dev')).toBe('locks/dev');
    expect(lockRef('devb')).toBe('locks/devb');
  });

  it('takes slot A when both are free', async () => {
    const g = slots();
    expect((await acquireSlot(g.api, 'ci-bot', SHA, NOW)).slot).toBe('dev');
    expect(g.holderOf('dev')?.branch).toBe('ci-bot');
    expect(g.holderOf('devb')).toBeNull();
  });

  it('falls through to slot B when A is held, tagging B by its own name', async () => {
    const g = slots({ dev: live('flux') });
    const { slot, holder } = await acquireSlot(g.api, 'ci-bot', SHA, NOW);
    expect(slot).toBe('devb');
    expect(g.holderOf('devb')).toEqual(holder);
    expect(g.holderOf('dev')?.branch).toBe('flux'); // neighbour untouched
    expect(
      g.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/tags')).at(-1)?.body,
    ).toMatchObject({ tag: 'locks/devb' });
  });

  it('keeps a branch on the slot it holds, even when A has freed', async () => {
    const g = slots({ devb: live('ci-bot') });
    const { slot } = await acquireSlot(g.api, 'ci-bot', SHA, NOW);
    expect(slot).toBe('devb');
    expect(g.holderOf('dev')).toBeNull();
    expect(Date.parse(g.holderOf('devb')?.expiresAt ?? '')).toBe(NOW + TTL_MS); // renewed
  });

  it('refuses with every holder named when both are held', async () => {
    const g = slots({ dev: live('flux'), devb: live('lc') });
    const err = await acquireSlot(g.api, 'ci-bot', SHA, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockHeld);
    expect((err as LockHeld).held.map((x) => [x.slot, x.holder?.branch])).toEqual([
      ['dev', 'flux'],
      ['devb', 'lc'],
    ]);
    expect((err as LockHeld).message).toMatch(/both dev slots are locked.*lock wait --any/);
  });

  it('takes an expired slot B over when A is live', async () => {
    const g = slots({ dev: live('flux'), devb: expired('old') });
    expect((await acquireSlot(g.api, 'ci-bot', SHA, NOW)).slot).toBe('devb');
    expect(g.holderOf('devb')?.branch).toBe('ci-bot');
  });

  it('takes a named slot only, and never a second one', async () => {
    const free = slots();
    expect((await acquireSlot(free.api, 'ci-bot', SHA, NOW, 'devb')).slot).toBe('devb');
    expect(free.holderOf('dev')).toBeNull();
    const heldB = slots({ devb: live('lc') });
    await expect(acquireSlot(heldB.api, 'ci-bot', SHA, NOW, 'devb')).rejects.toThrow(
      /devb is locked by lc/,
    );
    expect(heldB.holderOf('dev')).toBeNull(); // --slot never falls through
    const onA = slots({ dev: live('ci-bot') });
    await expect(acquireSlot(onA.api, 'ci-bot', SHA, NOW, 'devb')).rejects.toThrow(
      /holds the dev lock — `pnpm bot lock release` first/,
    );
  });

  it('pins a branch with iOS paths to slot A: waits for it, never takes or keeps devb', async () => {
    const ios = ['app/src/auth/x.ts'];
    const heldA = slots({ dev: live('flux') });
    const err = await acquireSlot(heldA.api, 'ci-bot', SHA, NOW, undefined, ios).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LockHeld);
    expect((err as LockHeld).held.map((x) => x.slot)).toEqual(['dev']); // `lock wait`, not --any
    expect(heldA.holderOf('devb')).toBeNull();
    const free = slots();
    expect((await acquireSlot(free.api, 'ci-bot', SHA, NOW, undefined, ios)).slot).toBe('dev');
    const onB = slots({ devb: live('ci-bot') });
    await expect(acquireSlot(onB.api, 'ci-bot', SHA, NOW, undefined, ios)).rejects.toThrow(
      /touches iOS paths \(app\/src\/auth\/x\.ts\).*holds devb — `pnpm bot lock release`/,
    );
    expect(onB.holderOf('devb')?.branch).toBe('ci-bot'); // left as it was
    await expect(acquireSlot(free.api, 'other', SHA, NOW, 'devb', ios)).rejects.toThrow(
      /lock acquire --slot dev/,
    );
    expect(free.holderOf('devb')).toBeNull();
  });

  it('finds, renews and releases only the slot the branch holds', async () => {
    const g = slots({ dev: live('flux'), devb: live('ci-bot') });
    expect(await heldSlot(g.api, 'ci-bot')).toBe('devb');
    expect(await heldSlot(g.api, 'nobody')).toBeNull();
    await renew(g.api, 'ci-bot', NOW + MIN, 'devb');
    expect(Date.parse(g.holderOf('devb')?.expiresAt ?? '')).toBe(NOW + MIN + TTL_MS);
    await expect(release(g.api, 'ci-bot', 'dev')).rejects.toThrow(/does not hold the dev lock/);
    expect(await release(g.api, 'ci-bot', 'devb')).toBe(true);
    expect(g.holderOf('devb')).toBeNull();
    expect(g.holderOf('dev')?.branch).toBe('flux');
  });

  it('shows each slot by name', async () => {
    const g = slots({ devb: live('lc') });
    expect(await status(g.api, NOW, 'dev')).toBe('dev lock: free');
    expect(await status(g.api, NOW, 'devb')).toMatch(/^devb lock: lc @ aaaaaaa until /);
  });

  it('wait --any wakes on whichever slot frees first', async () => {
    const clock = fakeClock(NOW);
    const g = slots({ dev: until('flux', 30 * MIN), devb: until('lc', 10 * MIN) });
    const lines: string[] = [];
    const seen: string[] = [];
    const r = await waitForLock(g.api, 'ci-bot', clock, {
      maxMs: 45 * MIN,
      slots: SLOTS,
      log: (l) => lines.push(l),
      onRead: (_, slot) => seen.push(slot),
    });
    expect(r).toMatchObject({ outcome: 'expired', slot: 'devb' });
    expect(lines[0]).toMatch(/^waiting: devb locked by lc/); // the soonest to free
    expect(new Set(seen)).toEqual(new Set(['dev', 'devb']));
  });

  it('wait --any gives up naming the soonest holder', async () => {
    const clock = fakeClock(NOW);
    const g = slots({ dev: until('flux', 50 * MIN), devb: until('lc', 40 * MIN) });
    const r = await waitForLock(g.api, 'ci-bot', clock, { maxMs: 5 * MIN, slots: SLOTS });
    expect(r).toMatchObject({ outcome: 'gave-up', slot: 'devb' });
    expect(r.holder?.branch).toBe('lc');
  });
});

// A merge's slot deploy waits for the lock (main-dev-wait.ts); the guard keeps every other branch off the slot while
// main's Deploy run is still to land there (main-pending.ts), checked before the ref is written and again after.
describe('main pending', () => {
  const RUN = 'https://github.com/radatta/aperture/actions/runs/1';
  // `busy` says which slots main is pending on; `after` flips a slot to pending once its lock has been written.
  function guard(busy: ('dev' | 'devb')[], after: ('dev' | 'devb')[] = []) {
    const calls: string[] = [];
    let wrote: string[] = [];
    const g = {
      calls,
      wrote: (slot: string) => (wrote = [...wrote, slot]),
      fn: async (slot: 'dev' | 'devb') => {
        calls.push(slot);
        const hit = busy.includes(slot) || (after.includes(slot) && wrote.includes(slot));
        return hit ? RUN : null;
      },
    };
    return g;
  }
  // Marks a slot written when its ref is created, so `after` sees the order: write, then read the runs.
  const withWrites = (g: ReturnType<typeof slots>, p: ReturnType<typeof guard>) => {
    const api = (async (method: string, path: string, body?: unknown) => {
      const out = await g.api(method, path, body);
      if (method === 'POST' && path.endsWith('/git/refs'))
        p.wrote(((body as { ref: string }).ref.split('/').pop() ?? '') as string);
      return out;
    }) as typeof g.api;
    return api;
  };

  it('refuses slot A while main is pending there, before writing, and takes B', async () => {
    const g = slots();
    const p = guard(['dev']);
    const { slot } = await acquireSlot(g.api, 'ci-bot', SHA, NOW, undefined, [], p.fn);
    expect(slot).toBe('devb');
    expect(g.holderOf('dev')).toBeNull();
    expect(
      g.calls.some(
        (c) => c.method === 'POST' && (c.body as { ref?: string })?.ref === 'refs/locks/dev',
      ),
    ).toBe(false);
  });

  it('takes A when main is pending only on B', async () => {
    const g = slots();
    expect(
      (await acquireSlot(g.api, 'ci-bot', SHA, NOW, undefined, [], guard(['devb']).fn)).slot,
    ).toBe('dev');
  });

  it('refuses an iOS-pinned branch with MainPending and plain `lock wait`, leaving no lock', async () => {
    const g = slots();
    const err = await acquireSlot(
      g.api,
      'ci-bot',
      SHA,
      NOW,
      undefined,
      ['app/src/auth/x.ts'],
      guard(['dev']).fn,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MainPending);
    expect((err as MainPending).wait).toBe('lock wait');
    expect((err as MainPending).runs).toEqual([{ slot: 'dev', url: RUN }]);
    expect((err as MainPending).message).toMatch(
      /main's deploy is still to land on dev \(https:.*\) — `pnpm bot lock wait`/,
    );
    expect(g.holderOf('dev')).toBeNull();
    expect(g.holderOf('devb')).toBeNull();
  });

  it('names main and the holder, with `lock wait --any`, when A is pending and B held', async () => {
    const g = slots({ devb: live('lc') });
    const err = await acquireSlot(
      g.api,
      'ci-bot',
      SHA,
      NOW,
      undefined,
      [],
      guard(['dev']).fn,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MainPending);
    expect(err).toBeInstanceOf(LockHeld); // the CLI still prints the holder's notes
    expect((err as MainPending).held.map((x) => [x.slot, x.holder?.branch ?? null])).toEqual([
      ['dev', null],
      ['devb', 'lc'],
    ]);
    expect((err as MainPending).wait).toBe('lock wait --any');
    expect((err as MainPending).message).toMatch(/devb is locked by lc/);
  });

  it('names the live holder main waits for, so the notes say who goes first', async () => {
    const g = slots({ dev: live('flux') });
    const err = await acquireSlot(g.api, 'ci-bot', SHA, NOW, 'dev', [], guard(['dev']).fn).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MainPending);
    expect((err as MainPending).held).toEqual([{ slot: 'dev', holder: live('flux') }]);
    expect((err as MainPending).runs).toEqual([{ slot: 'dev', url: RUN }]);
    expect((err as MainPending).message).toMatch(
      /^dev is locked by flux @ aaaaaaa until .*, and main's deploy is still to land on dev/,
    );
    expect(g.holderOf('dev')?.branch).toBe('flux'); // untouched
  });

  it('releases a lock it just wrote when the second read sees main, and moves on', async () => {
    const g = slots();
    const p = guard([], ['dev']);
    const { slot } = await acquireSlot(withWrites(g, p), 'ci-bot', SHA, NOW, undefined, [], p.fn);
    expect(slot).toBe('devb');
    expect(p.calls).toEqual(['dev', 'dev', 'devb', 'devb']);
    expect(g.holderOf('dev')).toBeNull(); // released
    expect(g.holderOf('devb')?.branch).toBe('ci-bot');
  });

  it('fails closed: a guard error after the write releases the lock and rethrows', async () => {
    const g = slots();
    let n = 0;
    const flaky = async () => {
      if (++n === 2) throw new Error('runs read failed');
      return null;
    };
    await expect(acquireSlot(g.api, 'ci-bot', SHA, NOW, undefined, [], flaky)).rejects.toThrow(
      /runs read failed/,
    );
    expect(g.holderOf('dev')).toBeNull();
    const before = slots();
    await expect(
      acquireSlot(before.api, 'ci-bot', SHA, NOW, undefined, [], () =>
        Promise.reject(new Error('down')),
      ),
    ).rejects.toThrow(/down/);
    expect(before.calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/refs'))).toBe(
      false,
    );
  });

  it('lets the live holder redeploy while main waits for it, without asking', async () => {
    const g = slots({ dev: live('ci-bot') });
    const p = guard(['dev']);
    const { slot } = await acquireSlot(g.api, 'ci-bot', SHA, NOW, undefined, [], p.fn);
    expect(slot).toBe('dev');
    expect(p.calls).toEqual([]);
    expect(Date.parse(g.holderOf('dev')?.expiresAt ?? '')).toBe(NOW + TTL_MS);
  });

  it('treats a lapsed own lock as new: let go when main is pending there, renewed when not', async () => {
    const pending = slots({ dev: expired('ci-bot') });
    const { slot } = await acquireSlot(
      pending.api,
      'ci-bot',
      SHA,
      NOW,
      undefined,
      [],
      guard(['dev']).fn,
    );
    expect(slot).toBe('devb');
    expect(pending.holderOf('dev')).toBeNull(); // a branch holds at most one
    const quiet = slots({ dev: expired('ci-bot') });
    const p = guard([]);
    expect((await acquireSlot(quiet.api, 'ci-bot', SHA, NOW, undefined, [], p.fn)).slot).toBe(
      'dev',
    );
    expect(p.calls).toEqual(['dev', 'dev']);
    expect(Date.parse(quiet.holderOf('dev')?.expiresAt ?? '')).toBe(NOW + TTL_MS);
  });

  it('wait: a free slot main is still to land on is not free yet', async () => {
    const clock = fakeClock(NOW);
    const g = slots();
    let polls = 0;
    const lines: string[] = [];
    const r = await waitForLock(g.api, 'ci-bot', clock, {
      maxMs: 45 * MIN,
      log: (l) => lines.push(l),
      busy: async () => ++polls <= 2,
    });
    expect(r).toMatchObject({ outcome: 'free', slot: 'dev' });
    expect(clock.t).toBe(NOW + 60_000);
    expect(lines).toEqual(["waiting: main's deploy is still to land on dev"]); // once, not per poll
  });

  it('wait --any: returns the slot main is not pending on', async () => {
    const clock = fakeClock(NOW);
    const g = slots({ devb: until('lc', 20 * MIN) });
    const r = await waitForLock(g.api, 'ci-bot', clock, {
      maxMs: 45 * MIN,
      slots: SLOTS,
      busy: async (slot) => slot === 'dev' && clock.t < NOW + 2 * MIN,
    });
    expect(r).toMatchObject({ outcome: 'free', slot: 'dev' });
    expect(clock.t).toBe(NOW + 2 * MIN); // polled every 30 s, never slept to lc's expiry in one go
  });

  it('wait: a lapsed lock main is pending on polls, never spins', async () => {
    const clock = fakeClock(NOW);
    const g = slots({ dev: expired('flux') });
    let sleeps = 0;
    const sleeping = {
      now: clock.now,
      sleep: async (ms: number) => (sleeps++, expect(ms).toBe(30_000), clock.sleep(ms)),
    };
    const r = await waitForLock(g.api, 'ci-bot', sleeping, {
      maxMs: 2 * MIN,
      busy: async () => true,
    });
    expect(r.outcome).toBe('gave-up');
    expect(sleeps).toBe(4);
  });

  it('wait: a failing busy check counts as a failed read; maxErrors sets how many', async () => {
    const clock = fakeClock(NOW);
    const g = slots();
    let n = 0;
    const busy = async () => {
      if (++n <= 4) throw new Error('runs 502');
      return false;
    };
    expect(
      (await waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN, busy, maxErrors: 5 })).outcome,
    ).toBe('free');
    n = 0;
    await expect(waitForLock(g.api, 'ci-bot', clock, { maxMs: 45 * MIN, busy })).rejects.toThrow(
      /runs 502/,
    );
  });
});
