// The dev check's MCP client — dev's /mcp as the test user (mcp-login.ts), with api.ts's discipline: every
// write is declared in the one `writes` object below, the only reads are `reads`, every request asserts the
// dev origin, a create is ledgered from its response, and a delete must name a ledger id. The server is
// stateless JSON-RPC (lambdas/src/mcp/protocol.ts): no initialize or session needed; a tool's result is
// `{content: [{type: 'text', text}], isError?}` inside HTTP 200, the text JSON (or 'ok').
import { FLUX_SET_VIA, type DevAttachment, type DevTask, type FetchLike } from './api';
import { DEV_ORIGIN, assertDevOrigin } from './config';
import { DevcheckError } from './errors';
import type { Ledger } from './ledger';

export const MCP_CREATE_VIA = 'mcp:create_task';
const MCP_URL = `${DEV_ORIGIN}/mcp`;
const THROTTLE_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]; // as api.ts: a 429 never ran the call

export interface McpDeps {
  fetch: FetchLike;
  token: () => string; // read per call — mcpToken fails a step once the token is nearly expired
  ledger: Ledger;
  run: string;
  sleep?: (ms: number) => Promise<void>;
}

interface ToolResult {
  text: string;
  isError: boolean;
}

export function createMcpClient({
  fetch,
  token,
  ledger,
  run,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: McpDeps) {
  let nextId = 1;

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    assertDevOrigin(MCP_URL);
    const send = () =>
      fetch(MCP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      });
    let res = await send();
    for (const wait of THROTTLE_BACKOFF_MS) {
      if (res.status !== 429) break;
      await sleep(wait);
      res = await send();
    }
    const text = await res.text();
    if (res.status !== 200)
      throw new Error(`mcp ${method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`mcp ${method} → ${body.error.code} ${body.error.message}`);
    return body.result as T;
  }

  async function tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const r = await rpc<{ content: { text: string }[]; isError?: boolean }>('tools/call', {
      name,
      arguments: args,
    });
    return { text: r.content[0]?.text ?? '', isError: r.isError === true };
  }
  // A tool's data; its execution error ("Not found: …") throws with the tool's text.
  async function data<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await tool(name, args);
    if (r.isError) throw new Error(`mcp ${name}: ${r.text}`);
    return (r.text === 'ok' ? undefined : JSON.parse(r.text)) as T;
  }

  // A write may only touch a task this harness created (and not a Flux set's id) — as api.ts.
  function assertLedgerTask(id: string): void {
    const isFlux = ledger.read().some((e) => e.id === id && e.via === FLUX_SET_VIA);
    if (!ledger.has(id) || isFlux)
      throw new DevcheckError(
        'LEDGER_GUARD',
        `refusing to touch ${id} — the ledger never recorded it`,
      );
  }

  const reads = {
    toolsList: async () =>
      (await rpc<{ tools: { name: string }[] }>('tools/list', {})).tools.map((t) => t.name),
    listTasks: () => data<DevTask[]>('list_tasks'),
    listBacklog: () => data<DevTask[]>('list_backlog'),
    listAttachments: (taskId: string) => data<DevAttachment[]>('list_attachments', { taskId }),
    getAttachmentDownloadUrl: (id: string) => data<string>('get_attachment_download_url', { id }),
  };

  const writes = {
    async createTask(input: { title: string; estimateMin?: number }): Promise<DevTask> {
      ledger.append({ run, op: 'intent', via: MCP_CREATE_VIA, title: input.title });
      const task = await data<DevTask>('create_task', input);
      ledger.append({ run, op: 'created', id: task.id, via: MCP_CREATE_VIA, title: input.title });
      return task;
    },
    // Deleting a parent deletes its parts, so a recorded parent with a part the ledger doesn't know is
    // refused, as the pipeline's cleanup does. A task already gone answers Not found — returned, not thrown.
    async deleteTask(
      id: string,
    ): Promise<{ deleted: string; parts: string[] } | { notFound: true }> {
      assertLedgerTask(id);
      const unknownParts = (await reads.listTasks()).filter(
        (t) => t.parentId === id && !ledger.has(t.id),
      );
      if (unknownParts.length)
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete ${id} — it has parts the ledger never recorded`,
        );
      const r = await tool('delete_task', { id });
      if (r.isError && /^Not found/.test(r.text)) return { notFound: true };
      if (r.isError) throw new Error(`mcp delete_task: ${r.text}`);
      const out = JSON.parse(r.text) as { deleted: string; parts?: string[] };
      return { deleted: out.deleted, parts: out.parts ?? [] };
    },
    // Only an attachment the server lists on one of this run's tasks.
    async deleteAttachment(taskId: string, id: string): Promise<{ deleted: string }> {
      assertLedgerTask(taskId);
      if (!(await reads.listAttachments(taskId)).some((a) => a.id === id))
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete attachment ${id} — not on recorded task ${taskId}`,
        );
      return data<{ deleted: string }>('delete_attachment', { id });
    },
  };

  return { reads, writes };
}

export type McpClient = ReturnType<typeof createMcpClient>;
