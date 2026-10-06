import { describe, expect, it } from 'vitest';
import type { ApiMethod, Attachment, Category, Task } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { InMemoryGoogle } from '../google/gateway';
import { fakePresigner } from '../s3/presigner';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import type { ToolContext } from './types';

// A full environment: real backend over an in-memory table, the stateful Google fake, a fake presigner,
// and a recording `upload`. `setup` is a direct BackendClient over the SAME doc + google, so we can
// establish state (e.g. connect a calendar account) that no RPC method exposes.
function makeEnv() {
  const doc = new InMemoryDoc();
  const google = new InMemoryGoogle();
  const uploads: { url: string; bytes: Buffer; contentType: string }[] = [];
  const now = () => 1_700_000_000_000;
  const setup = new BackendClient(new Repo(doc, liveWrites(doc), 'local'), {
    userId: 'local',
    now,
    google,
    stateSecret: 'test',
  });
  const ctx: ToolContext = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(
        doc,
        { userId: 'local', method, args, now, google, stateSecret: 'test' },
        { presigner: fakePresigner() },
      ),
    upload: async (url, bytes, contentType) => {
      uploads.push({ url, bytes, contentType });
    },
  };
  // async so a tool's SYNCHRONOUS validation throw (a non-async run) surfaces as a rejection — matching
  // how protocol.ts's callTool catches it inside its try (both sync throw and async reject land the same).
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(args, ctx);
  };
  return { doc, google, uploads, setup, call };
}

describe('mcp tools — tasks', () => {
  it('create → list, and status filter', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'from mcp', estimateMin: 30 })) as Task;
    expect(t.title).toBe('from mcp');
    expect(t.status).toBe('backlog');
    expect(((await call('list_tasks')) as Task[]).map((x) => x.title)).toEqual(['from mcp']);
    expect((await call('list_backlog')) as Task[]).toHaveLength(1);
    expect((await call('list_tasks', { status: 'done' })) as Task[]).toHaveLength(0);
  });

  it('create_tasks lands every input in order', async () => {
    const { call } = makeEnv();
    const created = (await call('create_tasks', {
      tasks: [{ title: 'a' }, { title: 'b', estimateMin: 15 }, { title: 'c' }],
    })) as Task[];
    expect(created.map((t) => t.title)).toEqual(['a', 'b', 'c']);
    expect(created.every((t) => t.status === 'backlog' && t.estimateLockedMin === null)).toBe(true);
  });

  it('update_task renames at any status and reports applied fields on a later failure', async () => {
    const { call } = makeEnv();
    const cat = (await call('create_category', { label: 'Deep', isWork: true })) as Category;
    const t = (await call('create_task', { title: 'draft', estimateMin: 30 })) as Task;

    const renamed = (await call('update_task', { id: t.id, title: 'Real' })) as Task;
    expect(renamed.title).toBe('Real');

    // A fan-out that changes category (applies) then an illegal status (backlog → done throws).
    await expect(
      call('update_task', { id: t.id, categoryId: cat.id, status: 'done' }),
    ).rejects.toThrow(/already applied: categoryId/);
    // The category change DID land despite the status failure.
    expect(((await call('list_tasks')) as Task[])[0]!.categoryId).toBe(cat.id);
  });

  it('update_task rescopes a started task; the frozen baseline stays', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'pset', estimateMin: 30 })) as Task;
    await call('update_task', { id: t.id, status: 'in_progress' });
    const out = (await call('update_task', { id: t.id, estimateMin: 90 })) as Task;
    expect(out).toMatchObject({ estimateMin: 90, estimateLockedMin: 30 });
  });

  it('split_task: done needs actualMin and a started task; the rest lands linked', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'pset', estimateMin: 60 })) as Task;
    await expect(
      call('split_task', { id: t.id, finish: 'done', actualMin: 40, followUpTitle: 'rest' }),
    ).rejects.toThrow(/started/);
    await call('update_task', { id: t.id, status: 'in_progress' });
    await expect(
      call('split_task', { id: t.id, finish: 'done', followUpTitle: 'rest' }),
    ).rejects.toThrow(/actualMin/);
    await expect(
      call('split_task', { id: t.id, finish: 'keep', actualMin: 5, followUpTitle: 'rest' }),
    ).rejects.toThrow(/actualMin/);
    const { original, followUp } = (await call('split_task', {
      id: t.id,
      finish: 'done',
      actualMin: 40,
      followUpTitle: 'pset, second half',
      followUpEstimateMin: 60,
    })) as { original: Task; followUp: Task };
    expect(original).toMatchObject({ status: 'done', actualAccruedMin: 40 });
    expect(followUp).toMatchObject({
      title: 'pset, second half',
      estimateMin: 60,
      splitFromId: t.id,
      status: 'backlog',
    });
  });

  it('notes: create sets them, lists return them, update replaces and clears at any status', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'noted', notes: '  ch. 4\n- q6  ' })) as Task;
    expect(t.notes).toBe('ch. 4\n- q6');
    expect(((await call('list_tasks')) as Task[])[0]!.notes).toBe('ch. 4\n- q6');
    expect(((await call('list_backlog')) as Task[])[0]!.notes).toBe('ch. 4\n- q6');

    await call('complete_task', { id: t.id, actualMin: 20 });
    const replaced = (await call('update_task', { id: t.id, notes: 'after the fact' })) as Task;
    expect(replaced.notes).toBe('after the fact'); // editable on a done task
    expect(((await call('update_task', { id: t.id, notes: null })) as Task).notes).toBeNull();

    const bulk = (await call('create_tasks', {
      tasks: [{ title: 'a', notes: 'first' }, { title: 'b' }],
    })) as Task[];
    expect(bulk.map((x) => x.notes)).toEqual(['first', null]);
  });

  it('notes over the cap are a param error that applies nothing', async () => {
    const { call } = makeEnv();
    const long = 'x'.repeat(5001);
    const t = (await call('create_task', { title: 'orig', notes: 'keep' })) as Task;

    await expect(call('update_task', { id: t.id, title: 'renamed', notes: long })).rejects.toThrow(
      /"notes": Notes are limited to 5,000 characters/,
    );
    const after = ((await call('list_tasks')) as Task[])[0]!;
    expect(after.title).toBe('orig'); // the title before it in the patch did NOT land
    expect(after.notes).toBe('keep');

    await expect(call('create_task', { title: 'too long', notes: long })).rejects.toThrow(/5,000/);
    await expect(
      call('create_tasks', { tasks: [{ title: 'fine' }, { title: 'too long', notes: long }] }),
    ).rejects.toThrow(/5,000/);
    await expect(
      call('create_tasks', { tasks: [{ title: 'fine' }, { title: 'bad type', notes: 42 }] }),
    ).rejects.toThrow(/string or null/);
    expect((await call('list_tasks')) as Task[]).toHaveLength(1); // none of either batch landed
    await expect(call('update_task', { id: t.id, notes: 42 })).rejects.toThrow(/string or null/);
  });

  it('update_task with no fields is a param error', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'x' })) as Task;
    await expect(call('update_task', { id: t.id })).rejects.toThrow(/at least one field/);
  });

  it('complete_task chains to done, locks the estimate, records actual, echoes the previous', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'ship', estimateMin: 60 })) as Task;
    const res = (await call('complete_task', { id: t.id, actualMin: 90 })) as {
      task: Task;
      previousActualMin: number;
    };
    expect(res.task.status).toBe('done');
    expect(res.task.estimateLockedMin).toBe(60);
    expect(res.task.actualAccruedMin).toBe(90);
    expect(res.previousActualMin).toBe(0);
    await expect(call('complete_task', { id: t.id, actualMin: 5 })).rejects.toThrow(/already done/);
  });

  it('complete_task requires actualMin', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'x' })) as Task;
    await expect(call('complete_task', { id: t.id })).rejects.toThrow(/actualMin/);
  });

  it('delete_task tombstones the task and its plans, and 404s an unknown or already-deleted id', async () => {
    const { call, setup } = makeEnv();
    const t = (await call('create_task', { title: 'gone' })) as Task;
    await setup.upsertPlan({ taskId: t.id, day: '2026-09-22', plannedMinutes: 30, order: 0 });
    expect(await call('delete_task', { id: t.id })).toEqual({ deleted: t.id });
    expect((await call('list_tasks')) as Task[]).toHaveLength(0);
    expect(await setup.listPlansForDay('2026-09-22')).toHaveLength(0);
    await expect(call('delete_task', { id: t.id })).rejects.toThrow(/Not found/);
    await expect(call('delete_task', { id: 'nope' })).rejects.toThrow(/Not found/);
  });

  it('delete_task refuses a recurring occurrence (the series would respawn it)', async () => {
    const { call, doc } = makeEnv();
    const t = (await call('create_task', { title: 'daily lc' })) as Task;
    await new Repo(doc, liveWrites(doc), 'local').putTask({ ...t, seriesId: 'series-1' });
    await expect(call('delete_task', { id: t.id })).rejects.toThrow(/Recurring occurrence/);
    expect((await call('list_tasks')) as Task[]).toHaveLength(1);
  });
});

describe('mcp tools — categories, calibration, leetcode', () => {
  it('create_category then list_categories', async () => {
    const { call } = makeEnv();
    const cat = (await call('create_category', { label: 'LeetCode', isWork: true })) as Category;
    expect(cat.label).toBe('LeetCode');
    expect(((await call('list_categories')) as Category[]).map((c) => c.label)).toContain(
      'LeetCode',
    );
  });

  it('update_category patches only what is sent — a rename keeps order and never reactivates', async () => {
    const { call, setup } = makeEnv();
    const hw = { label: 'Homework', isWork: true, order: 4 };
    const cat = (await call('create_category', hw)) as Category;
    await setup.upsertCategory({ ...hw, id: cat.id, active: false }); // retired outside the MCP
    const renamed = (await call('update_category', { id: cat.id, label: 'CS 61B' })) as Category;
    expect(renamed).toMatchObject({ label: 'CS 61B', isWork: true, order: 4, active: false });
    const reordered = (await call('update_category', { id: cat.id, order: 1 })) as Category;
    expect(reordered).toMatchObject({ label: 'CS 61B', order: 1, active: false });
  });

  it('update_category retires and restores via active', async () => {
    const { call } = makeEnv();
    const cat = (await call('create_category', { label: 'Studying', isWork: true })) as Category;
    const retired = (await call('update_category', { id: cat.id, active: false })) as Category;
    expect(retired).toMatchObject({ label: 'Studying', isWork: true, active: false });
    const restored = (await call('update_category', { id: cat.id, active: true })) as Category;
    expect(restored.active).toBe(true);
  });

  it('update_category rejects an empty patch and an unknown id', async () => {
    const { call } = makeEnv();
    const cat = (await call('create_category', { label: 'X', isWork: false })) as Category;
    await expect(call('update_category', { id: cat.id })).rejects.toThrow(/at least one field/);
    const unknown = call('update_category', { id: 'nope', label: 'Y' });
    await expect(unknown).rejects.toThrow(/Not found/);
  });

  it('get_calibration validates the date range', async () => {
    const { call } = makeEnv();
    expect(await call('get_calibration', { from: '2026-09-01', to: '2026-09-30' })).toEqual([]);
    await expect(call('get_calibration', { from: 'friday', to: '2026-09-30' })).rejects.toThrow(
      /ISO date/,
    );
  });

  it('list_leetcode_attempts wants both dates or neither', async () => {
    const { call } = makeEnv();
    expect(await call('list_leetcode_attempts')).toEqual([]);
    await expect(call('list_leetcode_attempts', { from: '2026-09-01' })).rejects.toThrow(/both/);
  });
});

describe('mcp tools — calendar', () => {
  it('lists connected accounts, creates a task-linked event on the write default, and deletes it', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A'); // registers account A (primary cal A@example.com)

    const listed = (await call('list_calendars')) as {
      accounts: { sub: string; isWriteDefault: boolean; calendars: { calendarId: string }[] }[];
    };
    expect(listed.accounts.map((a) => a.sub)).toContain('A');

    const t = (await call('create_task', { title: 'meet' })) as Task;
    const withEvent = (await call('create_calendar_event', {
      taskId: t.id,
      start: '2026-09-22T14:00:00-07:00',
      durationMin: 60,
      accountSub: 'A',
      calendarId: 'A@example.com',
    })) as Task;
    expect(withEvent.gcalEventId).toBeTruthy();
    expect(google.events.size).toBe(1);

    const cleared = (await call('delete_calendar_event', { taskId: t.id })) as Task;
    expect(cleared.gcalEventId).toBeNull();
    expect(google.events.size).toBe(0);
  });

  it('create_calendar_event errors clearly with no target and no default', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'no cal' })) as Task;
    await expect(
      call('create_calendar_event', {
        taskId: t.id,
        start: '2026-09-22T14:00:00-07:00',
        durationMin: 30,
      }),
    ).rejects.toThrow(/No calendar target/);
  });

  it('rejects a partial target (accountSub without calendarId) rather than mixing accounts', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'partial' })) as Task;
    await expect(
      call('create_calendar_event', {
        taskId: t.id,
        start: '2026-09-22T14:00:00-07:00',
        durationMin: 30,
        accountSub: 'A',
      }),
    ).rejects.toThrow(/together/);
  });

  it('rejects a naive timestamp (no offset)', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'x' })) as Task;
    await expect(
      call('create_calendar_event', {
        taskId: t.id,
        start: '2026-09-22T14:00:00',
        durationMin: 30,
      }),
    ).rejects.toThrow(/explicit offset/);
  });
});

describe('mcp tools — attachments', () => {
  it('attach_file signs, uploads via the injected uploader, and confirms (pending → ready)', async () => {
    const { call, uploads } = makeEnv();
    const t = (await call('create_task', { title: 'has notes' })) as Task;
    const content = Buffer.from('# notes\nremember this').toString('base64');
    const att = (await call('attach_file', {
      taskId: t.id,
      filename: 'notes.md',
      contentType: 'text/markdown',
      contentBase64: content,
    })) as Attachment;
    expect(att.status).toBe('ready');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.contentType).toBe('text/markdown');
    expect((await call('list_attachments', { taskId: t.id })) as Attachment[]).toHaveLength(1);
  });

  it('attach_file rejects an over-cap payload BEFORE writing any pending row', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'big' })) as Task;
    const tooBig = Buffer.alloc(64 * 1024 + 1, 0x61).toString('base64');
    await expect(
      call('attach_file', {
        taskId: t.id,
        filename: 'big.txt',
        contentType: 'text/plain',
        contentBase64: tooBig,
      }),
    ).rejects.toThrow(/capped/);
    expect((await call('list_attachments', { taskId: t.id })) as Attachment[]).toHaveLength(0);
  });

  it('create_attachment_upload returns a presigned URL + next-step, and confirm/delete round-trip', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'real file' })) as Task;
    const up = (await call('create_attachment_upload', {
      taskId: t.id,
      filename: 'shot.png',
      contentType: 'image/png',
      size: 4096,
    })) as { attachmentId: string; uploadUrl: string; next: string };
    expect(up.uploadUrl).toMatch(/^fake:\/\/put\//);
    expect(up.next).toMatch(/confirm_attachment/);
    const confirmed = (await call('confirm_attachment', { id: up.attachmentId })) as Attachment;
    expect(confirmed.status).toBe('ready');
    expect(await call('get_attachment_download_url', { id: up.attachmentId })).toMatch(
      /^fake:\/\/get\//,
    );
    expect(await call('delete_attachment', { id: up.attachmentId })).toEqual({
      deleted: up.attachmentId,
    });
  });
});

describe('mcp tools — due times', () => {
  it('create_task / create_tasks take dueTime; a timed task lands on the connected calendar', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const t = (await call('create_task', {
      title: 'pset',
      dueDay: '2026-10-09',
      dueTime: '16:00',
    })) as Task;
    expect(t).toMatchObject({ dueDay: '2026-10-09', dueTime: '16:00', gcalSyncError: null });
    expect(t.gcalEventId).not.toBeNull();
    const bulk = (await call('create_tasks', {
      tasks: [{ title: 'a', dueDay: '2026-10-09', dueTime: '09:00' }, { title: 'b' }],
    })) as Task[];
    expect(bulk.map((x) => x.dueTime)).toEqual(['09:00', null]);
    expect(google.events.size).toBe(2);
  });

  it('a malformed dueTime is a param error that writes nothing', async () => {
    const { call } = makeEnv();
    await expect(
      call('create_task', { title: 'x', dueDay: '2026-10-09', dueTime: '4pm' }),
    ).rejects.toThrow(/HH:MM/);
    const t = (await call('create_task', { title: 'y', dueDay: '2026-10-09' })) as Task;
    await expect(
      call('update_task', { id: t.id, title: 'renamed', dueTime: '25:00' }),
    ).rejects.toThrow(/HH:MM/);
    const after = ((await call('list_tasks')) as Task[]).map((x) => x.title);
    expect(after).toEqual(['y']); // neither the create nor the rename landed
  });

  it('update_task: time-only keeps the day, day-only keeps the time, null clears', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'x', dueDay: '2026-10-09' })) as Task;
    expect(await call('update_task', { id: t.id, dueTime: '17:30' })).toMatchObject({
      dueDay: '2026-10-09',
      dueTime: '17:30',
    });
    expect(await call('update_task', { id: t.id, dueDay: '2026-10-10' })).toMatchObject({
      dueDay: '2026-10-10',
      dueTime: '17:30',
    });
    expect(await call('update_task', { id: t.id, dueTime: null })).toMatchObject({
      dueDay: '2026-10-10',
      dueTime: null,
    });
    await call('update_task', { id: t.id, dueDay: '2026-10-10', dueTime: '08:00' });
    expect(await call('update_task', { id: t.id, dueDay: null })).toMatchObject({
      dueDay: null,
      dueTime: null,
    });
  });

  it('update_task: a time on an undated task errors and names what already applied', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'x' })) as Task;
    await expect(
      call('update_task', { id: t.id, title: 'renamed', dueTime: '16:00' }),
    ).rejects.toThrow(/requires dueDay.*already applied: title/);
  });
});
