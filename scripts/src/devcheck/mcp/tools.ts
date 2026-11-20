// The dev check’s MCP client (mcp.ts), tools: the tool list and schemas, and the wrong-agent-token probe.
// Its internals come from core.ts under the names the bodies use.
import { type Core } from './core';

export function toolsReads(c: Core) {
  const { rpc, agentTokenProbe } = c;
  const reads = {
    agentTokenProbe, // core.ts: it shares rpc's id counter
    toolsList: async () =>
      (await rpc<{ tools: { name: string }[] }>('tools/list', {})).tools.map((t) => t.name),
    // The tools as claude.ai sees them, schemas and descriptions included.
    toolSchemas: async () =>
      (
        await rpc<{
          tools: {
            name: string;
            description?: string;
            inputSchema: unknown;
            annotations?: Record<string, unknown>;
          }[];
        }>('tools/list', {})
      ).tools,
  };
  return reads;
}
