// The dev check's MCP client's shared half (mcp.ts composes the client): the types it reads, the JSON-RPC
// transport with its 429 backoff, and the ledger guards every area's reads and writes go through (makeCore).
import {
  ledgerKind,
  type DevCatalogStatus,
  type DevMock,
  type FetchLike,
  type LedgerKind,
} from '../api';
import { AGENT_TOKEN_HEADER, assertDevOrigin, targetOrigin } from '../config';
import { DevcheckError } from '../errors';
import type { Ledger } from '../ledger';

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
    closedBy?: 'idle' | null;
    liveReads: number;
    problem: { slug: string };
  } | null;
  slot?: DevLiveSlot | null;
  trace?: string | null; // the trace comment before the first judged event (traced / none)
}

// What log_mock answers (coachTools.ts): `week` is null, with a note, when only the read after the save failed.
export interface DevLoggedMock {
  mock: DevMock;
  week: string | null;
  note?: string;
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
  historical?: boolean;
  help?: string;
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
  title?: string;
  everAccepted?: boolean;
  patternId: string;
  attempts: number;
  peeked: boolean;
  reSolve: { track: string; dueDay: string | null; graduated: boolean } | null;
}
// catalog_status / import_catalog's answer: the API's status with the import's time as an ISO string.
export type DevMcpCatalogStatus = Omit<DevCatalogStatus, 'importedAt'> & {
  importedAt: string | null;
};
export interface DevProblemRead {
  problem: {
    slug: string;
    title: string;
    difficulty?: string | null;
    onRoadmap: boolean;
    url: string;
    patternId?: string;
    lists?: string[];
    number?: number;
    similar?: { slug: string; title: string }[];
  };
  record: {
    attempts: number;
    everAccepted?: boolean;
    reSolve?: { track: string; dueDay: string | null; graduated: boolean } | null;
  } | null;
  tries?: {
    day: string;
    outcome: string;
    historical?: boolean;
    sittingIds: string[];
    attemptIds: string[];
    claudeNotes?: string[]; // coach-fixes: Claude's notes on that day's sittings
  }[];
  sittings?: { id: string; claudeNotes?: string | null }[];
}
// What set_void and set_claude_notes answer (coach-fixes) — the fields the scenario reads.
export interface DevVoided {
  sittings: {
    sittingId: string;
    slug: string;
    day: string;
    void: boolean;
    nextDue: { dueDay: string; track: string } | null;
  }[];
  legacy: { day: string; slug: string; void: boolean }[];
}
export interface DevNotesSaved {
  saved: { sittingId: string; day: string; claudeNotes: string | null }[];
}
export interface DevCoachStats {
  from: string | null;
  to: string;
  attempts: number;
  problems: number;
  firstTry: DevRate;
  resolve: DevRate;
  weeks: { week: string; attempts: number }[];
  patterns: {
    patternId: string;
    rank: number | null;
    attempts: number;
    submitsPerTry?: number | null; // the Patterns tab's detail
    runBeforeSubmit?: DevRate;
    traced?: DevRate;
    weeks?: { week: string; firstTry: DevRate }[];
  }[];
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
  sitting: {
    id: string;
    status: string;
    closedBy?: 'idle' | null;
    minutes?: number;
    endedAt?: string | null;
    submitCount: number;
    liveReads: number;
  } | null;
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
  review?: { insight: string | null; tags: string[]; test?: boolean } | null;
  trace?: string | null; // coach-fixes: the trace comment before the first judged event (traced / none)
  claudeNotes?: { text: string; updatedAt: string } | null;
}
export interface DevSittingRow {
  id: string;
  status: string;
  closedBy?: 'idle' | null;
  reviewed: boolean;
  tags: string[];
}

export const MCP_CREATE_VIA = 'mcp:create_task';
export const mcpUrl = () => `${targetOrigin()}/mcp`;
export const THROTTLE_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]; // as api.ts: a 429 never ran the call

export interface McpDeps {
  fetch: FetchLike;
  token: () => string; // read per call — mcpToken fails a step once the token is nearly expired
  ledger: Ledger;
  run: string;
  sleep?: (ms: number) => Promise<void>;
}

// What `pulse` answers (lambdas/src/mcp/pulseTools.ts, packages/shared/src/pulse.ts PulseResult).
export interface DevPulseResult {
  task: { id: string; title: string; status: string };
  counted: boolean;
  reason?: 'timer' | 'sitting';
  opened: boolean;
  sessionMin: number;
  taskActualMin: number;
  pulses: number;
  closed?: { taskId: string; minutes: number };
  done?: boolean;
  needs?: 'app' | 'estimate' | 'actual';
  message?: string;
}

export interface ToolResult {
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
export const WRONG_AGENT_TOKEN = 'devcheck-not-an-agent-token';

export function makeCore({
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
  // checks the whole list before any row; normalizeMock the whole mock). Any other error may follow a write, so its intent stays open.
  const refusedBeforeWrite = (err: unknown) =>
    (err instanceof McpRpcError && err.code === PARAM_ERROR) ||
    (err instanceof Error &&
      /^mcp (mark_peeked|log_attempt|log_mock): .*(must be|is limited|Unknown attempt field|At most \d+|A clean attempt|An attempt that read|A solve from before the coach|Unknown mock field|Unknown score|is required, a whole number|A done mock|A planned mock)/.test(
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
  // A refusal call's sitting ids: a recorded one must be a sitting this run made; any other must be one the server
  // doesn't have (get_sitting answers Not found) — so a regression that took the call can only touch this run's rows.
  async function assertMineOrUnknown(ids: unknown[]): Promise<void> {
    for (const id of ids) {
      if (typeof id !== 'string') continue; // malformed: refused at the param check, before any dispatch
      if (ledger.has(id)) {
        assertLedger(id, 'sitting');
        continue;
      }
      const r = await tool('get_sitting', { id });
      if (!(r.isError && /Not found/.test(r.text)))
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to aim at sitting ${id} — the ledger never recorded it and the server has it`,
        );
    }
  }
  const sittingIdsOf = (items: Record<string, unknown>[]) =>
    items.flatMap((x) => (x && 'sittingId' in x ? [x.sittingId] : []));
  // A wrong agent token, no bearer: dev must answer 401 (mcp-auth-closed). The value is a fixed bogus
  // constant — never the real token — and `initialize` reads nothing, so even a regression changes nothing.
  // Here, not in tools.ts, because it shares rpc's id counter; tools.ts exposes it.
  const agentTokenProbe = async (): Promise<{ status: number; error: string | null }> => {
    assertDevOrigin(mcpUrl());
    const res = await fetch(mcpUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_TOKEN_HEADER]: WRONG_AGENT_TOKEN },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: {} }),
    });
    let error: string | null = null;
    try {
      const e = (JSON.parse(await res.text()) as { error?: unknown }).error;
      if (typeof e === 'string') error = e;
    } catch {
      // not JSON (an edge page): error stays null
    }
    return { status: res.status, error };
  };

  return {
    fetch,
    token,
    ledger,
    run,
    sleep,
    rpc,
    tool,
    data,
    refusedBeforeWrite,
    assertLedger,
    assertLedgerTask,
    assertMineOrUnknown,
    sittingIdsOf,
    agentTokenProbe,
    throttles: () => throttled,
  };
}

export type Core = ReturnType<typeof makeCore>;
