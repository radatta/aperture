import { describe, expect, it } from 'vitest';
import { gcalSyncMessage, PARENT_NO_EVENT_ERROR } from '@aperture/shared';
import type { ApiMethod, Attachment, Category, Task } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { InMemoryGoogle } from '../google/gateway';
import { FakeAnthropic } from '../anthropic/gateway';
import { fakePresigner } from '../s3/presigner';
import { fakeObjectStore } from '../s3/objects';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import type { ToolContext } from './types';

// A full environment: real backend over an in-memory table, the stateful Google fake, a fake presigner,
// and a recording `upload`. `setup` is a direct BackendClient over the SAME doc + google, so we can
// establish state (e.g. connect a calendar account) that no RPC method exposes.
function makeEnv() {
  const doc = new InMemoryDoc();
  const google = new InMemoryGoogle();
  const anthropic = new FakeAnthropic();
  const uploads: { url: string; bytes: Buffer; contentType: string }[] = [];
  const now = () => 1_700_000_000_000;
  const objects = fakeObjectStore();
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
        { presigner: fakePresigner(), objects, anthropic },
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
  return { doc, google, anthropic, uploads, objects, setup, call };
}

describe('mcp tools — parse_task (Raycast quick add)', () => {
  it("parses through the backend's flow against the active categories, writing nothing", async () => {
    const { call, setup, anthropic } = makeEnv();
    const cat = await setup.upsertCategory({ label: 'Aperture', isWork: true });
    anthropic.next = {
      ok: true,
      fields: {
        title: 'fix login',
        notes: null,
        categoryId: cat.id,
        dueDay: null,
        dueTime: '16:00',
        estimateMin: 30,
      },
    };
    const r = await call('parse_task', { text: 'aperture, fix login 4pm 30m' });
    expect(r).toMatchObject({
      ok: true,
      source: 'haiku',
      input: { title: 'fix login', categoryId: cat.id, dueTime: '16:00', estimateMin: 30 },
      categoryLabel: 'Aperture',
      dropped: [],
    });
    expect(anthropic.calls[0]).toMatchObject({
      text: 'aperture, fix login 4pm 30m',
      categories: [{ id: cat.id, label: 'Aperture' }],
    });
    expect((await call('list_tasks')) as Task[]).toHaveLength(0);
  });

  // Raycast passes `input` straight to create_task — a grammar line's unset fields must not arrive as
  // nulls, which create_task reads as given and rejects (-32602).
  it("a ' | ' line's input goes straight into create_task", async () => {
    const { call, setup, anthropic } = makeEnv();
    const cat = await setup.upsertCategory({ label: 'Admin', isWork: true });
    const r = (await call('parse_task', { text: 'memo | #admin' })) as {
      input: Record<string, unknown>;
    };
    expect(r.input).toEqual({ title: 'memo', categoryId: cat.id });
    const t = (await call('create_task', r.input)) as Task;
    expect(t).toMatchObject({ title: 'memo', categoryId: cat.id, estimateMin: null });
    expect(anthropic.calls).toHaveLength(0);
  });

  it('a model failure comes back as ok:false for a raw save', async () => {
    const { call, anthropic } = makeEnv();
    anthropic.next = { ok: false, reason: 'timeout' };
    expect(await call('parse_task', { text: 'call bank' })).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('text is required and must be a string', async () => {
    const { call, anthropic } = makeEnv();
    await expect(call('parse_task', {})).rejects.toThrow(/"text" is required/);
    await expect(call('parse_task', { text: 7 })).rejects.toThrow(/must be a string/);
    expect(anthropic.calls).toHaveLength(0);
  });
});

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
    await call('update_task', { id: t.id, bufferMin: 10 }); // buffer alone keeps the estimate
    const out = (await call('update_task', { id: t.id, estimateMin: 90 })) as Task;
    expect(out).toMatchObject({ estimateMin: 90, bufferMin: 10, estimateLockedMin: 30 }); // keeps the buffer
  });

  it('split_task: done needs actualMin and a started task; the rest is a part of a new parent', async () => {
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
    const { parent, original, followUp } = (await call('split_task', {
      id: t.id,
      finish: 'done',
      actualMin: 40,
      followUpTitle: 'pset, second half',
      followUpEstimateMin: 60,
    })) as { parent: Task; original: Task; followUp: Task };
    expect(parent).toMatchObject({ title: 'pset', estimateLockedMin: 60 });
    expect(original).toMatchObject({
      status: 'done',
      actualAccruedMin: 40,
      title: 'Part 1',
      parentId: parent.id,
    });
    expect(followUp).toMatchObject({
      title: 'pset, second half',
      estimateMin: 60,
      parentId: parent.id,
      status: 'backlog',
    });
    await expect(
      call('split_task', { id: parent.id, finish: 'keep', followUpTitle: 'x' }),
    ).rejects.toThrow(/add a part/);
  });

  it('parts: create_tasks with parentId, list_tasks annotates the parent, complete_task on it', async () => {
    const { call } = makeEnv();
    const p = (await call('create_task', { title: 'P2', dueDay: '2026-10-13' })) as Task;
    const [a, b] = (await call('create_tasks', {
      tasks: [
        { title: 'Part 1', estimateMin: 45, parentId: p.id },
        { title: 'Part 2', estimateMin: 60, parentId: p.id },
      ],
    })) as Task[];
    const listed = (await call('list_tasks')) as (Task & { parts?: unknown })[];
    expect(listed.find((t) => t.id === p.id)?.parts).toEqual({
      total: 2,
      done: 0,
      estimateMin: 105,
    });
    expect(listed.find((t) => t.id === a!.id)?.parentId).toBe(p.id);
    await call('complete_task', { id: a!.id, actualMin: 50 });
    // The hard block names the open part; actualMin on a parent is a param error.
    await expect(call('complete_task', { id: p.id })).rejects.toThrow(
      'Part 2 isn’t finished — complete, drop or delete it first',
    );
    await expect(call('complete_task', { id: p.id, actualMin: 90 })).rejects.toThrow(
      /Omit actualMin/,
    );
    await expect(call('complete_task', { id: b!.id })).rejects.toThrow(/actualMin/); // a part needs one
    await call('complete_task', { id: b!.id, actualMin: 70 });
    const { task } = (await call('complete_task', { id: p.id })) as { task: Task };
    expect(task).toMatchObject({ status: 'done', actualAccruedMin: 120, estimateLockedMin: 105 });
  });

  it('parts: update_task attaches and detaches, refuses a second level; delete_task lists the parts', async () => {
    const { call } = makeEnv();
    const p = (await call('create_task', { title: 'P2' })) as Task;
    const x = (await call('create_task', { title: 'x' })) as Task;
    expect(((await call('update_task', { id: x.id, parentId: p.id })) as Task).parentId).toBe(p.id);
    await expect(call('update_task', { id: p.id, parentId: x.id })).rejects.toThrow(/one level/);
    await expect(
      call('create_calendar_event', {
        taskId: p.id,
        accountSub: 'A',
        calendarId: 'A@example.com',
        start: '2026-10-08T14:00:00-07:00',
        durationMin: 30,
      }),
    ).rejects.toThrow(PARENT_NO_EVENT_ERROR);
    expect(await call('delete_task', { id: p.id })).toEqual({ deleted: p.id, parts: [x.id] });
    expect(((await call('list_tasks')) as Task[]).some((t) => t.id === x.id)).toBe(false);
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

  it('complete_task saves a reflection with the actual, and on a parent after the rollup', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'pset', estimateMin: 30 })) as Task;
    const { task } = (await call('complete_task', {
      id: t.id,
      actualMin: 45,
      reflection: '  Should have outlined first  ',
    })) as { task: Task };
    expect(task).toMatchObject({
      status: 'done',
      actualAccruedMin: 45,
      reflection: 'Should have outlined first',
    });
    expect(((await call('list_tasks')) as Task[]).find((x) => x.id === t.id)?.reflection).toBe(
      'Should have outlined first',
    );
    const points = (await call('get_calibration', { from: '2000-01-01', to: '2100-01-01' })) as {
      taskId: string;
      reflection: string | null;
    }[];
    expect(points.find((x) => x.taskId === t.id)?.reflection).toBe('Should have outlined first');
    // Without one, nothing is cleared or invented.
    const plain = (await call('create_task', { title: 'plain', estimateMin: 10 })) as Task;
    const { task: noNote } = (await call('complete_task', { id: plain.id, actualMin: 10 })) as {
      task: Task;
    };
    expect(noNote.reflection).toBeNull();

    const p = (await call('create_task', { title: 'Essay' })) as Task;
    const [a] = (await call('create_tasks', {
      tasks: [{ title: 'Draft', estimateMin: 60, parentId: p.id }],
    })) as Task[];
    await call('complete_task', { id: a!.id, actualMin: 70 });
    const { task: parent } = (await call('complete_task', {
      id: p.id,
      reflection: 'The draft ran long',
    })) as { task: Task };
    expect(parent).toMatchObject({
      status: 'done',
      actualAccruedMin: 70,
      reflection: 'The draft ran long',
    });
  });

  it('complete_task with a reflection over the cap is a param error that applies nothing', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'orig', estimateMin: 20 })) as Task;
    await expect(
      call('complete_task', { id: t.id, actualMin: 30, reflection: 'x'.repeat(1001) }),
    ).rejects.toThrow(/"reflection": Reflection is limited to 1,000 characters/);
    await expect(
      call('complete_task', { id: t.id, actualMin: 30, reflection: 42 }),
    ).rejects.toThrow(/string or null/);
    const after = ((await call('list_tasks')) as Task[])[0]!;
    expect(after).toMatchObject({ status: 'backlog', actualAccruedMin: 0, reflection: null });
  });

  it('update_task sets and clears reflection, after notes in the fan-out', async () => {
    const { call } = makeEnv();
    const t = (await call('create_task', { title: 'lab', estimateMin: 20 })) as Task;
    await call('complete_task', { id: t.id, actualMin: 25 });
    const set = (await call('update_task', {
      id: t.id,
      notes: 'ctx',
      reflection: 'went fine',
    })) as Task;
    expect(set).toMatchObject({ notes: 'ctx', reflection: 'went fine', estimateLockedMin: 20 });
    expect(
      ((await call('update_task', { id: t.id, reflection: null })) as Task).reflection,
    ).toBeNull();
    // Over the cap: nothing in the patch lands, the notes before it included.
    await expect(
      call('update_task', { id: t.id, notes: 'new', reflection: 'x'.repeat(1001) }),
    ).rejects.toThrow(/1,000/);
    expect(((await call('list_tasks')) as Task[])[0]!.notes).toBe('ctx');
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

  it('delete_task tombstones the task and its plans, deletes its attachment bytes, and 404s an unknown or already-deleted id', async () => {
    const { call, setup, objects } = makeEnv();
    const t = (await call('create_task', { title: 'gone' })) as Task;
    await setup.upsertPlan({ taskId: t.id, day: '2026-09-22', plannedMinutes: 30, order: 0 });
    const up = (await call('create_attachment_upload', {
      taskId: t.id,
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 5,
    })) as { attachmentId: string };
    expect(await call('delete_task', { id: t.id })).toEqual({ deleted: t.id });
    expect(objects.deleted).toEqual([`u/local/${t.id}/${up.attachmentId}`]);
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

  it('create_calendar_event refuses a task with a due time while auto-sync is on', async () => {
    const { call, setup } = makeEnv();
    await setup.completeGoogleConnect('A');
    const t = (await call('create_task', {
      title: 'due',
      dueDay: '2026-09-22',
      dueTime: '17:00',
    })) as Task;
    await expect(
      call('create_calendar_event', {
        taskId: t.id,
        start: '2026-09-22T14:00:00-07:00',
        durationMin: 60,
      }),
    ).rejects.toThrow(/Auto-sync places/);
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
    const { call, objects } = makeEnv();
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
    expect(objects.deleted).toEqual([`u/local/${t.id}/${up.attachmentId}`]);
  });
});

describe('mcp tools — sync_calendar_event', () => {
  type Synced = { outcome: string; task: Task };
  const timed = { title: 'pset', dueDay: '2026-10-09', dueTime: '16:00', estimateMin: 60 };

  it('puts a removed block back at the deadline — re-setting the same time never did', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const t = (await call('create_task', timed)) as Task;
    await call('delete_calendar_event', { taskId: t.id });
    await call('update_task', { id: t.id, dueTime: '16:00' });
    expect(google.events.size).toBe(0); // the gap this tool closes
    const r = (await call('sync_calendar_event', { taskId: t.id })) as Synced;
    expect(r.outcome).toBe('created');
    const ev = google.events.get(r.task.gcalEventId!)!;
    expect(ev.endMs - ev.startMs).toBe(60 * 60_000);
    expect(r.task.gcalSyncError).toBeNull();
  });

  it('a linked task is updated; one deleted in Google comes back unlinked, then created', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const t = (await call('create_task', timed)) as Task;
    google.editEvent(t.gcalEventId!, { title: 'renamed in google' });
    const r = (await call('sync_calendar_event', { taskId: t.id })) as Synced;
    expect(r.outcome).toBe('updated');
    expect(google.events.get(t.gcalEventId!)!.title).toBe('pset');
    google.deleteEventInGoogle(t.gcalEventId!);
    expect(await call('sync_calendar_event', { taskId: t.id })).toMatchObject({
      outcome: 'unlinked',
      task: { gcalEventId: null },
    });
    expect(await call('sync_calendar_event', { taskId: t.id })).toMatchObject({
      outcome: 'created',
    });
  });

  it('finishes an owed removal — even with auto-sync off', async () => {
    const { call, setup, doc, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const t = (await call('create_task', timed)) as Task;
    const repo = new Repo(doc, liveWrites(doc), 'local');
    await repo.putTask({
      ...(await repo.getTask(t.id))!,
      dueTime: null,
      gcalSyncError: gcalSyncMessage('delete', 'timeout'),
    });
    await setup.updateSettings({ autoCalendar: false });
    expect(await call('sync_calendar_event', { taskId: t.id })).toMatchObject({
      outcome: 'removed',
      task: { gcalEventId: null, gcalSyncError: null },
    });
    expect(google.events.size).toBe(0);
  });

  it('refuses, with the reason, when nothing would happen', async () => {
    const { call, setup, google } = makeEnv();
    const noCal = (await call('create_task', timed)) as Task; // no account connected yet
    await expect(call('sync_calendar_event', { taskId: noCal.id })).rejects.toThrow(
      /No calendar to write to/,
    );
    await setup.completeGoogleConnect('A');
    const untimed = (await call('create_task', { title: 'loose' })) as Task;
    await expect(call('sync_calendar_event', { taskId: untimed.id })).rejects.toThrow(
      /No due time and no event/,
    );
    const done = (await call('create_task', timed)) as Task;
    await call('complete_task', { id: done.id, actualMin: 30 });
    await expect(call('sync_calendar_event', { taskId: done.id })).rejects.toThrow(
      /A done task never syncs/,
    );
    const linked = (await call('create_task', timed)) as Task;
    await setup.updateSettings({ autoCalendar: false });
    await expect(call('sync_calendar_event', { taskId: linked.id })).rejects.toThrow(
      /Auto-sync is off/,
    );
    await expect(call('sync_calendar_event', { taskId: 'nope' })).rejects.toThrow(/Not found/);
    await setup.updateSettings({ autoCalendar: true });
    const cancelled = (await call('create_task', timed)) as Task;
    await call('update_task', { id: cancelled.id, status: 'cancelled' });
    const events = google.events.size;
    await expect(call('sync_calendar_event', { taskId: cancelled.id })).rejects.toThrow(
      /A cancelled task never syncs/,
    );
    expect(google.events.size).toBe(events); // a refusal never reaches Google
  });

  it('on a timed parent it syncs the due marker; an untimed parent is refused with the reason', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const p = (await call('create_task', timed)) as Task;
    await call('create_task', { title: 'read', estimateMin: 30, parentId: p.id }); // its block → marker
    const marker = google.events.get(p.gcalEventId!)!;
    expect(marker).toMatchObject({ marker: true, endMs: marker.startMs + 15 * 60_000 });
    google.events.delete(p.gcalEventId!); // removed by hand in Google
    const res = (await call('sync_calendar_event', { taskId: p.id })) as {
      outcome: string;
      task: Task;
    };
    expect(res.outcome).toBe('unlinked');
    const again = (await call('sync_calendar_event', { taskId: p.id })) as {
      outcome: string;
      task: Task;
    };
    expect(again.outcome).toBe('created');
    expect(google.events.get(again.task.gcalEventId!)).toMatchObject({
      marker: true,
      title: 'pset',
    });

    const u = (await call('create_task', { title: 'U', dueDay: '2026-10-09' })) as Task;
    await call('create_task', { title: 'read', parentId: u.id });
    const before = google.events.size;
    await expect(call('sync_calendar_event', { taskId: u.id })).rejects.toThrow(/needs a due time/);
    expect(google.events.size).toBe(before);
  });

  it('a stray event on an untimed parent is removed', async () => {
    const { call, setup, doc, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const p = (await call('create_task', { title: 'P2', dueDay: '2026-10-09' })) as Task;
    await call('create_calendar_event', {
      taskId: p.id,
      start: '2026-10-08T14:00:00-07:00',
      durationMin: 30,
    });
    const part = (await call('create_task', { title: 'read' })) as Task;
    // Attached behind the impl's back, so the parent keeps its block (a row from before parts, say).
    const repo = new Repo(doc, liveWrites(doc), 'local');
    await repo.putTask({ ...(await repo.getTask(part.id))!, parentId: p.id });
    expect(await call('sync_calendar_event', { taskId: p.id })).toMatchObject({
      outcome: 'removed',
      task: { gcalEventId: null },
    });
    expect(google.events.size).toBe(0);
  });

  it('create_calendar_event names a part’s block after its parent by default', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const p = (await call('create_task', { title: 'P2' })) as Task;
    const part = (await call('create_task', { title: 'read', parentId: p.id })) as Task;
    const t = (await call('create_calendar_event', {
      taskId: part.id,
      start: '2026-10-08T14:00:00-07:00',
      durationMin: 30,
    })) as Task;
    expect(google.events.get(t.gcalEventId!)!.title).toBe('P2 · read');
  });

  it('a refusal clears a moot failure note — a Retry that can’t do anything never lingers', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    google.insertEvent = async () => {
      throw new Error('quota');
    };
    const t = (await call('create_task', timed)) as Task; // the auto create fails
    expect(t.gcalSyncError).toMatch(/quota/);
    await setup.updateSettings({ autoCalendar: false }); // the note is moot now, but nothing re-synced it
    await expect(call('sync_calendar_event', { taskId: t.id })).rejects.toThrow(/Auto-sync is off/);
    expect(
      ((await call('list_tasks')) as Task[]).find((x) => x.id === t.id)!.gcalSyncError,
    ).toBeNull();
    expect(google.events.size).toBe(0);
  });

  it('a Google failure is an error, and its note stays on the task', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const t = (await call('create_task', { title: 'pset' })) as Task;
    await call('update_task', { id: t.id, dueDay: '2026-10-09' });
    let detail = 'quota';
    google.insertEvent = async () => {
      throw new Error(detail);
    };
    await call('update_task', { id: t.id, dueTime: '16:00' }); // the auto create fails
    detail = 'timeout'; // so a stale note can't pass for this call's
    await expect(call('sync_calendar_event', { taskId: t.id })).rejects.toThrow(
      /Couldn’t add the calendar event.*timeout/,
    );
    expect(((await call('list_tasks')) as Task[])[0]!.gcalSyncError).toMatch(/timeout/);
  });

  it('a failed owed removal throws; on a timed task the owed note is cleared by a full update', async () => {
    const { call, setup, doc, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const repo = new Repo(doc, liveWrites(doc), 'local');
    const owe = async (id: string, over: Partial<Task>) =>
      repo.putTask({
        ...(await repo.getTask(id))!,
        gcalSyncError: gcalSyncMessage('delete', 'x'),
        ...over,
      });
    const untimed = (await call('create_task', timed)) as Task;
    await owe(untimed.id, { dueTime: null });
    google.deleteEvent = async () => {
      throw new Error('boom');
    };
    await expect(call('sync_calendar_event', { taskId: untimed.id })).rejects.toThrow(
      /Couldn’t remove the calendar event/,
    );
    const stillTimed = (await call('create_task', timed)) as Task;
    await owe(stillTimed.id, {});
    expect(await call('sync_calendar_event', { taskId: stillTimed.id })).toMatchObject({
      outcome: 'updated',
      task: { gcalEventId: stillTimed.gcalEventId, gcalSyncError: null },
    });
  });

  it('an untimed task’s manual block gets a title-only update', async () => {
    const { call, setup, google } = makeEnv();
    await setup.completeGoogleConnect('A');
    const t = (await call('create_task', { title: 'loose' })) as Task;
    const linked = (await call('create_calendar_event', {
      taskId: t.id,
      start: '2026-10-09T09:00:00-07:00',
      durationMin: 30,
    })) as Task;
    google.editEvent(linked.gcalEventId!, { title: 'g' });
    const start = google.events.get(linked.gcalEventId!)!.startMs;
    expect(await call('sync_calendar_event', { taskId: t.id })).toMatchObject({
      outcome: 'updated',
    });
    expect(google.events.get(linked.gcalEventId!)).toMatchObject({
      title: 'loose',
      startMs: start,
    });
  });

  it('create_calendar_event’s refusal points at sync_calendar_event', async () => {
    const { call, setup } = makeEnv();
    await setup.completeGoogleConnect('A');
    const t = (await call('create_task', timed)) as Task;
    await expect(
      call('create_calendar_event', {
        taskId: t.id,
        start: '2026-10-09T09:00:00-07:00',
        durationMin: 30,
      }),
    ).rejects.toThrow(/Auto-sync places.*sync_calendar_event \{taskId\}/);
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
