import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from './api';
import { DEV_ORIGIN } from './config';
import type { Ledger, LedgerEntry } from './ledger';
import { MCP_CREATE_VIA, createMcpClient } from './mcp';

function memLedger(initial: Omit<LedgerEntry, 't'>[] = []): Ledger & {
  entries: Omit<LedgerEntry, 't'>[];
} {
  const entries = [...initial];
  return {
    entries,
    append: (x) => void entries.push(x),
    read: () => entries.map((x) => ({ t: '', ...x })),
    has: (id) => entries.some((x) => x.op === 'created' && x.id === id),
  };
}

const http = (status: number, body: unknown) => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const result = (text: string, isError = false) =>
  http(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], isError } });
const json = (data: unknown) => result(JSON.stringify(data));

// A fake /mcp: answers each tools/call by tool name.
function server(answers: Record<string, ReturnType<typeof http>>) {
  return vi.fn<FetchLike>(async (_url, init) => {
    const msg = JSON.parse(init.body as string) as { method: string; params: { name?: string } };
    if (msg.method === 'tools/list')
      return http(200, { result: { tools: [{ name: 'delete_task' }, { name: 'list_backlog' }] } });
    return answers[msg.params.name!] ?? result(`Unknown tool: ${msg.params.name}`, true);
  });
}
const sentTools = (f: ReturnType<typeof server>) =>
  f.mock.calls.map(
    ([, init]) => (JSON.parse(init.body as string) as { params: { name?: string } }).params.name,
  );

const recorded = [{ run: 'r0', op: 'created' as const, id: 'T1', via: 'api:createTask' }];
const client = (fetch: FetchLike, ledger = memLedger(recorded)) =>
  createMcpClient({ fetch, token: () => 'tok', ledger, run: 'r1', sleep: async () => undefined });

describe('createMcpClient', () => {
  it('posts one JSON-RPC tools/call to the dev /mcp with the bearer in authorization', async () => {
    const fetch = server({ list_backlog: json([{ id: 'T1', title: 'a' }]) });
    expect(await client(fetch).reads.listBacklog()).toEqual([{ id: 'T1', title: 'a' }]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${DEV_ORIGIN}/mcp`);
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_backlog', arguments: {} },
    });
  });

  it('exposes exactly the declared reads and writes', () => {
    const c = client(server({}));
    expect(Object.keys(c.reads).sort()).toEqual([
      'coachStats',
      'getAttachmentDownloadUrl',
      'getCalibration',
      'getDay',
      'getProblem',
      'getSitting',
      'leetcodeToday',
      'listAttachments',
      'listBacklog',
      'listCategories',
      'listLog',
      'listPlaceTasks',
      'listPlaces',
      'listProblems',
      'listSeries',
      'listSittings',
      'listStories',
      'listTasks',
      'liveSitting',
      'parseTask',
      'searchLog',
      'toolSchemas',
      'toolsList',
    ]);
    expect(Object.keys(c.writes).sort()).toEqual([
      'completeTask',
      'createCategory',
      'createSeries',
      'createTask',
      'createTaskExpectingRefusal',
      'deleteAttachment',
      'deleteAttempt',
      'deleteAttemptUnknown',
      'deleteTask',
      'logAttempt',
      'markPeeked',
      'markPeekedUnknown',
      'setCauseTag',
      'setCauseTagUnknown',
      'setClaudeNotes',
      'setClaudeNotesRefused',
      'setFocusPattern',
      'setVoid',
      'setVoidRefused',
      'splitTask',
      'stopSeries',
      'stopSeriesUnknown',
      'swapSlot',
      'updateCategory',
      'updateTask',
    ]);
  });

  it('delete_attempt only on a recorded attempt, resolved when it went; set_focus_pattern recorded, then cleared', async () => {
    const ledger = memLedger([{ run: 'r0', op: 'created', id: 'A1', via: 'coach:attempt' }]);
    const fetch = server({
      delete_attempt: json({ id: 'A1', deleted: true, slug: 's' }),
      set_focus_pattern: json({
        override: null,
        focus: { patternId: 'graphs', day: 1, source: 'override' },
      }),
    });
    const c = client(fetch, ledger);
    await expect(c.writes.deleteAttempt('T1')).rejects.toThrow(); // a task id, not an attempt
    expect(await c.writes.deleteAttempt('A1')).toMatchObject({ deleted: true });
    expect(ledger.entries.at(-1)).toMatchObject({ op: 'deleted', id: 'A1' });
    await c.writes.setFocusPattern('graphs');
    expect(ledger.entries.at(-1)).toMatchObject({
      op: 'created',
      id: 'coach-focus:r1',
      via: 'coach:focus',
    });
    await c.writes.setFocusPattern('graphs'); // a repeat records nothing new
    expect(ledger.entries.filter((x) => x.id === 'coach-focus:r1')).toHaveLength(1);
    await c.writes.setFocusPattern(null);
    expect(ledger.entries.at(-1)).toMatchObject({ op: 'deleted', id: 'coach-focus:r1' });
    expect(sentTools(fetch)).toEqual([
      'delete_attempt',
      'set_focus_pattern',
      'set_focus_pattern',
      'set_focus_pattern',
    ]);
  });

  it('set_void and set_claude_notes go only to recorded sittings, with the args as given (coach-fixes)', async () => {
    const ledger = memLedger([
      ...recorded,
      { run: 'r0', op: 'created', id: 'S1', via: 'api:lcSittingStart' },
    ]);
    const fetch = server({
      set_void: json({ sittings: [{ sittingId: 'S1', void: true }], legacy: [] }),
      set_claude_notes: json({ saved: [{ sittingId: 'S1', claudeNotes: 'n' }] }),
    });
    const c = client(fetch, ledger);
    await expect(c.writes.setVoid([{ sittingId: 'T1', void: true }])).rejects.toThrow(
      /LEDGER_GUARD|never recorded/,
    ); // a task id, not a sitting
    await expect(c.writes.setClaudeNotes([{ sittingId: 'S9', text: 'n' }])).rejects.toThrow(
      /never recorded/,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect((await c.writes.setVoid([{ sittingId: 'S1', void: true }])).sittings[0]!.void).toBe(
      true,
    );
    await c.writes.setClaudeNotes([{ sittingId: 'S1', text: 'n' }]);
    const args = fetch.mock.calls.map(
      ([, init]) =>
        (JSON.parse(init.body as string) as { params: { arguments: unknown } }).params.arguments,
    );
    expect(args).toEqual([
      { targets: [{ sittingId: 'S1', void: true }] },
      { notes: [{ sittingId: 'S1', text: 'n' }] },
    ]);
  });

  it('a refusal call sends an unrecorded sitting id only once the server says it has none', async () => {
    const ledger = memLedger([{ run: 'r0', op: 'created', id: 'S1', via: 'api:lcSittingStart' }]);
    const fetch = server({
      get_sitting: result('Not found: 01UNKNOWN', true),
      set_void: result('No sitting 01UNKNOWN — list_sittings gives the ids', true),
      set_claude_notes: result('Not found: 01UNKNOWN', true),
    });
    const c = client(fetch, ledger);
    const r = await c.writes.setVoidRefused([
      { sittingId: 'S1', void: true },
      { sittingId: '01UNKNOWN', void: true },
      { day: '2026-11-01', slug: 'two-sum', void: true },
    ]);
    expect(r).toEqual({
      text: 'No sitting 01UNKNOWN — list_sittings gives the ids',
      isError: true,
    });
    await c.writes.setClaudeNotesRefused([{ sittingId: '01UNKNOWN', text: 'n' }]);
    expect(sentTools(fetch)).toEqual([
      'get_sitting',
      'set_void',
      'get_sitting',
      'set_claude_notes',
    ]);

    // An unrecorded id the server HAS is never sent; nor is a recorded id of another kind.
    const has = server({ get_sitting: json({ sitting: { id: 'S7' } }) });
    await expect(
      client(has, ledger).writes.setVoidRefused([{ sittingId: 'S7', void: true }]),
    ).rejects.toThrow(/LEDGER_GUARD|server has it/);
    await expect(
      client(has, memLedger(recorded)).writes.setClaudeNotesRefused([
        { sittingId: 'T1', text: 'n' },
      ]),
    ).rejects.toThrow(/never recorded/);
    expect(sentTools(has)).toEqual(['get_sitting']);
  });

  it('set_focus_pattern refused at the param check resolves the record it made', async () => {
    const ledger = memLedger();
    const fetch = vi.fn<FetchLike>(async () =>
      http(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad pattern' } }),
    );
    await expect(client(fetch, ledger).writes.setFocusPattern('graph')).rejects.toThrow();
    expect(ledger.entries.map((x) => x.op)).toEqual(['created', 'deleted']);
  });

  it('reads a place’s list by slug, and passes place on create_task', async () => {
    const digest = { place: 'Shop', slug: 'shop', count: 1, titles: ['a'], text: 'Shop · 1 — a' };
    const fetch = server({
      list_place_tasks: json({ ...digest, tasks: [{ id: 'T9', title: 'a', status: 'backlog' }] }),
      create_task: json({ id: 'T9', title: 'a', place: 'shop' }),
    });
    const c = client(fetch);
    expect((await c.reads.listPlaceTasks('shop')).tasks[0]!.id).toBe('T9');
    await c.writes.createTask({ title: 'a', place: 'shop' });
    const args = fetch.mock.calls.map(
      ([, init]) =>
        (JSON.parse(init.body as string) as { params: { arguments: unknown } }).params.arguments,
    );
    expect(args).toEqual([{ place: 'shop' }, { title: 'a', place: 'shop' }]);
  });

  it('update_task and complete_task touch only a recorded task; an omitted actualMin is left out', async () => {
    const fetch = server({
      update_task: json({ id: 'T1', title: 'a', place: 'shop' }),
      complete_task: json({ task: { id: 'T1', title: 'a', status: 'done' }, previousActualMin: 0 }),
    });
    const c = client(fetch);
    await expect(c.writes.updateTask('theirs', { place: 'shop' })).rejects.toThrow(/LEDGER_GUARD/);
    await expect(c.writes.completeTask('theirs')).rejects.toThrow(/LEDGER_GUARD/);
    expect(fetch).not.toHaveBeenCalled();
    expect((await c.writes.updateTask('T1', { place: 'shop' })).place).toBe('shop');
    expect((await c.writes.completeTask('T1')).task.status).toBe('done');
    await c.writes.completeTask('T1', 5);
    const args = fetch.mock.calls.map(
      ([, init]) =>
        (JSON.parse(init.body as string) as { params: { arguments: unknown } }).params.arguments,
    );
    expect(args).toEqual([{ id: 'T1', place: 'shop' }, { id: 'T1' }, { id: 'T1', actualMin: 5 }]);
  });

  it('update_task can start a recorded task (the iOS scenario: the sim never taps Start)', async () => {
    const fetch = server({ update_task: json({ id: 'T1', title: 'a', status: 'in_progress' }) });
    const c = client(fetch);
    await expect(c.writes.updateTask('theirs', { status: 'in_progress' })).rejects.toThrow(
      /LEDGER_GUARD/,
    );
    expect((await c.writes.updateTask('T1', { status: 'in_progress' })).status).toBe('in_progress');
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(
      (JSON.parse(init?.body as string) as { params: { arguments: unknown } }).params.arguments,
    ).toEqual({
      id: 'T1',
      status: 'in_progress',
    });
  });

  it('refuses delete_task on a place id the ledger recorded', async () => {
    const fetch = server({});
    const c = client(
      fetch,
      memLedger([{ run: 'r0', op: 'created', id: 'P1', via: 'ui:upsertPlace' }]),
    );
    await expect(c.writes.deleteTask('P1')).rejects.toThrow(/LEDGER_GUARD/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists tool names, and parses a string result', async () => {
    const fetch = server({ get_attachment_download_url: json('https://signed') });
    const c = client(fetch);
    expect(await c.reads.toolsList()).toEqual(['delete_task', 'list_backlog']);
    expect(await c.reads.getAttachmentDownloadUrl('A1')).toBe('https://signed');
  });

  it('a JSON-RPC error throws its code and message; a tool error throws its text', async () => {
    const rpcError = vi.fn<FetchLike>(async () =>
      http(200, { error: { code: -32602, message: 'bad params' } }),
    );
    await expect(client(rpcError).reads.listTasks()).rejects.toThrow(/-32602 bad params/);
    const toolError = server({ list_tasks: result('boom', true) });
    await expect(client(toolError).reads.listTasks()).rejects.toThrow(/mcp list_tasks: boom/);
  });

  it('records intent before create_task and created after, with the server id', async () => {
    const ledger = memLedger();
    const fetch = server({ create_task: json({ id: 'T9', title: 'x' }) });
    await client(fetch, ledger).writes.createTask({ title: 'x', estimateMin: 15 });
    expect(ledger.entries).toEqual([
      { run: 'r1', op: 'intent', via: MCP_CREATE_VIA, title: 'x' },
      { run: 'r1', op: 'created', id: 'T9', via: MCP_CREATE_VIA, title: 'x' },
    ]);
    expect(
      (JSON.parse(fetch.mock.calls[0]![1].body as string) as { params: unknown }).params,
    ).toEqual({ name: 'create_task', arguments: { title: 'x', estimateMin: 15 } });
  });

  it('refuses delete_task on an id the ledger never recorded — without a request', async () => {
    const fetch = server({});
    await expect(client(fetch).writes.deleteTask('NOPE')).rejects.toThrow(/LEDGER_GUARD/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes a reflection on complete_task and update_task; an omitted one is left out', async () => {
    const fetch = server({
      update_task: json({ id: 'T1', title: 'a', reflection: 'kept' }),
      complete_task: json({ task: { id: 'T1', title: 'a', status: 'done' }, previousActualMin: 0 }),
    });
    const c = client(fetch);
    await c.writes.updateTask('T1', { reflection: 'kept' });
    await c.writes.completeTask('T1', 10, 'went fine');
    await c.writes.completeTask('T1', 10);
    await c.writes.completeTask('T1', 10, undefined, 25);
    const args = fetch.mock.calls.map(
      ([, init]) =>
        (JSON.parse(init.body as string) as { params: { arguments: unknown } }).params.arguments,
    );
    expect(args).toEqual([
      { id: 'T1', reflection: 'kept' },
      { id: 'T1', actualMin: 10, reflection: 'went fine' },
      { id: 'T1', actualMin: 10 },
      { id: 'T1', actualMin: 10, estimateMin: 25 },
    ]);
  });

  it('refuses delete_task on a recorded parent with a part the ledger never recorded', async () => {
    const fetch = server({ list_tasks: json([{ id: 'P9', title: 'p', parentId: 'T1' }]) });
    await expect(client(fetch).writes.deleteTask('T1')).rejects.toThrow(/LEDGER_GUARD.*parts/);
    expect(sentTools(fetch)).toEqual(['list_tasks']);
  });

  it('deletes a recorded task and returns what the server deleted; Not found comes back as notFound', async () => {
    const fetch = server({ list_tasks: json([]), delete_task: json({ deleted: 'T1' }) });
    expect(await client(fetch).writes.deleteTask('T1')).toEqual({ deleted: 'T1', parts: [] });
    const gone = server({ list_tasks: json([]), delete_task: result('Not found: T1', true) });
    expect(await client(gone).writes.deleteTask('T1')).toEqual({ notFound: true });
  });

  it('deletes an attachment only when the task is recorded and the server lists it there', async () => {
    const fetch = server({
      list_attachments: json([{ id: 'A1', taskId: 'T1' }]),
      delete_attachment: json({ deleted: 'A1' }),
    });
    expect(await client(fetch).writes.deleteAttachment('T1', 'A1')).toEqual({ deleted: 'A1' });
    await expect(client(fetch).writes.deleteAttachment('T1', 'A2')).rejects.toThrow(/LEDGER_GUARD/);
    await expect(client(fetch).writes.deleteAttachment('NOPE', 'A1')).rejects.toThrow(
      /LEDGER_GUARD/,
    );
    expect(sentTools(fetch).filter((n) => n === 'delete_attachment')).toHaveLength(1);
  });

  it('a result that isn’t JSON throws naming the tool', async () => {
    await expect(
      client(server({ list_tasks: result('<html>') })).reads.listTasks(),
    ).rejects.toThrow(/^mcp list_tasks: a result that isn't JSON$/);
  });

  it('retries a 429, then gives up with the status in the error', async () => {
    let n = 0;
    const flaky = vi.fn<FetchLike>(async () => (n++ < 2 ? http(429, '') : json([])));
    const c = client(flaky);
    expect(await c.reads.listTasks()).toEqual([]);
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(c.throttles()).toBe(2); // a success can still have been throttled: the counter says so
    const throttled = vi.fn<FetchLike>(async () => http(429, 'Rate exceeded'));
    await expect(client(throttled).reads.listTasks()).rejects.toThrow(/HTTP 429: Rate exceeded/);
    expect(throttled).toHaveBeenCalledTimes(6);
  });

  it('throws on a non-200 with the status and at most 200 chars of the body', async () => {
    const bad = vi.fn<FetchLike>(async () => http(401, 'x'.repeat(500)));
    await expect(client(bad).reads.listTasks()).rejects.toThrow(
      /^mcp tools\/call → HTTP 401: x{200}$/,
    );
  });
});
