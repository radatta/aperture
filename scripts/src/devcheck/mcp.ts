// The dev check's MCP client — dev's /mcp as the test user (mcp-login.ts), with api.ts's discipline: every
// write is declared in the one `writes` object below, the only reads are `reads`, every request asserts the
// dev origin, a create is ledgered from its response, and a delete must name a ledger id. The server is
// stateless JSON-RPC (lambdas/src/mcp/protocol.ts): no initialize or session needed; a tool's result is
// `{content: [{type: 'text', text}], isError?}` inside HTTP 200, the text JSON (or 'ok').
import {
  MCP_SERIES_VIA,
  ledgerKind,
  type CreateSeriesInput,
  MCP_CATEGORY_VIA,
  type DevAttachment,
  type DevCategory,
  type DevPlace,
  type DevPlaceDigest,
  type DevSeries,
  type DevTask,
  type FetchLike,
  type LedgerKind,
} from './api';
import { assertDevOrigin, targetOrigin } from './config';
import { DevcheckError } from './errors';
import type { Ledger } from './ledger';

// What live_sitting answers (lambdas/src/mcp/leetcodeTools.ts) — the fields the scenario reads.
export interface DevJudged {
  verdict: string | null;
  detail: { input: string | null; expected: string | null; output: string | null } | null;
}
export interface DevLiveSitting {
  active: boolean;
  sitting?: {
    id: string;
    problem: { slug: string };
    elapsedMin: number;
    liveReads: number;
  };
  code?: { version: number; text: string | null };
  unchangedSinceVersion?: boolean;
  runCount?: number;
  submitCount?: number;
  lastSubmit?: DevJudged | null;
  lastSitting?: {
    id: string;
    status: string;
    liveReads: number;
    problem: { slug: string };
  } | null;
}

export const MCP_CREATE_VIA = 'mcp:create_task';
const mcpUrl = () => `${targetOrigin()}/mcp`;
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

// A JSON-RPC error from dev's /mcp. PARAM_ERROR (-32602) is the protocol's "bad args" — raised by the tool
// before any dispatch (lambdas/src/mcp/types.ts RpcParamError), so the server wrote nothing.
export class McpRpcError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`mcp ${method} → ${code} ${message}`);
    this.name = 'McpRpcError';
    this.code = code;
  }
}
export const PARAM_ERROR = -32602;

export function createMcpClient({
  fetch,
  token,
  ledger,
  run,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: McpDeps) {
  let nextId = 1;
  let throttled = 0; // 429s answered so far, each retried below

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    assertDevOrigin(mcpUrl());
    const send = () =>
      fetch(mcpUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      });
    let res = await send();
    for (const wait of THROTTLE_BACKOFF_MS) {
      if (res.status !== 429) break;
      throttled++;
      await sleep(wait);
      res = await send();
    }
    const text = await res.text();
    if (res.status !== 200)
      throw new Error(`mcp ${method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new McpRpcError(method, body.error.code, body.error.message);
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
    if (r.text === 'ok') return undefined as T;
    try {
      return JSON.parse(r.text) as T;
    } catch {
      throw new Error(`mcp ${name}: a result that isn't JSON`);
    }
  }

  // A write may only touch a row this harness created, through its own kind's methods — as api.ts.
  function assertLedger(id: string, kind: LedgerKind): void {
    if (!ledger.has(id) || ledgerKind(ledger.read(), id) !== kind)
      throw new DevcheckError(
        'LEDGER_GUARD',
        `refusing to touch ${id} — the ledger never recorded it as a ${kind}`,
      );
  }
  const assertLedgerTask = (id: string) => assertLedger(id, 'task');

  const reads = {
    toolsList: async () =>
      (await rpc<{ tools: { name: string }[] }>('tools/list', {})).tools.map((t) => t.name),
    listTasks: () => data<DevTask[]>('list_tasks'),
    listBacklog: () => data<DevTask[]>('list_backlog'),
    getCalibration: (range: { from: string; to: string }) =>
      data<{ taskId: string; reflection?: string | null }[]>('get_calibration', range),
    listAttachments: (taskId: string) => data<DevAttachment[]>('list_attachments', { taskId }),
    getAttachmentDownloadUrl: (id: string) => data<string>('get_attachment_download_url', { id }),
    listPlaces: () => data<DevPlace[]>('list_places'),
    // list_series: the active ones, or every one with includeStopped (a stopped series stays, inactive).
    listSeries: (includeStopped = false) =>
      data<DevSeries[]>('list_series', includeStopped ? { includeStopped: true } : {}),
    listCategories: () => data<DevCategory[]>('list_categories'),
    // The digest plus each errand's id and status (lambdas/src/mcp/placeTools.ts) — a pure read, no heartbeat.
    listPlaceTasks: (place: string) =>
      data<DevPlaceDigest & { tasks: { id: string; title: string; status: string }[] }>(
        'list_place_tasks',
        { place },
      ),
    // live_sitting (lambdas/src/mcp/leetcodeTools.ts): the one read that counts itself — on the open sitting
    // only, which in the dev check is always the scenario's own; its cleanup tombstones that count with it.
    liveSitting: (args: Record<string, unknown> = {}) => data<DevLiveSitting>('live_sitting', args),
  };

  const writes = {
    async createTask(input: {
      title: string;
      estimateMin?: number;
      place?: string | null;
    }): Promise<DevTask> {
      ledger.append({ run, op: 'intent', via: MCP_CREATE_VIA, title: input.title });
      const task = await data<DevTask>('create_task', input);
      ledger.append({ run, op: 'created', id: task.id, via: MCP_CREATE_VIA, title: input.title });
      return task;
    },
    // Patch fields on a task this run created (update_task: place moves it between errand lists; the
    // reflection scenario sets one up for complete_task to keep; the iOS scenario starts one, since the sim
    // never taps Start).
    async updateTask(
      id: string,
      patch: {
        place?: string | null;
        reflection?: string | null;
        estimateMin?: number;
        status?: 'in_progress' | 'done';
      },
    ): Promise<DevTask> {
      assertLedgerTask(id);
      return data<DevTask>('update_task', { id, ...patch });
    },
    // Mark one of this run's tasks done. actualMin is optional only where the server allows it (an errand,
    // a parent) — omitted here, it is left out of the call, never sent as null; so is an omitted reflection
    // or estimate.
    async completeTask(
      id: string,
      actualMin?: number,
      reflection?: string | null,
      estimateMin?: number,
    ): Promise<{ task: DevTask; previousActualMin: number | null }> {
      assertLedgerTask(id);
      return data('complete_task', {
        id,
        ...(actualMin === undefined ? {} : { actualMin }),
        ...(reflection === undefined ? {} : { reflection }),
        ...(estimateMin === undefined ? {} : { estimateMin }),
      });
    },
    // Split one of this run's tasks; what it creates is recorded from the response, so cleanup can remove it.
    async splitTask(
      id: string,
      input: {
        finish: 'done' | 'keep';
        followUpTitle: string;
        actualMin?: number;
        estimateMin?: number;
      },
    ): Promise<{ parent: DevTask; original: DevTask; followUp: DevTask }> {
      assertLedgerTask(id);
      const out = await data<{ parent: DevTask; original: DevTask; followUp: DevTask }>(
        'split_task',
        { id, ...input },
      );
      for (const t of [out.parent, out.followUp])
        ledger.append({ run, op: 'created', id: t.id, via: MCP_CREATE_VIA, title: t.title });
      return out;
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
    // create_series: intent, then the server's id (the series counts from the user's today, server-side). A
    // param error (-32602) is raised before any dispatch, so it resolves the intent as `refused`; any other
    // failure leaves the intent open — the create may have landed.
    async createSeries(input: CreateSeriesInput): Promise<DevSeries> {
      ledger.append({ run, op: 'intent', via: MCP_SERIES_VIA, title: input.title });
      let s: DevSeries;
      try {
        s = await data<DevSeries>('create_series', { ...input });
      } catch (err) {
        if (err instanceof McpRpcError && err.code === PARAM_ERROR)
          ledger.append({ run, op: 'refused', via: MCP_SERIES_VIA, title: input.title });
        throw err;
      }
      ledger.append({ run, op: 'created', id: s.id, via: MCP_SERIES_VIA, title: input.title });
      return s;
    },
    // stop_series on a series this harness created; cleanup still deletes it by id (api.ts deleteSeries).
    // An id the ledger never recorded is refused here; one the server doesn't have throws its text.
    async stopSeries(id: string): Promise<DevSeries> {
      assertLedger(id, 'series');
      return data<DevSeries>('stop_series', { id });
    },
    // The server's answer to stop_series for an id that isn't the user's — no ledger check, since the point is
    // that the server refuses it; the harness only ever names ids no row can have.
    stopSeriesUnknown: (id: string) => tool('stop_series', { id }),
    // create_category, ledgered like create_task (the areas scenario proves `area` on create); cleaned by the
    // API's deleteCategory on the recorded id.
    async createCategory(input: {
      label: string;
      isWork: boolean;
      area?: DevCategory['area'];
    }): Promise<DevCategory> {
      ledger.append({ run, op: 'intent', via: MCP_CATEGORY_VIA, title: input.label });
      const cat = await data<DevCategory>('create_category', input);
      ledger.append({ run, op: 'created', id: cat.id, via: MCP_CATEGORY_VIA, title: input.label });
      return cat;
    },
    // Patch a category this run created (update_category) — the areas scenario sets its area over MCP.
    async updateCategory(
      id: string,
      patch: { label?: string; isWork?: boolean; area?: DevCategory['area'] },
    ): Promise<DevCategory> {
      assertLedger(id, 'category');
      return data<DevCategory>('update_category', { id, ...patch });
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

  return { reads, writes, throttles: () => throttled };
}

export type McpClient = ReturnType<typeof createMcpClient>;
