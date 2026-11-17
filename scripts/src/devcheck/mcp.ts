// The dev check's MCP client — dev's /mcp as the test user (mcp-login.ts), with api.ts's discipline: every
// write is declared in the one `writes` object below, the only reads are `reads`, every request asserts the
// dev origin, a create is ledgered from its response, and a delete must name a ledger id. The server is
// stateless JSON-RPC (lambdas/src/mcp/protocol.ts): no initialize or session needed; a tool's result is
// `{content: [{type: 'text', text}], isError?}` inside HTTP 200, the text JSON (or 'ok').
import {
  COACH_ATTEMPT_VIA,
  COACH_FOCUS_VIA,
  COACH_SLOT_VIA,
  coachFocusId,
  coachSlotId,
  MCP_SERIES_VIA,
  ledgerKind,
  type DevCoachToday,
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
import { pendingIds, type Ledger } from './ledger';

// What live_sitting answers (lambdas/src/mcp/leetcodeTools.ts) — the fields the scenario reads.
export interface DevJudged {
  verdict: string | null;
  statusMsg: string | null;
  passed: number | null;
  total: number | null;
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
  code?: { version: number; text: string | null; lang: string | null };
  unchangedSinceVersion?: boolean;
  runCount?: number;
  submitCount?: number;
  lastRun?: DevJudged | null;
  lastSubmit?: DevJudged | null;
  outcome?: { firstSubmitAccepted: boolean | null; submitsBeforeAccepted: number | null };
  lastSitting?: {
    id: string;
    status: string;
    liveReads: number;
    problem: { slug: string };
  } | null;
  slot?: DevLiveSlot | null;
  trace?: string | null;
}

// What mark_peeked / log_attempt answer (coachTools.ts) — the fields the scenario reads.
export interface DevPeeked {
  slug: string;
  peeked: boolean;
  sittingId?: string;
  attemptId?: string;
  nextDue: { dueDay: string; track: string } | null;
}
export interface DevLoggedAttempt {
  id: string;
  slug: string;
  day: string;
  outcome: string;
  nextDue: { dueDay: string; track: string } | null;
}
// What the coach's history and stats reads answer (coachTools.ts) — the fields the scenario reads.
export interface DevRate {
  hit: number;
  of: number;
  pct: number | null;
}
export interface DevProblemRow {
  slug: string;
  patternId: string;
  attempts: number;
  peeked: boolean;
  reSolve: { track: string; dueDay: string | null; graduated: boolean } | null;
}
export interface DevProblemRead {
  problem: { slug: string; title: string; onRoadmap: boolean; url: string };
  record: { attempts: number } | null;
  tries?: { day: string; outcome: string; sittingIds: string[]; attemptIds: string[] }[];
  sittings?: { id: string }[];
}
export interface DevCoachStats {
  from: string | null;
  to: string;
  attempts: number;
  problems: number;
  firstTry: DevRate;
  resolve: DevRate;
  weeks: { week: string; attempts: number }[];
  patterns: { patternId: string; rank: number | null; attempts: number }[];
  note: string;
}
export interface DevFocusSet {
  override: { pattern: string; since: string } | null;
  focus: { patternId: string; day: number; source: string };
}
// live_sitting's slot in today's plan.
export interface DevLiveSlot {
  kind: string;
  reason: string;
  capMin: number;
  overCap: boolean;
  rules: string;
}

// What search_log / list_log answer (lambdas/src/mcp/logTools.ts) — the fields the scenario reads.
export interface DevLogPage {
  entries: {
    id: string;
    day: string;
    text: string;
    createdAt: string;
    localTime: string;
    private?: boolean;
  }[];
  more: boolean;
  nextCursor: string | null;
  totalMatches?: number;
  total?: number;
}
// What get_day answers — the fields the scenario reads.
export interface DevDayView {
  day: string;
  today: string;
  window: { start: string; end: string };
  dayPlan: { intent: string | null } | null;
  log: {
    count: number;
    entries: { id: string; text: string; localTime?: string; private?: boolean }[];
  };
  tasks: {
    done: {
      id: string;
      estimateLockedMin: number | null;
      actualMin: number;
      deltaMin: number | null;
      isCalibrationPoint: boolean;
    }[];
    planned: { id: string; byTime: boolean; plannedMinutes: number | null }[];
    stillOpen: { id: string }[];
    due: { id: string }[];
  };
  calendar: { reason?: string; window?: { start: string; end: string } };
  flux: { sets: unknown[]; daySummary: string };
  leetcode: unknown[];
}

// What get_sitting and list_sittings answer (PR C) — the fields the scenario reads.
export interface DevSittingRead {
  sitting: { id: string; status: string; submitCount: number; liveReads: number } | null;
  problem?: { statement: string | null; companies: string[] };
  timeline?: (
    | { kind: 'codeChanged'; count: number }
    | {
        kind: 'judged';
        type: string;
        n: number;
        verdict: string;
        statusMsg: string | null;
        passed: number | null;
        total: number | null;
        detail: { input: string | null; expected: string | null; output: string | null };
      }
  )[];
  code?: { final: string | null; version: number; lang: string | null };
  review?: { insight: string | null; tags: string[] } | null;
}
export interface DevSittingRow {
  id: string;
  status: string;
  reviewed: boolean;
  tags: string[];
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

  // A coach write the server refused before writing: a param error, or a normalizer's refusal (normalizeCoachAttempt
  // checks the whole list before any row). Any other error may follow a write, so its intent stays open.
  const refusedBeforeWrite = (err: unknown) =>
    (err instanceof McpRpcError && err.code === PARAM_ERROR) ||
    (err instanceof Error &&
      /^mcp (mark_peeked|log_attempt): .*(must be|is limited|Unknown attempt field|At most \d+|A clean attempt|An attempt that read)/.test(
        err.message,
      ));
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
    // The tools as claude.ai sees them, schemas and descriptions included.
    toolSchemas: async () =>
      (
        await rpc<{ tools: { name: string; description?: string; inputSchema: unknown }[] }>(
          'tools/list',
          {},
        )
      ).tools,
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
    // get_sitting / list_sittings (PR C): pure reads.
    getSitting: (args: Record<string, unknown> = {}) => data<DevSittingRead>('get_sitting', args),
    listSittings: (args: Record<string, unknown> = {}) =>
      data<{ sittings: DevSittingRow[]; more: boolean }>('list_sittings', args),
    // The Log tools (lambdas/src/mcp/logTools.ts): pure reads. Args go as given — the param-error rows
    // send bad ones on purpose.
    searchLog: (args: Record<string, unknown>) => data<DevLogPage>('search_log', args),
    listLog: (args: Record<string, unknown>) => data<DevLogPage>('list_log', args),
    getDay: (args: Record<string, unknown>) => data<DevDayView>('get_day', args),
    leetcodeToday: (args: Record<string, unknown> = {}) =>
      data<DevCoachToday>('leetcode_today', args),
    // The coach's history, stats and story reads: pure reads, args as given.
    listProblems: (args: Record<string, unknown> = {}) =>
      data<{ today?: string; problems: DevProblemRow[]; more: boolean; note?: string }>(
        'list_problems',
        args,
      ),
    getProblem: (args: Record<string, unknown>) => data<DevProblemRead>('get_problem', args),
    coachStats: (args: Record<string, unknown> = {}) => data<DevCoachStats>('coach_stats', args),
    listStories: () =>
      data<{ stories: { id: string; title: string }[]; note?: string }>('list_stories', {}),
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
    // A create_task the server must refuse (bff-shapes: a title over the BFF's cap), ledgered like a create:
    // an execution error resolves the intent as `refused`; a create a regression let through is recorded
    // and cleaned like any other. Returns the tool's answer for the step to read.
    async createTaskExpectingRefusal(input: { title: string }): Promise<ToolResult> {
      ledger.append({ run, op: 'intent', via: MCP_CREATE_VIA, title: input.title });
      const r = await tool('create_task', input);
      if (r.isError) ledger.append({ run, op: 'refused', via: MCP_CREATE_VIA, title: input.title });
      else {
        const task = JSON.parse(r.text) as DevTask;
        ledger.append({ run, op: 'created', id: task.id, via: MCP_CREATE_VIA, title: input.title });
      }
      return r;
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

    // The LeetCode coach's writes (lambdas/src/mcp/coachTools.ts). Args go as given — the param-error rows send
    // bad ones on purpose. An attempt is recorded from the answer; a slot change before the call (coachSlotId).
    async markPeeked(args: Record<string, unknown>): Promise<DevPeeked> {
      if (typeof args.sittingId === 'string') assertLedger(args.sittingId, 'sitting');
      const title = `peek ${String(args.slug ?? args.sittingId)}`;
      ledger.append({ run, op: 'intent', via: COACH_ATTEMPT_VIA, title });
      let out: DevPeeked;
      try {
        out = await data<DevPeeked>('mark_peeked', args);
      } catch (err) {
        if (refusedBeforeWrite(err))
          ledger.append({ run, op: 'refused', via: COACH_ATTEMPT_VIA, title });
        throw err; // anything else may have written: the intent stays open, reported as an orphan
      }
      // On a sitting there is no attempt: the intent resolves as a refusal (nothing of its kind was made).
      if (out.attemptId)
        ledger.append({ run, op: 'created', id: out.attemptId, via: COACH_ATTEMPT_VIA, title });
      else ledger.append({ run, op: 'refused', via: COACH_ATTEMPT_VIA, title });
      return out;
    },
    // mark_peeked on an id that isn't the user's: must be refused, so nothing can be written (lc-coach ownership).
    markPeekedUnknown: (unknownId: string) =>
      data<DevPeeked>('mark_peeked', { sittingId: unknownId }),
    setCauseTagUnknown: (unknownId: string) =>
      data<unknown>('set_cause_tag', { sittingId: unknownId, cause: 'boundary' }),
    async setCauseTag(
      args: Record<string, unknown>,
    ): Promise<{ sittingId: string; review: unknown }> {
      if (typeof args.sittingId !== 'string')
        throw new DevcheckError('LEDGER_GUARD', 'set_cause_tag needs a recorded sittingId here');
      assertLedger(args.sittingId, 'sitting');
      return data('set_cause_tag', args);
    },
    // swap or skip on today's slot `origin` (the engine's pick); a restore resolves the recorded change.
    async swapSlot(
      day: string,
      origin: string,
      args: Record<string, unknown>,
    ): Promise<DevCoachToday> {
      const id = coachSlotId(run, day, origin);
      if (args.action === 'restore') {
        assertLedger(id, 'coachSlot');
        const t = await data<DevCoachToday>('swap_slot', args);
        ledger.append({ run, op: 'deleted', id });
        return t;
      }
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: COACH_SLOT_VIA, title: origin });
      return data<DevCoachToday>('swap_slot', args);
    },
    // The focus override, as api.ts's setCoachFocus: recorded before setting it, resolved when cleared.
    async setFocusPattern(pattern: unknown): Promise<DevFocusSet> {
      const id = coachFocusId(run);
      const sets = typeof pattern === 'string';
      if (sets && !pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: COACH_FOCUS_VIA, title: pattern });
      const out = await data<DevFocusSet>('set_focus_pattern', { pattern });
      if (pattern === null && ledger.has(id)) ledger.append({ run, op: 'deleted', id });
      return out;
    },
    // delete_attempt on an attempt this run logged; the ledger resolves when the tool says it went.
    async deleteAttempt(
      id: string,
    ): Promise<{ id: string; deleted: boolean; slug?: string; nextDue?: unknown }> {
      assertLedger(id, 'coachAttempt');
      const out = await data<{ id: string; deleted: boolean; slug?: string }>('delete_attempt', {
        id,
      });
      if (out.deleted) ledger.append({ run, op: 'deleted', id });
      return out;
    },
    // delete_attempt on an id this run never logged: must write nothing (lc-coach mcp-b-bad-args).
    deleteAttemptUnknown: (unknownId: unknown) =>
      data<{ id: string; deleted: boolean }>('delete_attempt', { id: unknownId }),
    async logAttempt(
      attempts: Record<string, unknown>[],
    ): Promise<{ attempts: DevLoggedAttempt[] }> {
      const title = `log ${attempts.map((a) => String(a.slug)).join(',')}`;
      ledger.append({ run, op: 'intent', via: COACH_ATTEMPT_VIA, title });
      let out: { attempts: DevLoggedAttempt[] };
      try {
        out = await data<{ attempts: DevLoggedAttempt[] }>('log_attempt', { attempts });
      } catch (err) {
        if (refusedBeforeWrite(err))
          ledger.append({ run, op: 'refused', via: COACH_ATTEMPT_VIA, title });
        throw err;
      }
      for (const a of out.attempts)
        ledger.append({ run, op: 'created', id: a.id, via: COACH_ATTEMPT_VIA, title });
      return out;
    },
  };

  return { reads, writes, throttles: () => throttled };
}

export type McpClient = ReturnType<typeof createMcpClient>;
