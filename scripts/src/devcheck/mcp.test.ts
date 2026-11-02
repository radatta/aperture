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
      'getAttachmentDownloadUrl',
      'listAttachments',
      'listBacklog',
      'listTasks',
      'toolsList',
    ]);
    expect(Object.keys(c.writes).sort()).toEqual(['createTask', 'deleteAttachment', 'deleteTask']);
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

  it('retries a 429, then gives up with the status in the error', async () => {
    let n = 0;
    const flaky = vi.fn<FetchLike>(async () => (n++ < 2 ? http(429, '') : json([])));
    expect(await client(flaky).reads.listTasks()).toEqual([]);
    expect(flaky).toHaveBeenCalledTimes(3);
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
