// The dev check’s MCP client: dev’s /mcp as the test user, through the claude client (mcp-login.ts). Same
// discipline as the BFF client (api.ts): every write is declared in a `writes` object, and a write names a ledger
// id. One file an area under mcp/ (core.ts: the types, the JSON-RPC transport and the guards); this composes
// them. A new tool goes in its area’s file — or a new area file, added below.
export * from './mcp/core';
import { makeCore, type McpDeps } from './mcp/core';
import { tasksReads, tasksWrites } from './mcp/tasks';
import { leetcodeReads, leetcodeWrites } from './mcp/leetcode';
import { toolsReads } from './mcp/tools';
import { financeReads } from './mcp/finance';

export function createMcpClient(deps: McpDeps) {
  const c = makeCore(deps);
  const reads = {
    ...tasksReads(c),
    ...leetcodeReads(c),
    ...toolsReads(c),
    ...financeReads(c),
  };
  const writes = {
    ...tasksWrites(c, reads),
    ...leetcodeWrites(c),
  };
  return { reads, writes, throttles: c.throttles };
}

export type Reads = ReturnType<typeof tasksReads> &
  ReturnType<typeof leetcodeReads> &
  ReturnType<typeof toolsReads> &
  ReturnType<typeof financeReads>;

export type McpClient = ReturnType<typeof createMcpClient>;
