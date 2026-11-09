// @aperture/lambdas — the MCP server edge. A SECOND Lambda (aperture-mcp-<stage>), separate from the BFF
// so the agent token's ceiling is this function's IAM. One route: POST /mcp with an MCP JSON-RPC body →
// a tool call dispatched through the SAME handleRpc the BFF uses. Auth is the static agent token in a
// custom header (Claude Code); phase 2 adds a Cognito-bearer path here for claude.ai. Business logic and
// the writes-discipline live in BackendClient/handleRpc — this file is just the AWS/HTTP + auth edge.
import { AGENT_TOKEN_HEADER, APERTURE, AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';
import type { ApiMethod } from '@aperture/shared';
import { createLiveDoc } from '../ddb/LiveDoc';
import { createCognitoVerifier, resolveAgentUserId, resolveUserId } from '../auth/verify';
import type { Verifier } from '../auth/verify';
import type { DocClient } from '../ddb/DocClient';
import type { GoogleGateway } from '../google/gateway';
import type { Presigner } from '../s3/presigner';
import type { ObjectStore } from '../s3/objects';
import type { AnthropicGateway } from '../anthropic/gateway';
import { handleRpc } from '../handler';
import { createLiveGoogle } from '../google/liveGoogle';
import { createS3Presigner } from '../s3/presigner';
import { createS3ObjectStore } from '../s3/objects';
import { noopPlaid } from '../plaid/gateway';
import { noopInvoker } from '../finance/invoker';
import { createLiveAnthropic } from '../anthropic/liveAnthropic';
import { handleMcpMessage } from './protocol';
import { authorizationServer, matchWellKnown, protectedResource } from './wellKnown';
import type { ToolContext } from './types';

export const runtime = `${APERTURE}-mcp` as const;

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');
// Built once at cold start; construction never touches the network (empty bucket/URL is fine locally).
const presigner = createS3Presigner(process.env.FILES_BUCKET ?? '');
const objects = createS3ObjectStore(process.env.FILES_BUCKET ?? ''); // deletes attachment bytes
const STAGE = process.env.STAGE ?? 'dev';
const APP_URL = process.env.APP_URL ?? '';
const google = createLiveGoogle({ stage: STAGE, appUrl: APP_URL });
// parse_task's model call (Raycast quick add) — the same gateway and SSM key as the BFF.
const anthropic = createLiveAnthropic({ stage: STAGE });

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
  'access-control-allow-methods': 'GET,POST,OPTIONS', // GET for the phase-2 well-known metadata
};

// Phase 2 (claude.ai). The MCP verifier IS client-bound (the claude app client id) — unlike the BFF's
// deliberately un-bound verifier — because that client has no CloudFront dependency, so binding it here
// forms no deploy cycle. Env is checked live each call (so an unconfigured stage 401s a bearer rather
// than falling through); only the verifier INSTANCE (its JWKS cache) is memoized across warm invokes.
let cachedMcpVerifier: Verifier | null = null;
function requireMcpVerifier(): Verifier {
  const poolId = process.env.USER_POOL_ID;
  const clientId = process.env.MCP_CLIENT_ID;
  // No 'local' fallback (unlike resolveAgentUserId): a public OAuth endpoint must never treat
  // "unconfigured" as "anyone is the local user". Unconfigured → the bearer is simply rejected.
  if (!poolId || !clientId)
    throw new Error('Unauthorized: bearer auth not configured on this stage');
  if (!cachedMcpVerifier) cachedMcpVerifier = createCognitoVerifier(poolId, clientId);
  return cachedMcpVerifier;
}

// RFC 9728 discovery pointer on a 401 (the path-suffixed form, since the resource is <APP_URL>/mcp). Only on
// a stage with the façade (APP_URL set). NB: a Lambda Function URL renames WWW-Authenticate on 401s to
// x-amzn-remapped-www-authenticate (AWS security behavior), so clients never see it under its real name;
// claude.ai falls back to probing the well-known paths, which we serve. Kept for spec-correctness.
function wwwAuthenticate(): Record<string, string> {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return {};
  return {
    'www-authenticate': `Bearer resource_metadata="${appUrl}/.well-known/oauth-protected-resource/mcp"`,
  };
}

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

// Everything the edge calls out to — the BFF's BffDeps, for this function. `mcpVerifier` stays a thunk so
// an unconfigured stage still 401s a bearer per call (requireMcpVerifier). The local devcheck server
// (local/serve.ts) builds one over InMemoryDoc and inert gateways.
export interface McpDeps {
  doc: DocClient;
  google: GoogleGateway;
  presigner: Presigner;
  objects: ObjectStore;
  anthropic: AnthropicGateway;
  mcpVerifier: () => Verifier;
  upload: ToolContext['upload'];
}
const live: McpDeps = {
  doc,
  google,
  presigner,
  objects,
  anthropic,
  mcpVerifier: requireMcpVerifier,
  upload: uploadToPresigned,
};

export const createMcpHandler =
  (d: McpDeps) =>
  (event: HttpEvent): Promise<HttpResult> =>
    handle(event, d);
export const handler = createMcpHandler(live);

async function handle(event: HttpEvent, d: McpDeps): Promise<HttpResult> {
  const httpMethod = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path ?? '';
  const isHttp = event.requestContext?.http !== undefined; // false for direct (CI-cred'd) invokes
  if (httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };

  // Origin lockdown (HTTP only): the Function URL is public, so only CloudFront-stamped requests are
  // honored. Direct invokes are AWS-cred-gated already. Same gate as the BFF. The well-known metadata
  // routes below sit BEHIND this gate too (their CloudFront behaviors share the origin-secret stamp).
  const originSecret = process.env.ORIGIN_SECRET;
  if (isHttp && originSecret && event.headers?.[ORIGIN_SECRET_HEADER] !== originSecret) {
    return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  // Phase 2 — OAuth metadata façade (public, GET/HEAD). Served BEFORE the POST-only gate so claude.ai's
  // discovery works; unauthenticated by design (metadata is public). Only a stage with the façade env
  // (APP_URL etc — i.e. a custom domain) can serve it; otherwise 404. `GET /mcp` is NOT a well-known
  // path, so it still falls through to the 405 below (the health check depends on that).
  const wk = matchWellKnown(path);
  if (wk) {
    if (httpMethod && httpMethod !== 'GET' && httpMethod !== 'HEAD') {
      return {
        statusCode: 405,
        headers: { ...HEADERS, allow: 'GET' },
        body: JSON.stringify({ error: 'Method Not Allowed' }),
      };
    }
    const appUrl = process.env.APP_URL;
    const cognitoDomain = process.env.COGNITO_DOMAIN;
    const userPoolId = process.env.USER_POOL_ID;
    if (!appUrl || !cognitoDomain || !userPoolId) {
      return {
        statusCode: 404,
        headers: HEADERS,
        body: JSON.stringify({ error: 'OAuth metadata not configured on this stage' }),
      };
    }
    const wkEnv = { appUrl, cognitoDomain, userPoolId };
    const metadata = wk === 'prm' ? protectedResource(wkEnv) : authorizationServer(wkEnv);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(metadata) };
  }

  if (httpMethod && httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...HEADERS, allow: 'POST' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  // Credential fork — disambiguate by CREDENTIAL, not method. The agent token (Claude Code, a raw custom
  // header, unscoped) is checked first and never falls through. A Cognito bearer (claude.ai, phase 2) is
  // verified against the client-bound MCP verifier. Neither present → 401 with the discovery pointer.
  const agentHeader = event.headers?.[AGENT_TOKEN_HEADER];
  const bearer =
    event.headers?.authorization ?? event.headers?.Authorization ?? event.headers?.[AUTH_HEADER];
  const credential = agentHeader !== undefined ? 'agent' : bearer ? 'bearer' : 'none';
  let userId: string;
  try {
    if (credential === 'agent') {
      userId = resolveAgentUserId(agentHeader, process.env.AGENT_TOKEN, process.env.DEVICE_USER_ID);
    } else if (credential === 'bearer') {
      userId = await resolveUserId(bearer, d.mcpVerifier());
    } else {
      throw new Error('Unauthorized: /mcp requires a credential');
    }
    // One structured line per auth outcome — this is how a dropped header (Claude Code bug history) is
    // diagnosed from CloudWatch: an initialize that reads credential:"none" means the header never arrived.
    console.log(JSON.stringify({ event: 'mcp_auth', credential, ok: true }));
  } catch (err) {
    console.log(JSON.stringify({ event: 'mcp_auth', credential, ok: false }));
    return {
      statusCode: 401,
      headers: { ...HEADERS, ...wwwAuthenticate() },
      body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unauthorized' }),
    };
  }

  let message: unknown;
  try {
    const raw =
      event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
    message = raw ? JSON.parse(raw) : null;
  } catch {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }),
    };
  }

  const ctx: ToolContext = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      // Plaid + the sync invoker are pinned inert: the MCP role has no Plaid IAM (cdk stacks.test "the
      // MCP function gets nothing Plaid"), and its finance tools read only what's in the table.
      handleRpc(
        d.doc,
        { userId, method, args, google: d.google, stateSecret: process.env.ORIGIN_SECRET },
        {
          presigner: d.presigner,
          objects: d.objects,
          plaid: noopPlaid(),
          financeInvoker: noopInvoker(),
          anthropic: d.anthropic,
        },
      ),
    upload: d.upload,
  };

  const response = await handleMcpMessage(message, ctx);
  // A notification (no id) has no response body → 202 Accepted with an empty body.
  if (response === null) return { statusCode: 202, headers: HEADERS, body: '' };
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(response) };
}
