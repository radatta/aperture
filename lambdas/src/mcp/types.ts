import type { ApiMethod } from '@aperture/shared';

// A parameter/validation error → JSON-RPC -32602 (a PROTOCOL error the model got wrong: bad args,
// unknown tool). Distinct from a backend EXECUTION error (e.g. "estimate is frozen"), which surfaces as
// an `isError` tool result the model can read and self-correct from. protocol.ts branches on this type.
export class RpcParamError extends Error {}

// What a tool needs to do its work — supplied by the Lambda edge (or a test harness), so the tool logic
// itself is transport-agnostic and unit-testable without AWS.
export interface ToolContext {
  // Dispatch an RPC method through the EXACT same handleRpc path the BFF uses (live writes, the real
  // Google gateway + S3 presigner). One dispatch closes over the resolved userId.
  dispatch: (method: ApiMethod, args: unknown[]) => Promise<unknown>;
  // PUT bytes to a presigned URL. Injected (not a bare fetch) so tests record the upload without a network
  // call — the attach_file path is the only place the MCP server itself moves bytes.
  upload: (url: string, bytes: Buffer, contentType: string) => Promise<void>;
}

// A minimal JSON-Schema object shape — enough for tools/list. We EMIT this for the client's benefit; we
// never evaluate it (arg checking is explicit `typeof` guards in each tool, which give better messages).
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  // Returns the raw data (Task, Task[], …); protocol.ts JSON-stringifies it into the tool result. Throws
  // RpcParamError for bad args (→ -32602) or a plain Error for an execution failure (→ isError result).
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}
