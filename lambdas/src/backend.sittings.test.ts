import { describe, expect, it, vi } from 'vitest';
import {
  LC_START_ATTEMPT_CAP_ERROR,
  LC_START_ATTEMPTS_PER_DAY,
  SITTING_END_SKEW_MS,
  SITTING_IDLE_MS,
  SITTING_IDLE_TAIL_MS,
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

// Late events (the outbox's retries after Done): kept ones write only the ended sitting's own rows, under its
// budget and its raw TTL; a call of nothing but after-end events writes nothing at all.
describe('late events on the table', () => {
  const snap = (code: string, at: number) => ({
    id: ulid(),
    type: 'snapshot',
    at,
    payload: { code },
  });
  const submit = (at: number) => ({
    id: ulid(),
    type: 'submit',
    at,
    payload: { result: { status_code: 10 } },
  });
  async function endedA(b: BackendClient, now: { t: number }) {
    await linked(b);
    const a = (await b.lcSittingStart(start())).sitting;
    await b.lcSittingEvents({ sittingId: a.id, events: [snap('a', T0 + 1000)] as never });
    now.t += 5 * 60_000;
    await b.setTaskActual(a.repTaskId, 5);
    await b.transitionTask(a.repTaskId, 'done');
    return (await b.getSitting(a.id)).sitting;
  }

  it('late events write only the ended sitting’s rows', async () => {
    const { doc, backend, now } = setup();
    const a = await endedA(backend, now);
    now.t += 60_000;
    const b = (
      await backend.lcSittingStart({
        ...start(),
        problemSlug: 'three-sum',
        problemTitle: '3Sum',
        startedAt: now.t,
      })
    ).sitting;
    await backend.lcSittingEvents({
      sittingId: b.id,
      events: [snap('b', now.t + 1000), submit(now.t + 2000)] as never,
    });
    const before = doc.snapshot();
    const kept = snap('late', T0 + 4 * 60_000);
    const skipped = snap('after', a.endedAt! + SITTING_END_SKEW_MS + 1);
    const r = await backend.lcSittingEvents({
      sittingId: a.id,
      events: [kept, submit(T0 + 4 * 60_000 + 1), skipped] as never,
    });
    expect(r).toMatchObject({ accepted: 2, duplicates: 0, skipped: 1, status: 'done' });
    const after = doc.snapshot();
    const ofA = (row: { SK: unknown }) =>
      row.SK === sk.sitting(a.id) || String(row.SK).startsWith(sk.sittingChildPrefix(a.id));
    // The gate, the rep, and B's head, live row and events: all as they were.
    expect(after.filter((row) => !ofA(row))).toEqual(before.filter((row) => !ofA(row)));
    expect(after.some((row) => String(row.SK).includes(skipped.id))).toBe(false);
    expect(await doc.get(pk('u1'), sk.sittingBudget(a.id))).toMatchObject({ events: 3 }); // 1 + the 2 kept
    expect((await doc.get(pk('u1'), sk.sittingEvent(a.id, kept.id)))?.expiresAt).toBe(
      Math.floor((T0 + SITTING_INGEST_WINDOW_MS + SITTING_RAW_KEEP_MS) / 1000),
    );
    expect((await backend.getSitting(a.id)).sitting).toMatchObject({
      status: 'done',
      endedAt: a.endedAt,
      summary: { submits: 1 },
    });
    expect((await backend.pullLiveSitting()).sitting?.id).toBe(b.id);
  });

  it('a call of only after-end events writes nothing', async () => {
    const { doc, backend, now } = setup();
    const a = await endedA(backend, now);
    now.t += 60_000;
    const rows = doc.snapshot();
    const g0 = doc.gets.length;
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)));
    const r = await backend.lcSittingEvents({
      sittingId: a.id,
      events: [snap('x', a.endedAt! + SITTING_END_SKEW_MS + 1), submit(now.t + 1)] as never,
    });
    vi.restoreAllMocks();
    expect(r).toEqual({ accepted: 0, duplicates: 0, skipped: 2, version: 1, status: 'done' });
    expect(doc.snapshot()).toEqual(rows);
    expect(doc.gets.slice(g0).every((g) => g.consistent)).toBe(true);
    expect(logs.map((l) => JSON.parse(l))).toContainEqual(
      expect.objectContaining({ event: 'lc_ingest', accepted: 0, skipped: 2, late: true }),
    );
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
    const [g0, q0] = [doc.gets.length, doc.queries.length];
    await backend.pullLiveSitting();
    // Every read the pull made is strongly consistent: a pull right after a write must see it.
    expect(doc.gets.slice(g0).every((g) => g.consistent)).toBe(true);
    expect(doc.queries.slice(q0).every((q) => q.consistent)).toBe(true);
    const readsKey = sk.sittingReads(sitting.id);
    expect(doc.snapshot().filter((r) => r.SK !== readsKey)).toEqual(before); // the head untouched too
    const reads = await doc.get(pk('u1'), readsKey);
    expect(reads).toMatchObject({
      count: 1,
      sittingId: sitting.id,
      deletedAt: null,
      updatedAt: T0,
    });
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

  it('nothing open — none ever, the gate on an ended one, or past the window — writes nothing but an idle close', async () => {
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
    // Idle long before its window ran out: the first pull closes it (its only write), the next writes nothing.
    expect(await backend.pullLiveSitting()).toMatchObject({
      sitting: null,
      lastSitting: { id: next.sitting.id, status: 'abandoned', closedBy: 'idle' },
    });
    rows = doc.snapshot();
    expect((await backend.pullLiveSitting()).lastSitting?.id).toBe(next.sitting.id);
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

  it('a pull whose reads fail counts nothing; a count that fails still answers, with the stored count', async () => {
    const { doc, backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    const query = vi.spyOn(doc, 'query').mockRejectedValueOnce(new Error('throttled'));
    await expect(backend.pullLiveSitting()).rejects.toThrow('throttled');
    expect(await doc.get(pk('u1'), sk.sittingReads(sitting.id))).toBeNull();
    query.mockRestore();
    vi.spyOn(doc, 'add').mockRejectedValueOnce(new Error('throttled'));
    expect(await backend.pullLiveSitting()).toMatchObject({
      sitting: { id: sitting.id },
      liveReads: 0,
    });
    expect((await backend.pullLiveSitting()).liveReads).toBe(1);
  });

  it('inactive pulls read consistently too: right after Done, the last sitting reads done', async () => {
    const { doc, backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    await backend.setTaskActual(sitting.repTaskId, 30);
    await backend.transitionTask(sitting.repTaskId, 'done');
    const [g0, q0] = [doc.gets.length, doc.queries.length];
    expect((await backend.pullLiveSitting()).lastSitting?.status).toBe('done');
    expect(doc.gets.slice(g0).every((g) => g.consistent)).toBe(true);
    expect(doc.queries.slice(q0).every((q) => q.consistent)).toBe(true);
  });
});

// The review rides the head (setSittingReview); ingest's refold rewrites the head too. Both are CAS writes that
// spread the current head, so neither drops the other however they interleave.
describe('the review on the head', () => {
  const judged = (type: 'run' | 'submit', at: number) => ({
    id: ulid(),
    type,
    at,
    payload: { result: { status_code: 11, status_msg: 'Wrong Answer' } },
  });
  it('a review saved while a submit is ingested: both land', async () => {
    const { backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    const review = {
      insight: 'kept',
      help: 'hint' as const,
      mistakes: ['m'],
      howItWent: null,
      tags: ['dp'],
      draftUsed: false,
    };
    await Promise.all([
      backend.setSittingReview(sitting.id, review),
      backend.lcSittingEvents({
        sittingId: sitting.id,
        events: [judged('submit', T0 + 60_000)] as never,
      }),
      backend.setSittingPrepTarget(sitting.id, 'Google'),
    ]);
    const head = (await backend.getSitting(sitting.id)).sitting;
    expect(head.summary.submits).toBe(1);
    expect(head.review).toMatchObject({ ...review, updatedAt: T0 });
    expect(head.prepTarget).toBe('Google');
  });

  it('deleting the sitting takes its review with the head', async () => {
    const { backend } = setup();
    await linked(backend);
    const { sitting } = await backend.lcSittingStart(start());
    await backend.setSittingReview(sitting.id, {
      insight: 'x',
      help: 'none',
      mistakes: [],
      howItWent: null,
      tags: [],
      draftUsed: false,
    });
    await backend.deleteSitting(sitting.id);
    await expect(backend.getSitting(sitting.id)).rejects.toThrow(/Not found/);
    expect(await backend.listSittings()).toEqual([]);
  });
});

describe('idle close on the table', () => {
  const idle = async () => {
    const t = setup();
    await linked(t.backend);
    const { sitting } = await t.backend.lcSittingStart(start());
    t.now.t += SITTING_IDLE_MS + 1;
    return { ...t, sitting };
  };
  const headRow = async (doc: InMemoryDoc, id: string) => doc.get(pk('u1'), sk.sitting(id));

  it('reads at once close it once, at the same end, and log one close', async () => {
    const { backend, doc, sitting } = await idle();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await Promise.all([
        backend.listSittings(),
        backend.getSitting(sitting.id),
        backend.pullLiveSitting(),
        backend.getCoachToday(),
      ]);
      const closes = log.mock.calls.filter((c) => String(c[0]).includes('lc_sitting_idle_close'));
      expect(closes).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
    expect(await headRow(doc, sitting.id)).toMatchObject({
      status: 'abandoned',
      closedBy: 'idle',
      endedAt: T0 + SITTING_IDLE_TAIL_MS,
    });
    expect((await doc.get(pk('u1'), sk.lcStart()))?.openSittingId).toBeNull();
  });

  it('the coach’s read closes it too', async () => {
    const { backend, doc, sitting } = await idle();
    await backend.getCoachToday();
    expect(await headRow(doc, sitting.id)).toMatchObject({ closedBy: 'idle' });
  });

  it('below the line a read costs no activity read', async () => {
    const { backend, now } = setup();
    await linked(backend);
    await backend.lcSittingStart(start());
    now.t += SITTING_IDLE_MS;
    const spy = vi.spyOn(Repo.prototype, 'getSittingActivity');
    try {
      await backend.listSittings();
      expect(spy).not.toHaveBeenCalled();
      now.t += 1;
      await backend.listSittings();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a smoke run (noopWrites) reads it closed and writes nothing', async () => {
    const { doc, now, sitting } = await idle();
    const smoke = new BackendClient(new Repo(doc, noopWrites(), 'u1'), {
      userId: 'u1',
      now: () => now.t,
    });
    const rows = doc.snapshot();
    expect((await smoke.listSittings())[0]).toMatchObject({ id: sitting.id, closedBy: 'idle' });
    expect(doc.snapshot()).toEqual(rows);
  });

  it('a reopen racing a Start on another problem leaves one sitting open, holding the gate', async () => {
    const { backend, doc, sitting } = await idle();
    await backend.listSittings(); // closed
    await Promise.allSettled([
      backend.reopenSitting(sitting.id),
      backend.lcSittingStart({ ...start(), problemSlug: 'add-two-numbers', startedAt: T0 }),
    ]);
    const open = (await backend.listSittings()).filter((x) => x.status === 'active');
    expect(open).toHaveLength(1);
    expect((await doc.get(pk('u1'), sk.lcStart()))?.openSittingId).toBe(open[0]!.id);
  });

  it('a reopen whose head was finished meanwhile frees the gate again', async () => {
    const { backend, doc, sitting } = await idle();
    await backend.listSittings(); // closed
    // The rep is Done between the reopen's checks and its head write: the head reads done when the CAS runs.
    const real = Repo.prototype.casUpdate;
    const spy = vi.spyOn(Repo.prototype, 'casUpdate').mockImplementation(async function (
      this: Repo,
      ...args: Parameters<Repo['casUpdate']>
    ) {
      const [shape, id] = args;
      if (shape.sk === sk.sitting(sitting.id) && id === sitting.id) {
        const cur = await doc.get(pk('u1'), sk.sitting(sitting.id));
        await doc.put({ ...cur!, status: 'done' });
        spy.mockRestore();
      }
      return real.apply(this, args as never);
    } as never);
    await expect(backend.reopenSitting(sitting.id)).rejects.toThrow(/moved on/);
    expect((await doc.get(pk('u1'), sk.lcStart()))?.openSittingId).toBeNull();
  });

  it('an MCP read (idlePeek) reads it closed and writes nothing; the app’s next read writes the same end', async () => {
    const { doc, now, backend, sitting } = await idle();
    const rows = doc.snapshot();
    const peek = new BackendClient(new Repo(doc, liveWrites(doc, 'prod'), 'u1'), {
      userId: 'u1',
      now: () => now.t,
      idlePeek: true,
    });
    const seen = (await peek.listSittings())[0];
    expect(seen).toMatchObject({
      id: sitting.id,
      closedBy: 'idle',
      endedAt: T0 + SITTING_IDLE_TAIL_MS,
    });
    expect((await peek.pullLiveSitting()).lastSitting).toMatchObject({ closedBy: 'idle' });
    expect(doc.snapshot()).toEqual(rows);
    expect((await backend.listSittings())[0]).toMatchObject({
      closedBy: 'idle',
      endedAt: seen!.endedAt,
    });
  });

  it('a rep finished with its hook missed: the idle read ends the sitting as its rep did, not as idle', async () => {
    const { doc, backend, sitting } = await idle();
    const rep = await doc.get(pk('u1'), sk.task(sitting.repTaskId));
    await doc.put({ ...rep!, status: 'done', completedAt: T0 + 2 * 60_000 }); // Done, no sitting hook
    const [s] = await backend.listSittings();
    expect(s).toMatchObject({ status: 'done', endedAt: T0 + 2 * 60_000 });
    expect(s!.closedBy ?? null).toBeNull();
  });

  it('a fault reopening on an event fails the call, so the extension retries; a refusal ingests', async () => {
    const { backend, now, sitting } = await idle();
    await backend.listSittings(); // closed
    const real = Repo.prototype.casUpdate;
    const spy = vi.spyOn(Repo.prototype, 'casUpdate').mockImplementation(async function (
      this: Repo,
      ...args: Parameters<Repo['casUpdate']>
    ) {
      if (args[0].sk === sk.lcStart()) throw new Error('DynamoDB fault');
      return real.apply(this, args as never);
    } as never);
    const ev = () => ({ id: ulid(), type: 'snapshot', at: now.t, payload: { code: 'b' } });
    try {
      await expect(
        backend.lcSittingEvents({ sittingId: sitting.id, events: [ev()] as never }),
      ).rejects.toThrow('DynamoDB fault');
    } finally {
      spy.mockRestore();
    }
    // Refused (another sitting open): the events after the end are skipped, the call answers.
    await backend.lcSittingStart({ ...start(), problemSlug: 'add-two-numbers', startedAt: now.t });
    const r = await backend.lcSittingEvents({ sittingId: sitting.id, events: [ev()] as never });
    expect(r).toMatchObject({ accepted: 0, skipped: 1, status: 'abandoned' });
  });
});
