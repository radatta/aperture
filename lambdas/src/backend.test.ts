import { describe, expect, it } from 'vitest';
import { InMemoryDoc } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites, noopWrites } from './ddb/writes';
import { sk } from './ddb/keys';
import { BackendClient } from './backend';
import { handleRpc } from './handler';
import { fakePresigner } from './s3/presigner';
import type { Presigner } from './s3/presigner';

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
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), userId), {
      userId,
      now: () => clock,
      presigner: fakePresigner(),
    });
    return { doc, backend, tick: (ms: number) => (clock += ms) };
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
    const { doc, backend, tick } = setup();
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
    expect(raw).toBeTruthy(); // still physically present (bytes orphaned, metadata recoverable)
    expect(raw!.deletedAt).not.toBeNull();
    expect(await backend.listAttachments(task.id)).toHaveLength(0);
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
    const backend = new BackendClient(new Repo(doc, liveWrites(doc), userId), {
      userId,
      now: () => clock,
      presigner: fakePresigner(),
    });
    return { doc, backend, tick: (ms: number) => (clock += ms) };
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
    const live = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), { userId: 'local', now });
    const task = await live.createTask({ title: 'survives' });

    const noop = new BackendClient(new Repo(doc, noopWrites(), 'local'), { userId: 'local', now });
    await noop.deleteTask(task.id);

    expect(await live.getTask(task.id)).not.toBeNull(); // nothing tombstoned
  });
});
