import { describe, expect, it } from 'vitest';
import { userDueEpoch } from '@aperture/shared';
import type { PushSub, Task } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { PushRegistry } from './ddb/pushRegistry';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { InMemoryPush } from './push/gateway';
import { handlePushTick, parseTickEvent, TICK_SAFETY_MS, tickDeadline } from './pushDispatch';
import { BODY_READ_MS, SEND_TIMEOUT_MS } from './push/livePush';

const NOW = userDueEpoch('2026-11-04', '14:00');
const APP = 'https://app.example';

// One user, one device, one task due now — what a real tick would send.
async function seeded() {
  const doc = new InMemoryDoc();
  const repo = new Repo(doc, liveWrites(doc), 'u1');
  await repo.putPushSub({
    id: 'S1',
    userId: 'u1',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    endpoint: 'https://web.push.apple.com/x',
    p256dh: 'k',
    auth: 'a',
    label: 'iPhone',
    lastOkAt: null,
    lastError: null,
    lastErrorAt: null,
  } satisfies PushSub);
  await new PushRegistry(doc, liveWrites(doc)).addUser('u1', 0);
  await repo.putTask({
    id: 'T1',
    userId: 'u1',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    title: 'x',
    status: 'backlog',
    dueDay: '2026-11-04',
    dueTime: '14:00',
  } as Task);
  return { doc, repo };
}

describe('push dispatch Lambda edge', () => {
  it('takes only the schedule\'s {"mode":"tick"}, refusing anything else before touching anything', () => {
    expect(parseTickEvent({ mode: 'tick' })).toEqual({});
    expect(parseTickEvent({ mode: 'tick', testMode: true, userId: 'ignored' })).toEqual({
      testMode: true,
    });
    expect(parseTickEvent({ mode: 'tick', testMode: 'yes' })).toEqual({});
    for (const bad of [null, undefined, {}, { mode: 'scheduled' }, 'tick'])
      expect(() => parseTickEvent(bad)).toThrow(/mode/);
  });

  it('a testMode event runs over both inert seams: nothing persists, the live gateway is never used', async () => {
    const { doc } = await seeded();
    const push = new InMemoryPush();
    const before = doc.snapshot();
    const report = await handlePushTick(
      doc,
      push,
      { mode: 'tick', testMode: true },
      { now: () => NOW, appUrl: APP, log: () => {} },
    );
    expect(report).toMatchObject({ users: 1, notifications: 1, delivered: 0 });
    expect(push.sends).toHaveLength(0);
    expect(doc.snapshot()).toEqual(before);
    await expect(handlePushTick(doc, push, { mode: 'scheduled' })).rejects.toThrow(/mode/);
    expect(doc.snapshot()).toEqual(before);
  });

  it('a real tick sends through the given gateway', async () => {
    const { doc, repo } = await seeded();
    const push = new InMemoryPush();
    await handlePushTick(
      doc,
      push,
      { mode: 'tick' },
      { now: () => NOW, appUrl: APP, log: () => {} },
    );
    expect(push.sends).toHaveLength(1);
    expect((await repo.getPushSub('S1'))?.lastOkAt).toBe(NOW);
  });

  it("the deadline is Lambda's remaining time less the safety margin; none without a context", () => {
    expect(tickDeadline({ getRemainingTimeInMillis: () => 20_000 }, 1_000)).toBe(
      1_000 + 20_000 - TICK_SAFETY_MS,
    );
    expect(tickDeadline(undefined, 1_000)).toBeUndefined();
    // A send started at the deadline still ends, stamps written, before the 20 s timeout; and 8 s are
    // left to start sends in.
    expect(TICK_SAFETY_MS).toBeGreaterThanOrEqual(SEND_TIMEOUT_MS + BODY_READ_MS + 1_500);
    expect(20_000 - TICK_SAFETY_MS).toBeGreaterThanOrEqual(8_000);
  });
});
