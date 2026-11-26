import { TOOLS } from './tools';
import { RpcParamError } from './types';
import { failureStatus, shownMessage } from '../rpc/failure';
import type { ToolContext } from './types';

// A hand-rolled MCP transport core — the STATELESS, tools-only subset of the spec (no sessions, no SSE,
// no server-initiated messages), which is all a request/response Lambda needs. Pure and transport-
// agnostic: one JSON-RPC message in, one response (or null for a notification) out. The full SDK drags in
// two HTTP frameworks + jose + ajv for machinery we don't use — see docs/areas/mcp/index.md for the A/B.

// We implement 2025-06-18; we also accept a client that speaks 2025-03-26 (identical for this subset).
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-03-26'];
const SERVER_INFO = { name: 'aperture', version: '0.1.0' };

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result,
});
const fail = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const toolSpec = (t: (typeof TOOLS)[number]) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  ...(t.annotations ? { annotations: t.annotations } : {}),
});

// Handle one parsed JSON-RPC message. Returns the response, or null for a notification (no reply body).
// The dev meter's op label (ddb/meter.ts): the JSON-RPC method from a fixed set, plus the tool name only when it is a
// known tool — never request text. Non-POST routes (the well-known metadata) read by their HTTP verb.
const MCP_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'tools/call',
  'notifications/initialized',
  'notifications/cancelled',
]);
const HTTP_VERBS = new Set(['GET', 'HEAD', 'OPTIONS']);
export function mcpOp(event: {
  requestContext?: { http?: { method?: string } };
  body?: string | null;
  isBase64Encoded?: boolean;
}): string {
  const verb = event.requestContext?.http?.method;
  if (verb && verb !== 'POST') return HTTP_VERBS.has(verb) ? verb.toLowerCase() : 'unknown';
  try {
    const raw =
      event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
    const msg = (raw ? JSON.parse(raw) : null) as {
      method?: unknown;
      params?: { name?: unknown };
    } | null;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'unknown';
    const method =
      typeof msg.method === 'string' && MCP_METHODS.has(msg.method) ? msg.method : null;
    if (!method) return 'unknown';
    const name = msg.params?.name;
    if (method === 'tools/call')
      return TOOLS.some((t) => t.name === name)
        ? `tools/call:${String(name)}`
        : 'tools/call:unknown';
    return method;
  } catch {
    return 'unparsed';
  }
}

export async function handleMcpMessage(
  msg: unknown,
  ctx: ToolContext,
): Promise<JsonRpcResponse | null> {
  // The 2025-06-18 revision removed JSON-RPC batching — an array is an invalid request.
  if (Array.isArray(msg)) return fail(null, -32600, 'Batch requests are not supported');
  // A value that parsed but isn't a JSON-RPC object (e.g. 5, "x") is an Invalid Request, not a Parse
  // error — the edge already returns -32700 for genuinely unparseable JSON before we get here.
  if (typeof msg !== 'object' || msg === null) {
    return fail(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const req = msg as {
    jsonrpc?: unknown;
    id?: string | number | null;
    method?: unknown;
    params?: unknown;
  };
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return fail(req.id ?? null, -32600, 'Invalid Request');
  }
  // A JSON-RPC notification carries no id → no response. Covers notifications/initialized, .../cancelled.
  if (req.id === undefined) return null;
  const id = req.id;
  const method = req.method;

  try {
    switch (method) {
      case 'initialize':
        return ok(id, initializeResult(req.params));
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS.map(toolSpec) });
      case 'tools/call':
        return ok(id, await callTool(req.params, ctx));
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    // Bad args / unknown tool are protocol errors (-32602); anything else is internal (-32603). A tool's
    // EXECUTION error never reaches here — callTool turns it into an isError result the model can read.
    if (e instanceof RpcParamError) return fail(id, -32602, e.message);
    return fail(id, -32603, shown(e));
  }
}

function initializeResult(params: unknown): unknown {
  const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  const protocolVersion =
    typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested)
      ? requested
      : PROTOCOL_VERSION;
  return { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
}

interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

async function callTool(params: unknown, ctx: ToolContext): Promise<ToolCallResult> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof p.name !== 'string') throw new RpcParamError('tools/call requires a string "name"');
  const tool = TOOLS.find((t) => t.name === p.name);
  if (!tool) throw new RpcParamError(`Unknown tool: ${p.name}`);
  const args =
    p.arguments === undefined || p.arguments === null
      ? {}
      : (p.arguments as Record<string, unknown>);
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcParamError('tools/call "arguments" must be an object');
  }
  try {
    const data = await tool.run(args, ctx);
    return { content: [{ type: 'text', text: data === undefined ? 'ok' : JSON.stringify(data) }] };
  } catch (e) {
    if (e instanceof RpcParamError) throw e; // → -32602 (the model sent bad args)
    // Execution error (e.g. "Not found", "Title is required") → isError so the model can self-correct.
    return { content: [{ type: 'text', text: shown(e) }], isError: true };
  }
}

// The /api edge's rule (rpc/failure.ts): our own refusals keep their message; a fault in our code or any
// AWS error reads `Internal error` / `Request refused` — never its text.
const shown = (e: unknown): string => shownMessage(e, failureStatus(e, 'rpc'));
