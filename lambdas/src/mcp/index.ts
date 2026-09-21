// @aperture/lambdas — the MCP server edge. A SECOND Lambda (aperture-mcp-<stage>), separate from the BFF
// so the agent token's ceiling is this function's IAM. One route: POST /mcp with an MCP JSON-RPC body →
// a tool call dispatched through the SAME handleRpc the BFF uses. Auth is the static agent token in a
// custom header (Claude Code); phase 2 adds a Cognito-bearer path here for claude.ai. Business logic and
// the writes-discipline live in BackendClient/handleRpc — this file is just the AWS/HTTP + auth edge.
import { AGENT_TOKEN_HEADER, APERTURE, AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';
import type { ApiMethod } from '@aperture/shared';
import { createLiveDoc } from '../ddb/LiveDoc';
import { resolveAgentUserId } from '../auth/verify';
import { handleRpc } from '../handler';
import { createLiveGoogle } from '../google/liveGoogle';
import { createS3Presigner } from '../s3/presigner';
import { handleMcpMessage } from './protocol';
import type { ToolContext } from './types';

export const runtime = `${APERTURE}-mcp` as const;

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');
// Built once at cold start; construction never touches the network (empty bucket/URL is fine locally).
const presigner = createS3Presigner(process.env.FILES_BUCKET ?? '');
const STAGE = process.env.STAGE ?? 'dev';
const APP_URL = process.env.APP_URL ?? '';
const google = createLiveGoogle({ stage: STAGE, appUrl: APP_URL });

interface HttpEvent {
  requestContext?: { http?: { path?: string; method?: string } };
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}
interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': `content-type,${AGENT_TOKEN_HEADER},authorization`,
  'access-control-allow-methods': 'POST,OPTIONS',
};

// PUT bytes to a presigned URL — the only place the MCP server itself moves bytes (attach_file's small
// artifacts). content-length must match what was signed, or S3 rejects the PUT.
async function uploadToPresigned(url: string, bytes: Buffer, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': contentType, 'content-length': String(bytes.length) },
  });
  if (!res.ok) throw new Error(`Attachment upload failed: ${res.status}`);
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const httpMethod = event.requestContext?.http?.method;
  const isHttp = event.requestContext?.http !== undefined; // false for direct (CI-cred'd) invokes
  if (httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  // Origin lockdown (HTTP only): the Function URL is public, so only CloudFront-stamped requests are
  // honored. Direct invokes are AWS-cred-gated already. Same gate as the BFF.
  const originSecret = process.env.ORIGIN_SECRET;
  if (isHttp && originSecret && event.headers?.[ORIGIN_SECRET_HEADER] !== originSecret) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  if (httpMethod && httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...HEADERS, allow: 'POST' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Credential: the agent token (a custom header, raw value) is phase 1's only accepted auth. A bearer
  // token is recognized so phase 2 can wire Cognito here; for now it 401s like a missing credential. We
  // disambiguate by CREDENTIAL, not method (the agent token is unscoped — any method).
  const agentHeader = event.headers?.[AGENT_TOKEN_HEADER];
  const bearer = event.headers?.authorization ?? event.headers?.Authorization ?? event.headers?.[AUTH_HEADER];
  const credential = agentHeader !== undefined ? 'agent' : bearer ? 'bearer' : 'none';
  let userId: string;
  try {
    if (credential !== 'agent') {
      throw new Error('Unauthorized: /mcp requires the agent token');
    }
    userId = resolveAgentUserId(agentHeader, process.env.AGENT_TOKEN, process.env.DEVICE_USER_ID);
    // One structured line per auth outcome — this is how a dropped header (Claude Code bug history) is
    // diagnosed from CloudWatch: an initialize that reads credential:"none" means the header never arrived.
    console.log(JSON.stringify({ event: 'mcp_auth', credential, ok: true }));
  } catch (err) {
    console.log(JSON.stringify({ event: 'mcp_auth', credential, ok: false }));
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unauthorized' }) };
  }

  let message: unknown;
  try {
    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    message = raw ? JSON.parse(raw) : null;
  } catch {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }

  const ctx: ToolContext = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(doc, { userId, method, args, google, stateSecret: process.env.ORIGIN_SECRET }, { presigner }),
    upload: uploadToPresigned,
  };

  const response = await handleMcpMessage(message, ctx);
  // A notification (no id) has no response body → 202 Accepted with an empty body.
  if (response === null) return { statusCode: 202, headers: HEADERS, body: '' };
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(response) };
}
