import { describe, expect, it } from 'vitest';
import {
  LC_START_ATTEMPT_CAP_ERROR,
  LC_START_ATTEMPTS_PER_DAY,
  SITTING_INGEST_WINDOW_MS,
  SITTING_RAW_KEEP_MS,
  ulid,
} from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites, noopWrites } from './ddb/writes';
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
    const { backend, doc, now } = setup();
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
    now.t += 3 * 60_000; // past the in-flight window: a rep-less sitting this old died half-way
    const other = await backend.lcSittingStart({
      ...start(),
      problemSlug: 'three-sum',
      problemTitle: '3Sum',
    });
    expect(other.resumed).toBe(false);
    expect((await backend.getSitting(id2)).sitting.status).toBe('abandoned');
  });

  // A Start that made its rep, then died before titling, planning and starting it: the retry finishes all of it.
  it('a Start that died after making its rep finishes the shaping on its retry', async () => {
    const { backend, doc } = setup();
    await linked(backend);
    const roll = (await backend.listRolls())[0]!;
    const repo = new Repo(doc, liveWrites(doc, 'prod'), 'u1');
    const first = (await backend.lcSittingStart(start())).sitting; // a sitting to copy the shape of
    await backend.deleteTask(first.repTaskId);
    const { task: rep } = await backend.pickRollToday(roll.id, '2023-11-10');
    const id = ulid();
    await repo.putSittingIfAbsent({
      ...first,
      id,
      clientSittingId: id,
      repTaskId: rep.id,
      shapedAt: null,
      deletedAt: null,
    });
    const retry = await backend.lcSittingStart(start(id));
    expect(retry).toMatchObject({ resumed: true, sitting: { shapedAt: expect.any(Number) } });
    expect(await backend.getTask(rep.id)).toMatchObject({
      status: 'in_progress',
      title: 'LeetCode · Two Sum',
    });
    const plans = await backend.listPlansForDay(first.day);
    expect(plans.filter((p) => p.taskId === rep.id)).toHaveLength(1);
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
    const reps = (await backend.listTasks()).filter((t) => t.rollId);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ status: 'in_progress' });
    const plans = await backend.listPlansForDay(a.sitting.day);
    expect(plans.filter((p) => p.taskId === reps[0]!.id)).toHaveLength(1);
  });

  // The Start gate: parallel Starts with different ids — a leaked token's burst — open one sitting, not N.
  it('parallel Starts on different problems open one sitting', async () => {
    const { backend } = setup();
    await linked(backend);
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd'].map((x) =>
        backend.lcSittingStart({ ...start(), problemSlug: `p-${x}`, problemTitle: `P ${x}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await backend.listSittings()).filter((x) => x.status === 'active')).toHaveLength(1);
    expect((await backend.listTasks()).filter((t) => t.rollId)).toHaveLength(1);
  });

  it('a repeated Start never renames the rep: it shapes from the stored sitting', async () => {
    const { backend } = setup();
    await linked(backend);
    const input = start();
    const { sitting } = await backend.lcSittingStart(input);
    await backend.lcSittingStart({ ...input, problemTitle: 'Hijacked' });
    await backend.lcSittingStart({ ...start(), problemTitle: 'Hijacked again' }); // same slug → resume
    expect(await backend.getTask(sitting.repTaskId)).toMatchObject({ title: 'LeetCode · Two Sum' });
  });

  it('counts every Start attempt — refused ones too — and stops at the day’s cap', async () => {
    const { backend } = setup();
    await linked(backend);
    await backend.lcSittingStart(start());
    let refusedFor = '';
    for (let i = 0; i < LC_START_ATTEMPTS_PER_DAY + 1 && !refusedFor; i++)
      await backend
        .lcSittingStart({ ...start(), problemSlug: `x-${i}`, problemTitle: 'X' })
        .catch((e: Error) => {
          if (e.message === LC_START_ATTEMPT_CAP_ERROR) refusedFor = e.message;
        });
    expect(refusedFor).toBe(LC_START_ATTEMPT_CAP_ERROR);
  });
});

// Claude's live pull (live_sitting): the count is its own row, bumped by an atomic add — never the head, which
// ingest's refold rewrites whole and would drop a concurrent bump.
describe('live pulls on the table', () => {
  const judged = (type: 'run' | 'submit', at: number, status = 11) => ({
    id: ulid(),
    type,
    at,
    payload: {
      result: {
        status_code: status,
        status_msg: 'Wrong Answer',
        last_testcase: '[1]',
        code_output: '0',
      },
    },
  });

  it('a pull writes only its count row, and pulls racing a submit all count while the submit folds', async () => {
    const { doc, backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    const before = doc.snapshot();
    await backend.pullLiveSitting();
    const readsKey = sk.sittingReads(sitting.id);
    expect(doc.snapshot().filter((r) => r.SK !== readsKey)).toEqual(before); // the head untouched too
    const reads = await doc.get(pk('u1'), readsKey);
    expect(reads).toMatchObject({ count: 1, sittingId: sitting.id, deletedAt: null });
    expect(reads?.expiresAt).toBeUndefined(); // kept as long as its sitting, on prod

    const pulls = Array.from({ length: 6 }, () => backend.pullLiveSitting());
    const ingest = backend.lcSittingEvents({
      sittingId: sitting.id,
      events: [judged('submit', T0 + 60_000)] as never,
    });
    await Promise.all([...pulls, ingest]);
    const detail = await backend.getSitting(sitting.id);
    expect(detail.liveReads).toBe(7);
    expect(detail.sitting.summary.submits).toBe(1);
  });

  it('the newest Run and Submit come from the judged payloads, by time then id', async () => {
    const { backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    const late = judged('submit', T0 + 9_000);
    await backend.lcSittingEvents({
      sittingId: sitting.id,
      events: [
        late,
        judged('submit', T0 + 5_000),
        judged('run', T0 + 7_000, 15),
        {
          id: ulid(),
          type: 'snapshot',
          at: T0 + 10_000,
          payload: { code: 'x' },
        },
      ] as never,
    });
    const pull = await backend.pullLiveSitting();
    expect(pull.lastSubmit?.id).toBe(late.id);
    expect(pull.lastRun?.at).toBe(T0 + 7_000);
  });

  it('nothing open — none ever, the gate on an ended one, or past the window — writes nothing', async () => {
    const { doc, backend, now } = setup();
    await linked(backend);
    let rows = doc.snapshot();
    expect((await backend.pullLiveSitting()).lastSitting).toBeNull();
    expect(doc.snapshot()).toEqual(rows);

    const { sitting } = await backend.lcSittingStart(start());
    await backend.setTaskActual(sitting.repTaskId, 30);
    await backend.transitionTask(sitting.repTaskId, 'done');
    // The gate's release is best-effort after the head ends: a gate still naming the ended sitting.
    const gate = await doc.get(pk('u1'), sk.lcStart());
    await doc.put({ ...gate!, openSittingId: sitting.id });
    rows = doc.snapshot();
    expect(await backend.pullLiveSitting()).toMatchObject({
      sitting: null,
      lastSitting: { id: sitting.id, status: 'done' },
    });
    expect(doc.snapshot()).toEqual(rows);

    now.t += 60_000;
    const next = await backend.lcSittingStart({
      ...start(),
      problemSlug: 'three-sum',
      startedAt: now.t,
    });
    now.t += SITTING_INGEST_WINDOW_MS + 1;
    rows = doc.snapshot();
    expect(await backend.pullLiveSitting()).toMatchObject({
      sitting: null,
      lastSitting: { id: next.sitting.id, status: 'active' },
    });
    expect(doc.snapshot()).toEqual(rows);
  });

  it('a smoke run (noopWrites) reads the stored count and writes nothing', async () => {
    const { doc, backend } = setup();
    await linked(backend);
    await backend.lcSittingStart(start());
    await backend.pullLiveSitting();
    const smoke = new BackendClient(new Repo(doc, noopWrites(), 'u1'), {
      userId: 'u1',
      now: () => T0,
    });
    const rows = doc.snapshot();
    expect((await smoke.pullLiveSitting()).liveReads).toBe(1);
    expect(doc.snapshot()).toEqual(rows);
  });

  it('deleting the sitting tombstones its count row too', async () => {
    const { doc, backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    await backend.pullLiveSitting();
    await backend.deleteSitting(sitting.id);
    expect((await doc.get(pk('u1'), sk.sittingReads(sitting.id)))?.deletedAt).not.toBeNull();
  });
});
