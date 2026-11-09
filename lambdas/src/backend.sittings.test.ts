import { describe, expect, it } from 'vitest';
import { SITTING_INGEST_WINDOW_MS, SITTING_RAW_KEEP_MS, ulid } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { pk, sk } from './ddb/keys';
import { BackendClient } from './backend';

// What the shared contract can't see: the table rows. On prod the ONLY rows that carry `expiresAt` are a
// sitting's raw bulk (snapshots, replay, submit details), 14 days past its ingest window; everything kept
// forever carries none. And a double-fired Start makes one sitting, one rep.
const T0 = 1_700_000_000_000;
function setup(stage = 'prod') {
  const doc = new InMemoryDoc();
  const now = { t: T0 };
  const backend = new BackendClient(new Repo(doc, liveWrites(doc, stage), 'u1'), {
    userId: 'u1',
    now: () => now.t,
  });
  return { doc, backend, now };
}
const start = (clientSittingId = ulid()) => ({
  clientSittingId,
  problemSlug: 'two-sum',
  problemTitle: 'Two Sum',
  lang: 'python3',
  startedAt: T0,
  tzOffsetMinutes: 480,
});
async function linked(b: BackendClient) {
  const roll = await b.upsertRoll({ name: 'LeetCode', categoryId: null, estimateMin: 45 });
  await b.updateSettings({ leetcodeRollId: roll.id });
}

describe('sittings on the table', () => {
  it('stamps expiresAt on the raw bulk only, on prod', async () => {
    const { doc, backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    const ev = (type: string, extra: object) => ({ id: ulid(), type, at: T0 + 1000, ...extra });
    await backend.lcSittingEvents({
      sittingId: sitting.id,
      events: [
        ev('snapshot', { payload: { code: 'a' } }),
        ev('submitDetails', { payload: { code: 'a' } }),
        ev('replay', { events: '[]' }),
        ev('submit', { payload: { result: { status_code: 10 } } }),
        ev('timer', { payload: { state: { status: 'pause', pauseMs: 1 } } }),
      ] as never,
    });
    const rows = await doc.query(pk('u1'), '');
    const due = Math.floor((T0 + SITTING_INGEST_WINDOW_MS + SITTING_RAW_KEEP_MS) / 1000);
    const stamped = rows.filter((r) => r.expiresAt !== undefined);
    expect(stamped.map((r) => (r as { type?: string }).type ?? 'replay').sort()).toEqual([
      'replay',
      'snapshot',
      'submitDetails',
    ]);
    expect(stamped.every((r) => r.expiresAt === due)).toBe(true);
    // Kept forever: the head, the live row (final code + facts), the submit and the timer read.
    for (const key of [sk.sitting(sitting.id), sk.sittingLive(sitting.id)])
      expect((await doc.get(pk('u1'), key))?.expiresAt).toBeUndefined();
    // The entity never shows the table attribute.
    const { events } = await backend.getSitting(sitting.id);
    expect(events.every((e) => !('expiresAt' in e))).toBe(true);
  });

  it('a deleted sitting keeps its rows as tombstones on prod (only the raw bulk ever expires)', async () => {
    const { doc, backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    await backend.deleteSitting(sitting.id);
    const head = await doc.get(pk('u1'), sk.sitting(sitting.id));
    expect(head?.deletedAt).not.toBeNull();
    expect(head?.expiresAt).toBeUndefined();
  });

  // A Start that claimed its head and died before shaping the rep (a timeout, a throttle): its retry finishes
  // it, and a Start on another problem doesn't stay blocked behind it.
  it('a half-made Start finishes on its retry, and never blocks another problem', async () => {
    const { backend, doc } = setup();
    await linked(backend);
    const repo = new Repo(doc, liveWrites(doc, 'prod'), 'u1');
    const half = (await backend.lcSittingStart(start())).sitting;
    await backend.deleteTask(half.repTaskId); // takes the sitting with it — re-make the half-made state:
    const id = ulid();
    await repo.putSittingIfAbsent({
      ...half,
      id,
      clientSittingId: id,
      repTaskId: ulid(),
      deletedAt: null,
    });
    const retry = await backend.lcSittingStart({ ...start(id) });
    expect(retry.resumed).toBe(true);
    expect(await backend.getTask(retry.sitting.repTaskId)).toMatchObject({ status: 'in_progress' });
    // Half-made again, then a Start on another problem: the half-made one is abandoned, the new one opens.
    const id2 = ulid();
    await backend.deleteTask(retry.sitting.repTaskId);
    await repo.putSittingIfAbsent({
      ...half,
      id: id2,
      clientSittingId: id2,
      repTaskId: ulid(),
      deletedAt: null,
    });
    const other = await backend.lcSittingStart({
      ...start(),
      problemSlug: 'three-sum',
      problemTitle: '3Sum',
    });
    expect(other.resumed).toBe(false);
    expect((await backend.getSitting(id2)).sitting.status).toBe('abandoned');
  });

  it('a double-fired Start makes one sitting and one rep', async () => {
    const { backend } = setup();
    await linked(backend);
    const id = ulid();
    const [a, b] = await Promise.all([
      backend.lcSittingStart(start(id)),
      backend.lcSittingStart(start(id)),
    ]);
    expect(a.sitting.id).toBe(b.sitting.id);
    expect([a.resumed, b.resumed].sort()).toEqual([false, true]);
    expect((await backend.listTasks()).filter((t) => t.rollId)).toHaveLength(1);
  });
});
