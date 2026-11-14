import { beforeEach, describe, expect, it } from 'vitest';
import { PLACE_FINISHED_ERROR, PLACE_PART_ERROR, placeUnknownError } from '@aperture/shared';
import type { ApiMethod, Place, Task } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// Places over MCP (places.md): the two reads, `place` on the task tools, and complete_task's errand
// exemption — all through the real handleRpc path.
const U = 'local';
let clock = 1_700_000_000_000;
const now = () => clock;
let doc: InMemoryDoc;
let setup: BackendClient;
let ctx: ToolContext;

beforeEach(() => {
  clock = 1_700_000_000_000;
  doc = new InMemoryDoc();
  setup = new BackendClient(new Repo(doc, liveWrites(doc), U), { userId: U, now });
  ctx = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(doc, { userId: U, method, args, now }),
    upload: async () => {},
    now,
  };
});
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
};

describe('list_places / list_place_tasks', () => {
  it('lists places in add order, and one list as the notification text plus ids', async () => {
    await setup.upsertPlace({ name: 'Grocer' });
    clock += 1;
    await setup.upsertPlace({ name: 'Tackle' });
    expect(((await call('list_places')) as Place[]).map((p) => p.slug)).toEqual([
      'grocer',
      'tackle',
    ]);
    const a = await setup.createTask({ title: 'batteries', place: 'grocer' });
    clock += 1;
    const b = await setup.createTask({ title: 'tape', place: 'grocer' });
    await setup.createTask({ title: 'socks', place: 'tackle' });
    const out = await call('list_place_tasks', { place: '@Grocer' });
    expect(out).toEqual({
      place: 'Grocer',
      slug: 'grocer',
      count: 2,
      titles: ['batteries', 'tape'],
      text: 'Grocer · 2 — batteries, tape',
      tasks: [
        { id: a.id, title: 'batteries', status: 'backlog' },
        { id: b.id, title: 'tape', status: 'backlog' },
      ],
    });
  });

  it('is a pure read: no heartbeat on the place', async () => {
    await setup.upsertPlace({ name: 'Grocer' });
    const before = doc.snapshot();
    await call('list_place_tasks', { place: 'grocer' });
    expect(doc.snapshot()).toEqual(before);
    expect((await setup.listPlaces())[0]!.lastReadAt).toBeNull();
  });

  it('refuses a missing place and names an unknown one', async () => {
    await expect(call('list_place_tasks', {})).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('list_place_tasks', { place: 3 })).rejects.toBeInstanceOf(RpcParamError);
    await expect(call('list_place_tasks', { place: 'tackle' })).rejects.toThrow(
      placeUnknownError('tackle'),
    );
  });
});

describe('place on the task tools', () => {
  beforeEach(async () => {
    await setup.upsertPlace({ name: 'Grocer' });
  });

  it('create_task / create_tasks take a place (as the model may say it); an unknown one creates none', async () => {
    const t = (await call('create_task', { title: 'batteries', place: 'Grocer' })) as Task;
    expect(t.place).toBe('grocer');
    const many = (await call('create_tasks', {
      tasks: [{ title: 'tape', place: 'grocer' }, { title: 'plain' }],
    })) as Task[];
    expect(many.map((x) => x.place)).toEqual(['grocer', null]);
    const before = (await setup.listTasks()).length;
    await expect(
      call('create_tasks', { tasks: [{ title: 'ok' }, { title: 'bad', place: 'tackle' }] }),
    ).rejects.toThrow(placeUnknownError('tackle'));
    expect(await setup.listTasks()).toHaveLength(before);
    await expect(call('create_task', { title: 'x', place: 5 })).rejects.toBeInstanceOf(
      RpcParamError,
    );
  });

  it("update_task sets and clears an open task's place; a finished task's is history", async () => {
    const t = (await call('create_task', { title: 'batteries' })) as Task;
    expect(((await call('update_task', { id: t.id, place: 'grocer' })) as Task).place).toBe(
      'grocer',
    );
    expect(((await call('update_task', { id: t.id, place: null })) as Task).place).toBeNull();
    await expect(call('update_task', { id: t.id, place: 'tackle' })).rejects.toThrow(
      /No place "tackle".*already applied: none/,
    );
    await call('update_task', { id: t.id, place: 'grocer' });
    await call('complete_task', { id: t.id });
    await expect(call('update_task', { id: t.id, place: null })).rejects.toThrow(
      PLACE_FINISHED_ERROR,
    );
    expect((await setup.getTask(t.id))!.place).toBe('grocer');
  });

  it("a part follows its parent's place: create and update refuse another, parentId applies first", async () => {
    await setup.upsertPlace({ name: 'Tackle' });
    const party = (await call('create_task', { title: 'party', place: 'grocer' })) as Task;
    const cups = (await call('create_task', { title: 'cups', parentId: party.id })) as Task;
    expect(cups.place).toBe('grocer');
    await expect(
      call('create_task', { title: 'x', parentId: party.id, place: 'tackle' }),
    ).rejects.toThrow(PLACE_PART_ERROR);
    await expect(call('update_task', { id: cups.id, place: 'tackle' })).rejects.toThrow(
      PLACE_PART_ERROR,
    );
    // Its parent's own place is a no-op, as create_task takes it — alone or with the attach.
    expect(((await call('update_task', { id: cups.id, place: 'grocer' })) as Task).place).toBe(
      'grocer',
    );
    const lid = (await call('create_task', { title: 'lid' })) as Task;
    const attached = (await call('update_task', {
      id: lid.id,
      parentId: party.id,
      place: 'grocer',
    })) as Task;
    expect(attached).toMatchObject({ parentId: party.id, place: 'grocer' });
    // An attach with a place: attached, then the place refused — never silently the parent's.
    const loose = (await call('create_task', { title: 'ice' })) as Task;
    await expect(
      call('update_task', { id: loose.id, parentId: party.id, place: 'tackle' }),
    ).rejects.toThrow(new RegExp(`${PLACE_PART_ERROR}.*already applied: parentId`));
    expect((await setup.getTask(loose.id))!.place).toBe('grocer');
    // A detach with a place: detached first, so the place lands.
    const out = (await call('update_task', {
      id: cups.id,
      parentId: null,
      place: 'tackle',
    })) as Task;
    expect(out).toMatchObject({ parentId: null, place: 'tackle' });
  });

  it('complete_task checks off an errand without actualMin — and no calibration point', async () => {
    const t = (await call('create_task', {
      title: 'batteries',
      place: 'grocer',
      estimateMin: 5,
    })) as Task;
    const res = (await call('complete_task', { id: t.id })) as { task: Task };
    expect(res.task.status).toBe('done');
    expect(res.task.actualAccruedMin).toBe(0);
    expect(await setup.getCalibration({ from: '2000-01-01', to: '2100-01-01' })).toEqual([]);
    // An actual given anyway is recorded; a plain task still needs one.
    const u = (await call('create_task', { title: 'tape', place: 'grocer' })) as Task;
    expect(
      ((await call('complete_task', { id: u.id, actualMin: 3 })) as { task: Task }).task
        .actualAccruedMin,
    ).toBe(3);
    const plain = (await call('create_task', { title: 'pset' })) as Task;
    await expect(call('complete_task', { id: plain.id })).rejects.toThrow(/actualMin/);
  });

  it('complete_task on an errand without actualMin saves a reflection after the check-off', async () => {
    const t = (await call('create_task', { title: 'stamps', place: 'grocer' })) as Task;
    const seen: string[] = [];
    const inner = ctx.dispatch;
    ctx = { ...ctx, dispatch: (method, args) => (seen.push(method), inner(method, args)) };
    const res = (await call('complete_task', {
      id: t.id,
      reflection: ' only the big bottle ',
    })) as {
      task: Task;
    };
    expect(res.task).toMatchObject({ status: 'done', reflection: 'only the big bottle' });
    expect(seen).not.toContain('setTaskActual'); // no actual for it to ride
    expect(seen.lastIndexOf('setTaskReflection')).toBeGreaterThan(
      seen.lastIndexOf('transitionTask'),
    );
    expect((await setup.getTask(t.id))?.reflection).toBe('only the big bottle');

    // null clears; over the cap lands nothing — the errand stays open.
    const u = (await call('create_task', { title: 'tape', place: 'grocer' })) as Task;
    await setup.setTaskReflection(u.id, 'old');
    const cleared = (await call('complete_task', { id: u.id, reflection: null })) as { task: Task };
    expect(cleared.task).toMatchObject({ status: 'done', reflection: null });
    const v = (await call('create_task', { title: 'cups', place: 'grocer' })) as Task;
    await expect(call('complete_task', { id: v.id, reflection: 'x'.repeat(1001) })).rejects.toThrow(
      /1,000/,
    );
    expect((await setup.getTask(v.id))?.status).toBe('backlog');
  });

  it('a reflection write that fails after the check-off says the task is done', async () => {
    const t = (await call('create_task', { title: 'stamps', place: 'grocer' })) as Task;
    const inner = ctx.dispatch;
    ctx = {
      ...ctx,
      dispatch: (method, args) =>
        method === 'setTaskReflection'
          ? Promise.reject(new Error('throttled'))
          : inner(method, args),
    };
    await expect(call('complete_task', { id: t.id, reflection: 'x' })).rejects.toThrow(
      /throttled \(the task is done; the reflection wasn't saved — use update_task\)/,
    );
    expect((await setup.getTask(t.id))?.status).toBe('done');
  });
});
