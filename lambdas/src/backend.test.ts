import { describe, expect, it } from 'vitest';
import { InMemoryDoc, type Item } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites, noopWrites } from './ddb/writes';
import { sk } from './ddb/keys';
import { toEntity } from './ddb/mapping';
import { BackendClient } from './backend';
import { handleRpc } from './handler';
import { fakePresigner } from './s3/presigner';
import { fakeObjectStore } from './s3/objects';
import type { Presigner } from './s3/presigner';
import { ulid, type RecordFluxSetInput, type Task } from '@aperture/shared';

// The contract suite proves list-level behavior against both impls, but it can't tell a soft-delete from a
// hard one — both just make the row vanish from the list. TECH.md's tech-debt ledger asks any new delete
// path to prove the difference, so this reaches under the facade: after deleteStory the row is still in the
// table with a tombstone (recoverable / export-auditable), yet filtered out of listStories.
describe('backend story soft-delete', () => {
  it('tombstones the row — kept in the table, gone from the list', async () => {
    const doc = new InMemoryDoc();
    let clock = 1_700_000_000_000;
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now: () => clock,
    });

    const s = await backend.createStory({ title: 'To be deleted' });
    clock += 1000;
    await backend.deleteStory(s.id);

    // Still physically present, with a tombstone — not hard-deleted.
    const raw = await doc.get('u#local', sk.story(s.id));
    expect(raw).toBeTruthy();
    expect(raw!.deletedAt).not.toBeNull();

    // But filtered out of the live list.
    expect((await backend.listStories()).map((x) => x.id)).not.toContain(s.id);
  });
});

describe('backend attachments', () => {
  const setup = (userId = 'local') => {
    const doc = new InMemoryDoc();
    let clock = 1_700_000_000_000;
    const objects = fakeObjectStore();
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), userId), {
      userId,
      now: () => clock,
      presigner: fakePresigner(),
      objects,
    });
    return { doc, backend, objects, tick: (ms: number) => (clock += ms) };
  };

  it('keys the S3 object by user + task + id, never the filename', async () => {
    const { backend } = setup();
    const task = await backend.createTask({ title: 'has a file' });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'secret quarterly report.pdf',
      contentType: 'application/pdf',
      size: 100,
    });
    expect(attachment.s3Key).toBe(`u/local/${task.id}/${attachment.id}`);
    expect(attachment.s3Key).not.toContain('secret');
  });

  it('tombstones on delete — kept in the table, gone from the list', async () => {
    const { doc, backend, objects, tick } = setup();
    const task = await backend.createTask({ title: 't' });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.png',
      contentType: 'image/png',
      size: 10,
    });
    await backend.confirmAttachment(attachment.id);
    tick(1000);
    await backend.deleteAttachment(attachment.id);

    const raw = await doc.get('u#local', sk.attach(task.id, attachment.id));
    expect(raw).toBeTruthy(); // the metadata row stays, tombstoned (recoverable / export-auditable)
    expect(raw!.deletedAt).not.toBeNull();
    expect(await backend.listAttachments(task.id)).toHaveLength(0);
    expect(objects.deleted).toEqual([attachment.s3Key]); // the bytes go
  });

  it('a failed S3 delete throws and leaves the row live, so a retry finishes it', async () => {
    const { doc, backend, objects } = setup();
    const task = await backend.createTask({ title: 't' });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.png',
      contentType: 'image/png',
      size: 10,
    });
    await backend.confirmAttachment(attachment.id);
    objects.failNext = new Error('AccessDenied');
    await expect(backend.deleteAttachment(attachment.id)).rejects.toThrow('AccessDenied');
    expect((await doc.get('u#local', sk.attach(task.id, attachment.id)))!.deletedAt).toBeNull();
    expect((await backend.listAttachments(task.id)).map((a) => a.id)).toEqual([attachment.id]);

    await backend.deleteAttachment(attachment.id);
    expect(objects.deleted).toEqual([attachment.s3Key]);
    expect(await backend.listAttachments(task.id)).toHaveLength(0);
  });

  it('makes no S3 call for an unknown or already-deleted id', async () => {
    const { backend, objects } = setup();
    const task = await backend.createTask({ title: 't' });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.png',
      contentType: 'image/png',
      size: 10,
    });
    await backend.deleteAttachment(attachment.id);
    await backend.deleteAttachment(attachment.id);
    await backend.deleteAttachment('nope');
    expect(objects.deleted).toEqual([attachment.s3Key]);
  });

  it('throws on delete when no object store is configured — never skips the bytes', async () => {
    const doc = new InMemoryDoc();
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      presigner: fakePresigner(),
    });
    const task = await backend.createTask({ title: 't' });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.png',
      contentType: 'image/png',
      size: 10,
    });
    await expect(backend.deleteAttachment(attachment.id)).rejects.toThrow('no object store');
    expect(await backend.listAttachments()).toHaveLength(0); // pending, never listed
    expect((await doc.get('u#local', sk.attach(task.id, attachment.id)))!.deletedAt).toBeNull();
  });

  it('keeps a task’s attachments after the task is cancelled (cancel ≠ delete)', async () => {
    const { backend } = setup();
    const task = await backend.createTask({ title: 'to cancel' });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.png',
      contentType: 'image/png',
      size: 10,
    });
    await backend.confirmAttachment(attachment.id);
    await backend.transitionTask(task.id, 'cancelled');
    // A cancelled task is still a record; its files stay attached. A future deleteTask is what would
    // cascade-tombstone them — see localNotes/pr2-delete-task.md.
    expect((await backend.listAttachments(task.id)).map((a) => a.id)).toEqual([attachment.id]);
  });

  it('does not leak an attachment across users (confirm on another user’s id 404s)', async () => {
    const doc = new InMemoryDoc();
    const now = () => 1_700_000_000_000;
    const alice = new BackendClient(new Repo(doc, liveWrites(doc), 'alice'), {
      userId: 'alice',
      now,
      presigner: fakePresigner(),
    });
    const task = await alice.createTask({ title: 'alice task' });
    const { attachment } = await alice.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.png',
      contentType: 'image/png',
      size: 10,
    });
    await alice.confirmAttachment(attachment.id);

    // Bob goes through the real RPC dispatch against the same table but his own partition → not found.
    await expect(
      handleRpc(
        doc,
        { userId: 'bob', method: 'confirmAttachment', args: [attachment.id], now },
        { presigner: fakePresigner() },
      ),
    ).rejects.toThrow();
  });

  it('signs inline disposition for viewable types and a download for the rest', async () => {
    const doc = new InMemoryDoc();
    const now = () => 1_700_000_000_000;
    const seen: string[] = [];
    const presigner: Presigner = {
      putUrl: async (k) => `fake://put/${k}`,
      getUrl: async (k, _t, d) => {
        seen.push(d);
        return `fake://get/${k}`;
      },
    };
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now,
      presigner,
    });
    const task = await backend.createTask({ title: 'files' });
    const md = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'notes.md',
      contentType: 'text/markdown',
      size: 10,
    });
    await backend.confirmAttachment(md.attachment.id);
    const svg = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'logo.svg',
      contentType: 'image/svg+xml',
      size: 10,
    });
    await backend.confirmAttachment(svg.attachment.id);

    await backend.getAttachmentDownloadUrl(md.attachment.id);
    await backend.getAttachmentDownloadUrl(svg.attachment.id);
    expect(seen[0]).toBe('inline'); // text/markdown renders in the tab
    expect(seen[1]).toMatch(/^attachment; filename\*=UTF-8''/); // svg is forced to download
  });
});

describe('backend task delete', () => {
  const setup = (userId = 'local') => {
    const doc = new InMemoryDoc();
    let clock = 1_700_000_000_000;
    const objects = fakeObjectStore();
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), userId), {
      userId,
      now: () => clock,
      presigner: fakePresigner(),
      objects,
    });
    return { doc, backend, objects, tick: (ms: number) => (clock += ms) };
  };

  it('tombstones the task, its plans, and its attachment metadata — kept in the table, gone from every list', async () => {
    const { doc, backend, tick } = setup();
    const task = await backend.createTask({ title: 'doomed' });
    const plan = await backend.upsertPlan({
      taskId: task.id,
      day: '2026-08-04',
      plannedMinutes: 30,
      order: 1,
    });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.png',
      contentType: 'image/png',
      size: 10,
    });
    await backend.confirmAttachment(attachment.id);

    const before = doc.size;
    tick(1000);
    await backend.deleteTask(task.id);

    // Nothing hard-deleted: every row still physically present, now tombstoned.
    expect(doc.size).toBe(before);
    const rawTask = await doc.get('u#local', sk.task(task.id));
    const rawPlan = await doc.get('u#local', sk.plan('2026-08-04', 1, plan.id));
    const rawAttach = await doc.get('u#local', sk.attach(task.id, attachment.id));
    expect(rawTask!.deletedAt).not.toBeNull();
    expect(rawPlan!.deletedAt).not.toBeNull();
    expect(rawAttach!.deletedAt).not.toBeNull();

    // But gone from every live list + read.
    expect(await backend.getTask(task.id)).toBeNull();
    expect(await backend.listPlansForDay('2026-08-04')).toHaveLength(0);
    expect(await backend.listAttachments(task.id)).toHaveLength(0);
  });

  it('deletes the bytes of every attachment — ready, pending, and on its parts', async () => {
    const { backend, objects } = setup();
    const parent = await backend.createTask({ title: 'parent' });
    const part = await backend.createTask({ title: 'part', parentId: parent.id });
    const add = (taskId: string, filename: string) =>
      backend.createAttachmentUploadUrl({ taskId, filename, contentType: 'text/plain', size: 5 });
    const ready = (await add(parent.id, 'ready.txt')).attachment;
    await backend.confirmAttachment(ready.id);
    const pending = (await add(parent.id, 'pending.txt')).attachment; // never confirmed
    const onPart = (await add(part.id, 'part.txt')).attachment;
    await backend.confirmAttachment(onPart.id);

    await backend.deleteTask(parent.id);
    expect([...objects.deleted].sort()).toEqual([ready.s3Key, pending.s3Key, onPart.s3Key].sort());
    expect(await backend.getTask(part.id)).toBeNull();
  });

  it('a failed S3 delete touches nothing else — task, plans intact; the retry completes the cascade', async () => {
    const { backend, objects } = setup();
    const task = await backend.createTask({ title: 'retry me' });
    await backend.upsertPlan({ taskId: task.id, day: '2026-08-04', plannedMinutes: 30, order: 1 });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 5,
    });
    await backend.confirmAttachment(attachment.id);
    objects.failNext = new Error('SlowDown');
    await expect(backend.deleteTask(task.id)).rejects.toThrow('SlowDown');
    expect(await backend.getTask(task.id)).not.toBeNull();
    expect(await backend.listPlansForDay('2026-08-04')).toHaveLength(1); // bytes go before the plans
    expect(await backend.listAttachments(task.id)).toHaveLength(1);

    await backend.deleteTask(task.id);
    expect(await backend.getTask(task.id)).toBeNull();
    expect(await backend.listPlansForDay('2026-08-04')).toHaveLength(0);
    expect(objects.deleted).toEqual([attachment.s3Key]);
  });

  it('reads the attachments strongly, so a just-deleted file isn’t deleted twice', async () => {
    const { doc, backend, objects } = setup();
    const task = await backend.createTask({ title: 'fresh file' });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: task.id,
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 5,
    });
    const key = sk.attach(task.id, attachment.id);
    const live = await doc.get('u#local', key);
    doc.staleNextQueries('u#local', key, live, 20); // an eventual read keeps seeing the live copy
    await backend.deleteTask(task.id);
    expect(objects.deleted).toEqual([attachment.s3Key]);
    expect((await doc.get('u#local', key))!.deletedAt).not.toBeNull();
  });

  it('a failed S3 delete on a part leaves the parent and every part alive', async () => {
    const { backend, objects } = setup();
    const parent = await backend.createTask({ title: 'parent' });
    const a = await backend.createTask({ title: 'a', parentId: parent.id });
    const b = await backend.createTask({ title: 'b', parentId: parent.id });
    const { attachment } = await backend.createAttachmentUploadUrl({
      taskId: b.id,
      filename: 'b.txt',
      contentType: 'text/plain',
      size: 5,
    });
    objects.failNext = new Error('AccessDenied');
    await expect(backend.deleteTask(parent.id)).rejects.toThrow('AccessDenied');
    for (const t of [parent, a, b]) expect(await backend.getTask(t.id)).not.toBeNull();

    await backend.deleteTask(parent.id);
    for (const t of [parent, a, b]) expect(await backend.getTask(t.id)).toBeNull();
    expect(objects.deleted).toEqual([attachment.s3Key]);
  });

  it('is a no-op on an unknown or already-deleted id', async () => {
    const { backend } = setup();
    await expect(backend.deleteTask('nope')).resolves.toBeUndefined();
    const task = await backend.createTask({ title: 'once' });
    await backend.deleteTask(task.id);
    await expect(backend.deleteTask(task.id)).resolves.toBeUndefined(); // second delete idempotent
  });

  it('persists nothing under noopWrites (testMode safety)', async () => {
    const doc = new InMemoryDoc();
    const now = () => 1_700_000_000_000;
    const live = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now,
    });
    const task = await live.createTask({ title: 'survives' });

    const noop = new BackendClient(new Repo(doc, noopWrites(), 'local'), { userId: 'local', now });
    await noop.deleteTask(task.id);

    expect(await live.getTask(task.id)).not.toBeNull(); // nothing tombstoned
  });

  it('persists nothing under noopWrites on the parent + parts paths either', async () => {
    const doc = new InMemoryDoc();
    const now = () => 1_700_000_000_000;
    const live = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now,
    });
    const p = await live.createTask({ title: 'P2', estimateMin: 60 });
    const a = await live.createTask({ title: 'a', estimateMin: 30 });
    const solo = await live.createTask({ title: 'solo', estimateMin: 30 });
    const before = JSON.stringify(await live.exportData());

    const noop = new BackendClient(new Repo(doc, noopWrites(), 'local'), { userId: 'local', now });
    // Some of these fail part-way under noop (a write that "landed" can't be read back) — what matters
    // is that none of them leaves anything behind.
    const attempts: (() => Promise<unknown>)[] = [
      () => noop.createTasks([{ title: 'part', parentId: p.id }]),
      () => noop.setTaskParent(a.id, p.id),
      () =>
        noop.splitTask(solo.id, { finish: 'keep', followUp: { title: 'rest', estimateMin: 10 } }),
      () => noop.transitionTask(p.id, 'cancelled'),
      () => noop.deleteTask(p.id),
    ];
    for (const attempt of attempts) await attempt().catch(() => undefined);

    expect(JSON.stringify(await live.exportData())).toBe(before);
  });
});

// Flux sets (D47): what the contract suite can't see — the row stays in the table on delete, a smoke request
// writes nothing, and a concurrent retry that wins the conditional write is returned rather than overwritten.
describe('backend flux sets', () => {
  const setup = () => {
    const doc = new InMemoryDoc();
    const now = () => 1_700_000_000_000;
    const live = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now,
    });
    const noop = new BackendClient(new Repo(doc, noopWrites(), 'local'), { userId: 'local', now });
    return { doc, live, noop };
  };
  const input = (id: string): RecordFluxSetInput => ({
    id,
    day: '2026-10-20',
    exerciseId: 'chin-tuck',
    kind: 'holdAtTarget',
    side: null,
    condition: null,
    count: 10,
    rom: { pitch: 8, yaw: 1, roll: 1 },
    calibrated: true,
    delegate: 'CPU',
    durationSec: 120,
    completedAt: 1_700_000_000_000,
    repTaskId: null,
    stoppedEarly: false,
    planned: 10,
  });

  it('a delete tombstones the row under flux#<day>#<id> — kept in the table, gone from the list', async () => {
    const { doc, live } = setup();
    const set = await live.recordFluxSet(input(ulid()));
    await live.deleteFluxSet(set.id);
    const raw = await doc.get('u#local', sk.flux('2026-10-20', set.id));
    expect(raw?.deletedAt).toBe(1_700_000_000_000);
    expect(await live.listFluxSets()).toEqual([]);
  });

  it('persists nothing under noopWrites', async () => {
    const { live, noop } = setup();
    const kept = await live.recordFluxSet(input(ulid()));
    await noop.recordFluxSet(input(ulid()));
    await noop.deleteFluxSet(kept.id);
    expect((await live.listFluxSets()).map((s) => s.id)).toEqual([kept.id]);
  });

  it('a delete right after the save finds the row, read strongly', async () => {
    const { doc, live } = setup();
    const set = await live.recordFluxSet(input(ulid()));
    doc.staleNextQueries('u#local', sk.flux(set.day, set.id), null, 5); // not visible to an eventual read yet
    await live.deleteFluxSet(set.id);
    const row = await new Repo(doc, liveWrites(doc), 'local').findFluxSet(set.id, {
      consistent: true,
    });
    expect(row?.deletedAt).toBe(1_700_000_000_000);
  });

  it('a retry that loses the conditional write returns the row that won, read strongly', async () => {
    const { doc, live } = setup();
    const id = ulid();
    const winner = { ...input(id), count: 7 };
    doc.interceptNextPutIf('u#local', sk.flux('2026-10-20', id), () => {
      // The winner isn't visible to an eventual read yet — only a consistent one finds it.
      doc.staleNextQueries('u#local', sk.flux('2026-10-20', id), null, 5);
      doc.putNow({
        PK: 'u#local',
        SK: sk.flux('2026-10-20', id),
        ...winner,
        avgPeakDeg: null,
        avgErrorDeg: null,
        userId: 'local',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      });
    });
    const got = await live.recordFluxSet(input(id));
    expect(got.count).toBe(7);
    expect(await live.listFluxSets()).toEqual([]); // an eventual read still misses it — the case above
  });
});

// Rows written before notes existed have no attribute at all, so they read back undefined (not null).
// The contract suite only ever sees fresh rows; this proves a legacy row still reads and takes notes.
describe('backend task notes on a legacy row', () => {
  it('reads back undefined, and can have notes set', async () => {
    const doc = new InMemoryDoc();
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now: () => 1_700_000_000_000,
    });
    const task = await backend.createTask({ title: 'from before notes' });
    const raw = await doc.get('u#local', sk.task(task.id));
    const legacy = { ...raw! };
    delete legacy.notes;
    await doc.put(legacy);

    expect((await backend.getTask(task.id))?.notes).toBeUndefined();
    expect((await backend.setTaskNotes(task.id, 'added later')).notes).toBe('added later');
    expect((await backend.getTask(task.id))?.notes).toBe('added later');
  });
});

// Every read whose copy is written back is strongly consistent: two quick RPCs on one task (a title,
// then its due) must never write the first one's older copy back over it.
describe('backend read-then-write under lagging reads', () => {
  const setup = () => {
    const doc = new InMemoryDoc();
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now: () => 1_700_000_000_000,
    });
    // Plain gets (and list queries) of `id` keep showing the copy from before the next write.
    const snapshot = async (id: string) => {
      const before = await doc.get('u#local', sk.task(id));
      return () => {
        doc.staleNextGets('u#local', sk.task(id), before, 20);
        doc.staleNextQueries('u#local', sk.task(id), before, 20);
      };
    };
    const stored = async (id: string) =>
      toEntity<Task>((await doc.get('u#local', sk.task(id), { consistent: true }))!);
    return { backend, snapshot, stored, doc };
  };

  it('a due set straight after a rename keeps the new title', async () => {
    const { backend, snapshot } = setup();
    const t = await backend.createTask({ title: 'old' });
    const lag = await snapshot(t.id);
    await backend.setTaskTitle(t.id, 'new');
    lag();
    const saved = await backend.setTaskDue(t.id, { dueDay: '2026-08-05', dueTime: null });
    expect(saved).toMatchObject({ title: 'new', dueDay: '2026-08-05' });
  });

  it('a part added straight after renaming its parent keeps the new title', async () => {
    const { backend, snapshot, stored } = setup();
    const p = await backend.createTask({ title: 'old' });
    const lag = await snapshot(p.id);
    await backend.setTaskTitle(p.id, 'new');
    lag();
    await backend.createTask({ title: 'part', parentId: p.id });
    expect((await stored(p.id)).title).toBe('new');
  });

  it('a focus session stopped straight after a rename keeps the title', async () => {
    const { backend, snapshot, stored } = setup();
    const t = await backend.createTask({ title: 'old' });
    const s = await backend.startSession({
      taskId: t.id,
      categoryId: null,
      kind: 'work',
      day: '2026-08-04',
    });
    const lag = await snapshot(t.id);
    await backend.setTaskTitle(t.id, 'new');
    lag();
    await backend.stopSession(s.id, 'completed');
    expect((await stored(t.id)).title).toBe('new');
  });

  it('deleting a category straight after a rename keeps the title', async () => {
    const { backend, snapshot, stored } = setup();
    const cat = await backend.upsertCategory({ label: 'Old', isWork: true });
    const to = await backend.upsertCategory({ label: 'New', isWork: true });
    const t = await backend.createTask({ title: 'old', categoryId: cat.id });
    const lag = await snapshot(t.id);
    await backend.setTaskTitle(t.id, 'new');
    lag();
    await backend.deleteCategory(cat.id, to.id);
    expect(await stored(t.id)).toMatchObject({ title: 'new', categoryId: to.id });
  });

  // The other written-back rows — plans, the day row, categories, settings, stories, habits and their
  // checks — the same way: a plain get (or list query) of the key keeps showing `snapshot`.
  const lagKey = (doc: InMemoryDoc, key: string, snapshot: Item | null) => {
    doc.staleNextGets('u#local', key, snapshot, 20);
    doc.staleNextQueries('u#local', key, snapshot, 20);
  };
  const DAY = '2026-08-04';

  it('a second reorder straight after the first leaves one live plan row', async () => {
    const { backend, doc } = setup();
    const t = await backend.createTask({ title: 'pset' });
    const plan = await backend.upsertPlan({ taskId: t.id, day: DAY, plannedMinutes: 30, order: 0 });
    const at = (order: number) => ({ ...plan, order });
    const first = await doc.get('u#local', sk.plan(DAY, 0, plan.id));
    await backend.upsertPlan(at(1));
    lagKey(doc, sk.plan(DAY, 0, plan.id), first); // the moved-from row still shows…
    lagKey(doc, sk.plan(DAY, 1, plan.id), null); // …and the moved-to row doesn't yet
    await backend.upsertPlan(at(2));
    const rows = (await doc.query('u#local', sk.planPrefix(DAY), { consistent: true })).filter(
      (r) => r.id === plan.id,
    );
    expect(rows.map((r) => r.SK)).toEqual([sk.plan(DAY, 2, plan.id)]);
  });

  it('a plan removed straight after a reorder is gone, not left at its new spot', async () => {
    const { backend, doc } = setup();
    const t = await backend.createTask({ title: 'pset' });
    const plan = await backend.upsertPlan({ taskId: t.id, day: DAY, plannedMinutes: 30, order: 0 });
    const first = await doc.get('u#local', sk.plan(DAY, 0, plan.id));
    await backend.upsertPlan({ ...plan, order: 1 });
    lagKey(doc, sk.plan(DAY, 0, plan.id), first);
    lagKey(doc, sk.plan(DAY, 1, plan.id), null);
    await backend.removePlan(plan.id);
    const live = (await doc.query('u#local', sk.planPrefix(DAY), { consistent: true })).filter(
      (r) => r.id === plan.id && r.deletedAt === null,
    );
    expect(live).toEqual([]);
  });

  it('an intent typed straight after a capacity keeps both', async () => {
    const { backend, doc } = setup();
    await backend.getDay(DAY);
    const before = await doc.get('u#local', sk.day(DAY));
    await backend.setDayCapacity(DAY, 5);
    lagKey(doc, sk.day(DAY), before);
    const saved = await backend.setDayIntent(DAY, 'ship it');
    expect(saved).toMatchObject({ capacityHours: 5, intent: 'ship it' });
  });

  it('a reflection straight after an intent keeps the intent', async () => {
    const { backend, doc } = setup();
    await backend.getDay(DAY);
    const before = await doc.get('u#local', sk.day(DAY));
    await backend.setDayIntent(DAY, 'ship it');
    lagKey(doc, sk.day(DAY), before);
    const saved = await backend.setDayReflection(DAY, 'How did it go?', 'fine');
    expect(saved).toMatchObject({ intent: 'ship it', reflectionText: 'fine' });
  });

  it('a work flip straight after a category rename keeps the name', async () => {
    const { backend, doc } = setup();
    const cat = await backend.upsertCategory({ label: 'Old', isWork: false });
    const before = await doc.get('u#local', sk.cat(cat.id));
    await backend.upsertCategory({ ...cat, label: 'New', order: 3 });
    lagKey(doc, sk.cat(cat.id), before);
    const { category } = await backend.setCategoryWork(cat.id, true, false);
    expect(category).toMatchObject({ label: 'New', isWork: true, order: 3 });
    // An edit that leaves order/active to the read keeps what the flip's write left.
    lagKey(doc, sk.cat(cat.id), before);
    const edited = await backend.upsertCategory({ id: cat.id, label: 'Newer', isWork: true });
    expect(edited).toMatchObject({ label: 'Newer', isWork: true, order: 3 });
  });

  it('deleting a category straight after a rename tombstones the renamed row', async () => {
    const { backend, doc } = setup();
    const cat = await backend.upsertCategory({ label: 'Old', isWork: false });
    const before = await doc.get('u#local', sk.cat(cat.id));
    await backend.upsertCategory({ ...cat, label: 'New' });
    lagKey(doc, sk.cat(cat.id), before);
    await backend.deleteCategory(cat.id, null);
    const row = await doc.get('u#local', sk.cat(cat.id), { consistent: true });
    expect(row).toMatchObject({ label: 'New' });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('a settings patch straight after another keeps both', async () => {
    const { backend, doc } = setup();
    await backend.getSettings();
    const before = await doc.get('u#local', sk.settings());
    await backend.updateSettings({ dayStartHour: 5 });
    lagKey(doc, sk.settings(), before);
    const saved = await backend.updateSettings({ pomodoroWorkMin: 50 });
    expect(saved).toMatchObject({ dayStartHour: 5, pomodoroWorkMin: 50 });
  });

  it('a story patch straight after a rename keeps the title; a delete tombstones the renamed row', async () => {
    const { backend, doc } = setup();
    const story = await backend.createStory({ title: 'old' });
    const before = await doc.get('u#local', sk.story(story.id));
    await backend.updateStory(story.id, { title: 'new' });
    lagKey(doc, sk.story(story.id), before);
    expect(await backend.updateStory(story.id, { situation: 'S' })).toMatchObject({
      title: 'new',
      situation: 'S',
    });
    lagKey(doc, sk.story(story.id), before);
    await backend.deleteStory(story.id);
    const row = await doc.get('u#local', sk.story(story.id), { consistent: true });
    expect(row).toMatchObject({ title: 'new', situation: 'S' });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('a series deactivated straight after a rename keeps the name', async () => {
    const { backend, doc } = setup();
    const series = await backend.upsertSeries({
      title: 'old',
      categoryId: null,
      defaultEstimateMin: 30,
      rule: { kind: 'daily' },
      anchorDate: '2026-08-01',
    });
    const before = await doc.get('u#local', sk.series(series.id));
    await backend.upsertSeries({ ...series, title: 'new' });
    lagKey(doc, sk.series(series.id), before);
    expect(await backend.deactivateSeries(series.id)).toMatchObject({
      title: 'new',
      active: false,
    });
  });

  it('a habit unchecked straight after a check leaves no check, and the reverse re-checks it', async () => {
    const { backend, doc } = setup();
    const h = await backend.upsertHabit({ name: 'run', categoryId: null, cadencePerWeek: 3 });
    const key = sk.hcheck(DAY, h.id);
    await backend.checkHabit(h.id, DAY);
    lagKey(doc, key, null); // the check isn't visible to a plain read yet
    await backend.uncheckHabit(h.id, DAY);
    expect(await doc.get('u#local', key, { consistent: true })).toBeNull();
    const checked = await backend.checkHabit(h.id, DAY);
    const live = await doc.get('u#local', key);
    await backend.uncheckHabit(h.id, DAY);
    lagKey(doc, key, live); // the uncheck isn't visible yet: a plain read still shows the check
    const again = await backend.checkHabit(h.id, DAY);
    expect(again.id).not.toBe(checked.id); // a fresh check, not the stale one handed back
    expect(await doc.get('u#local', key, { consistent: true })).toMatchObject({ id: again.id });
  });
});

// The parent's lock, the timed-plan refusal and the sweep are decided on the task list read straight
// after a task write. DynamoDB's default query is eventually consistent, so it can still show the task
// as it was — the decision must not.
describe('backend decisions under a lagging task list', () => {
  const setup = () => {
    const doc = new InMemoryDoc();
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
      userId: 'local',
      now: () => 1_700_000_000_000,
    });
    // Every non-consistent list read for the next while shows `id` as it is now.
    const lagging = async (id: string) =>
      doc.staleNextQueries('u#local', sk.task(id), await doc.get('u#local', sk.task(id)), 20);
    return { backend, lagging, doc };
  };

  it('a first start freezes the lock though the list still shows the part unstarted', async () => {
    const { backend, lagging } = setup();
    const p = await backend.createTask({ title: 'P2' });
    const a = await backend.createTask({ title: 'a', estimateMin: 30, parentId: p.id });
    await lagging(a.id);
    await backend.transitionTask(a.id, 'in_progress');
    expect((await backend.getTask(p.id))?.estimateLockedMin).toBe(30);
  });

  it('option 3: “+ Today” straight after clearing a time is allowed though the list still shows it timed', async () => {
    const { backend, lagging } = setup();
    const t = await backend.createTask({ title: 'OA', dueDay: '2026-08-05', dueTime: '17:00' });
    await lagging(t.id);
    await backend.setTaskDue(t.id, { dueDay: '2026-08-05', dueTime: null });
    const plan = { taskId: t.id, day: '2026-08-04', plannedMinutes: 30, order: 0 };
    await expect(backend.upsertPlan(plan)).resolves.toMatchObject({ taskId: t.id });
  });

  it('option 3: “+ Today” straight after adding a time is refused though the list still shows it untimed', async () => {
    const { backend, lagging } = setup();
    const t = await backend.createTask({ title: 'OA' });
    await lagging(t.id);
    await backend.setTaskDue(t.id, { dueDay: '2026-08-05', dueTime: '17:00' });
    const plan = { taskId: t.id, day: '2026-08-04', plannedMinutes: 30, order: 0 };
    await expect(backend.upsertPlan(plan)).rejects.toThrow(/falls on/);
  });

  it('option 3: the sweep re-judges the fresh copy — a time cleared since the list read keeps it planned', async () => {
    const { backend, lagging, doc } = setup();
    const t = await backend.createTask({ title: 'pset' });
    await backend.upsertPlan({ taskId: t.id, day: '2026-08-04', plannedMinutes: 30, order: 0 });
    await backend.transitionTask(t.id, 'planned');
    await backend.setTaskDue(t.id, { dueDay: '2026-08-04', dueTime: '17:00' });
    await lagging(t.id); // the list shows it planned and timed
    await backend.setTaskDue(t.id, { dueDay: '2026-08-04', dueTime: null });
    await backend.getDay('2026-08-04');
    expect((await backend.getTask(t.id))?.status).toBe('planned');
    expect(doc.gets.some((g) => g.key.endsWith(sk.task(t.id)) && g.consistent)).toBe(true);
  });

  it('option 3: the sweep reads plan rows consistently — a row just written keeps its task planned', async () => {
    const { backend, doc } = setup();
    const t = await backend.createTask({ title: 'pset' });
    const plan = await backend.upsertPlan({
      taskId: t.id,
      day: '2026-08-04',
      plannedMinutes: 30,
      order: 0,
    });
    await backend.transitionTask(t.id, 'planned');
    doc.staleNextQueries('u#local', sk.plan('2026-08-04', 0, plan.id), null, 20); // row not visible yet
    await backend.getDay('2026-08-04');
    expect((await backend.getTask(t.id))?.status).toBe('planned');
  });

  it('option 3: a roll pick straight after clearing its rep’s time reuses the rep', async () => {
    const { backend, lagging } = setup();
    const roll = await backend.upsertRoll({ name: 'OA', categoryId: null, estimateMin: 30 });
    const { task: rep } = await backend.pickRollToday(roll.id, '2026-08-04');
    await backend.setTaskDue(rep.id, { dueDay: '2026-08-06', dueTime: '17:00' });
    await lagging(rep.id); // the list shows it timed
    await backend.setTaskDue(rep.id, { dueDay: '2026-08-06', dueTime: null });
    expect((await backend.pickRollToday(roll.id, '2026-08-05')).task.id).toBe(rep.id);
  });

  it('a part’s first start returns it started though a plain read still shows it unstarted', async () => {
    const { backend, doc } = setup();
    const p = await backend.createTask({ title: 'P2' });
    const a = await backend.createTask({ title: 'a', estimateMin: 30, parentId: p.id });
    doc.staleNextGets('u#local', sk.task(a.id), await doc.get('u#local', sk.task(a.id)), 20);
    expect((await backend.transitionTask(a.id, 'in_progress')).status).toBe('in_progress');
  });

  it('detaching the last part releases the lock though the list still shows it attached', async () => {
    const { backend, lagging } = setup();
    const p = await backend.createTask({ title: 'P2' });
    const a = await backend.createTask({ title: 'a', estimateMin: 30, parentId: p.id });
    await backend.transitionTask(a.id, 'in_progress');
    await lagging(a.id);
    await backend.setTaskParent(a.id, null);
    expect((await backend.getTask(p.id))?.estimateLockedMin).toBeNull();
  });
});

// An older app shell (or any caller without a reflection) sends setTaskActual as a two-element params array
// (the http client drops a trailing undefined), so over the wire a missing reflection keeps the saved one.
describe('setTaskActual over RPC', () => {
  it('a two-element call keeps the reflection; an explicit null clears it; over the cap lands nothing', async () => {
    const doc = new InMemoryDoc();
    const now = () => 1_700_000_000_000;
    const rpc = (
      method: 'createTask' | 'transitionTask' | 'setTaskActual' | 'getTask',
      args: unknown[],
    ) => handleRpc(doc, { userId: 'local', method, args, now }, { presigner: fakePresigner() });
    const t = (await rpc('createTask', [{ title: 'pset', estimateMin: 30 }])) as Task;
    await rpc('transitionTask', [t.id, 'in_progress']);
    await rpc('setTaskActual', [t.id, 40, 'went long']);
    const kept = (await rpc('setTaskActual', [t.id, 45])) as Task;
    expect(kept).toMatchObject({ actualAccruedMin: 45, reflection: 'went long' });
    const cleared = (await rpc('setTaskActual', [t.id, 45, null])) as Task;
    expect(cleared.reflection).toBeNull();
    await expect(rpc('setTaskActual', [t.id, 99, 'x'.repeat(1001)])).rejects.toThrow(/1,000/);
    const after = (await rpc('getTask', [t.id])) as Task;
    expect(after).toMatchObject({ actualAccruedMin: 45, reflection: null }); // the 99 never landed
  });
});
