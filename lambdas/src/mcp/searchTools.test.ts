import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiMethod, CreateTaskInput, Task } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { pk, sk } from '../ddb/keys';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { notesSnippet } from './searchTools';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// search_tasks and list_tasks' compact form over the real handleRpc path, with a second user in the same
// table and a spy on what each tool dispatched.
const U = 'local';
let clock: number;
let doc: InMemoryDoc;
let backend: BackendClient;
let ctx: ToolContext;
let dispatched: string[];

const backendFor = (userId: string) =>
  new BackendClient(new Repo(doc, liveWrites(doc), userId), { userId, now: () => clock });

beforeEach(() => {
  clock = 1_700_000_000_000;
  doc = new InMemoryDoc();
  backend = backendFor(U);
  dispatched = [];
  ctx = {
    dispatch: (method: ApiMethod, args: unknown[]) => {
      dispatched.push(method);
      return handleRpc(doc, { userId: U, method, args, now: () => clock });
    },
    upload: async () => {},
    now: () => clock,
  };
});

const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
};
const add = async (input: CreateTaskInput, on = backend) => {
  clock += 1000;
  return on.createTask(input);
};
interface Row {
  id: string;
  notesSnippet?: string;
  parts?: unknown;
  [k: string]: unknown;
}
interface Answer {
  query: string;
  totalMatches: number;
  more: boolean;
  tasks: Row[];
}
const search = async (args: Record<string, unknown>) => (await run('search_tasks', args)) as Answer;
const ids = (a: Answer) => a.tasks.map((t) => t.id);
const COMPACT_KEYS = [
  'categoryId',
  'dueDay',
  'dueTime',
  'estimateMin',
  'id',
  'parentId',
  'status',
  'title',
];

describe('search_tasks', () => {
  it('finds by a title word or a notes word, case-insensitive, every word in any order', async () => {
    const a = await add({ title: 'Renew passport photo' });
    const b = await add({ title: 'Call the bank', notes: 'Ask about the\n\nZEPHYR card fee' });
    await add({ title: 'Water plants' });
    expect(ids(await search({ query: 'passport' }))).toEqual([a.id]);
    expect(ids(await search({ query: 'zephyr' }))).toEqual([b.id]);
    expect(ids(await search({ query: 'FEE bank' }))).toEqual([b.id]); // one in the notes, one in the title
    expect(await search({ query: 'bank nowhere' })).toEqual({
      query: 'bank nowhere',
      totalMatches: 0,
      more: false,
      tasks: [],
    });
  });

  it('returns compact rows with a snippet only when the notes matched', async () => {
    const t = await add({
      title: 'Call the bank',
      notes: 'Ask about the\n\nzephyr card fee',
      estimateMin: 20,
    });
    const [byNotes] = (await search({ query: 'zephyr' })).tasks;
    expect(Object.keys(byNotes!).sort()).toEqual([...COMPACT_KEYS, 'notesSnippet'].sort());
    expect(byNotes).toMatchObject({
      id: t.id,
      title: 'Call the bank',
      status: 'backlog',
      estimateMin: 20,
    });
    expect(byNotes!.notesSnippet).toBe('Ask about the zephyr card fee');
    const [byTitle] = (await search({ query: 'bank' })).tasks;
    expect(Object.keys(byTitle!).sort()).toEqual(COMPACT_KEYS);
  });

  it('filters narrow by status (one or a list), category and due range', async () => {
    const cat = await backend.upsertCategory({ label: 'Errands', isWork: false });
    const a = await add({ title: 'find alpha', estimateMin: 15 });
    await backend.transitionTask(a.id, 'in_progress');
    const b = await add({ title: 'find beta', dueDay: '2026-12-01' });
    const c = await add({
      title: 'find gamma',
      categoryId: cat.id,
      dueDay: '2026-12-02',
      dueTime: '09:30',
    });
    const d = await add({ title: 'find delta' });
    expect(ids(await search({ query: 'find', status: 'in_progress' }))).toEqual([a.id]);
    expect(ids(await search({ query: 'find', status: ['done', 'in_progress'] }))).toEqual([a.id]);
    expect(ids(await search({ query: 'find', status: 'backlog' }))).toEqual([d.id, c.id, b.id]);
    expect(ids(await search({ query: 'find', categoryId: cat.id }))).toEqual([c.id]);
    expect(
      ids(await search({ query: 'find', dueFrom: '2026-12-01', dueTo: '2026-12-01' })),
    ).toEqual([b.id]);
    expect(ids(await search({ query: 'find', dueFrom: '2026-12-02' }))).toEqual([c.id]);
    expect(ids(await search({ query: 'find', dueTo: '2026-12-01' }))).toEqual([b.id]);
    expect(
      ids(await search({ query: 'find', dueFrom: '2026-11-01', dueTo: '2026-12-31' })),
    ).toEqual([c.id, b.id]);
    const [row] = (await search({ query: 'gamma' })).tasks;
    expect(row).toMatchObject({ dueDay: '2026-12-02', dueTime: '09:30', categoryId: cat.id });
  });

  it('limit 50 returns 50 and says more matched', async () => {
    for (let i = 0; i < 51; i++) await add({ title: `bulk ${i}` });
    const capped = await search({ query: 'bulk', limit: 50 });
    expect(capped.tasks).toHaveLength(50);
    expect(capped).toMatchObject({ totalMatches: 51, more: true });
    expect(capped.tasks[0]!.title).toBe('bulk 50'); // newest first, cut after counting
    expect((await search({ query: 'bulk' })).tasks).toHaveLength(25); // the default
    await backend.deleteTask(capped.tasks[0]!.id);
    expect(await search({ query: 'bulk', limit: 50 })).toMatchObject({
      totalMatches: 50,
      more: false,
    });
  });

  it('a parent keeps its parts summary and a part its parentId', async () => {
    const p = await add({ title: 'launch site' });
    const part = await add({ title: 'launch copy', parentId: p.id, estimateMin: 30 });
    const rows = (await search({ query: 'launch' })).tasks;
    expect(rows.find((r) => r.id === p.id)!.parts).toEqual({ total: 1, done: 0, estimateMin: 30 });
    expect(rows.find((r) => r.id === part.id)).toMatchObject({ parentId: p.id });
    expect(rows.find((r) => r.id === part.id)!.parts).toBeUndefined();
  });

  it('a row from before dueTime and parentId still has every key', async () => {
    const t = await add({ title: 'old row', notes: 'kept' });
    // Strip the fields a pre-existing row lacks, straight in the table.
    const item = (await doc.query(pk(U), sk.task(t.id)))[0]!;
    const old = { ...item };
    for (const k of ['dueTime', 'parentId', 'notes']) delete old[k];
    doc.putNow(old);
    const [row] = (await search({ query: 'old row' })).tasks;
    expect(row).toEqual({
      id: t.id,
      title: 'old row',
      status: 'backlog',
      dueDay: null,
      dueTime: null,
      estimateMin: null,
      categoryId: null,
      parentId: null,
    });
  });

  it("search_tasks never returns another user's task", async () => {
    await add({ title: 'shared word secretive' }, backendFor('someone-else'));
    const mine = await add({ title: 'shared word' });
    expect(ids(await search({ query: 'shared word' }))).toEqual([mine.id]);
  });

  it('refuses bad arguments before any read', async () => {
    const bad: Record<string, unknown>[] = [
      { query: '   ' },
      { query: 'x'.repeat(201) },
      { query: 'a', limit: 0 },
      { query: 'a', limit: 51 },
      { query: 'a', limit: 2.5 },
      { query: 'a', status: 'open' },
      { query: 'a', status: [] },
      { query: 'a', status: ['done', 'nope'] },
      { query: 'a', categoryId: 7 },
      { query: 'a', dueFrom: '2026-13-01' },
      { query: 'a', dueFrom: '2026-12-02', dueTo: '2026-12-01' },
      { query: 'a', due: '2026-12-01' },
    ];
    for (const args of bad)
      await expect(search(args), JSON.stringify(args)).rejects.toThrow(RpcParamError);
    expect(dispatched).toEqual([]);
  });
});

describe('list_tasks compact', () => {
  it('list_tasks without compact returns every stored field, as before', async () => {
    const p = await add({ title: 'parent', notes: 'long notes' });
    await add({ title: 'part', parentId: p.id, estimateMin: 10 });
    const stored = await backend.listTasks();
    const expected = stored.map((t: Task) =>
      t.id === p.id ? { ...t, parts: { total: 1, done: 0, estimateMin: 10 } } : t,
    );
    expect(await run('list_tasks')).toEqual(expected);
    expect(await run('list_tasks', { compact: false })).toEqual(expected);
  });

  it('compact: true gives the compact rows, with status still applied', async () => {
    const p = await add({ title: 'parent', notes: 'long notes', dueDay: '2026-12-01' });
    await add({ title: 'part', parentId: p.id, estimateMin: 10 });
    const rows = (await run('list_tasks', { compact: true })) as Row[];
    expect(rows).toHaveLength(2);
    for (const r of rows)
      expect(
        Object.keys(r)
          .filter((k) => k !== 'parts')
          .sort(),
      ).toEqual(COMPACT_KEYS);
    expect(rows.find((r) => r.id === p.id)).toMatchObject({
      dueDay: '2026-12-01',
      parts: { total: 1, done: 0, estimateMin: 10 },
    });
    expect(await run('list_tasks', { compact: true, status: 'done' })).toEqual([]);
    await expect(run('list_tasks', { compact: 'yes' })).rejects.toThrow(RpcParamError);
    await expect(run('list_tasks', { compact: null })).rejects.toThrow(RpcParamError);
  });

  it('list_backlog still carries parts on a parent', async () => {
    const p = await add({ title: 'parent' });
    await add({ title: 'part', parentId: p.id, estimateMin: 10 });
    const rows = (await run('list_backlog')) as Row[];
    expect(rows.find((r) => r.id === p.id)!.parts).toEqual({ total: 1, done: 0, estimateMin: 10 });
  });
});

describe('search_tasks and compact list_tasks only read', () => {
  it('each dispatches listTasks once and nothing else', async () => {
    await add({ title: 'one' });
    for (const [name, args] of [
      ['search_tasks', { query: 'one' }],
      ['list_tasks', { compact: true }],
      ['list_tasks', {}],
    ] as const) {
      dispatched = [];
      await run(name, args);
      expect(dispatched, name).toEqual(['listTasks']);
    }
  });
});

describe('notesSnippet', () => {
  it('notesSnippet cuts cleanly around the first matching word', () => {
    expect(notesSnippet('zephyr at the start', ['zephyr'])).toBe('zephyr at the start');
    const long = `${'a'.repeat(100)} zephyr ${'b'.repeat(100)}`;
    const s = notesSnippet(long, ['zephyr'])!;
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
    expect(s).toContain('zephyr');
    expect(s.length).toBeLessThanOrEqual(60 * 2 + 'zephyr'.length + 2);
    expect(
      notesSnippet(`${'c'.repeat(100)} at the end zephyr`, ['zephyr'])!.endsWith('zephyr'),
    ).toBe(true);
    expect(notesSnippet('one\n\n  two\tzephyr', ['zephyr'])).toBe('one two zephyr');
    expect(notesSnippet('nothing here', ['zephyr'])).toBeUndefined();
    // earliest of several words wins
    expect(
      notesSnippet(`${'d'.repeat(80)} alpha ${'e'.repeat(80)} zephyr`, ['zephyr', 'alpha']),
    ).toContain('alpha');
    // a cut never halves an emoji: no lone surrogate on either end
    for (let pad = 55; pad < 66; pad++) {
      const emojis = '😀'.repeat(40);
      const out = notesSnippet(`${emojis.slice(0, pad * 2)}x zephyr x${emojis}`, ['zephyr'])!;
      expect(out, String(pad)).not.toMatch(/^…?[\udc00-\udfff]|[\ud800-\udbff]…?$/);
      expect(JSON.stringify(out)).not.toMatch(/\\ud[89ab]/);
    }
  });
});
