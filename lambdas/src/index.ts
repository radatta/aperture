// @aperture/lambdas — the RPC BFF handler. One Lambda, one route: POST /api/<method> → the matching
// ApiClient method over DynamoDB (single-table). Business logic lives in BackendClient (shared
// machines); this file is just the AWS/HTTP edge. Phase 11 replaces the fixed userId with the Cognito
// `sub`; Phase 12 provisions the table + wires TABLE_NAME.
import { APERTURE } from '@aperture/shared';
import { createLiveDoc } from './ddb/LiveDoc';
import { handleRpc } from './handler';

export const runtime = `${APERTURE}-lambda` as const;

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');

interface HttpEvent {
  rawPath?: string;
  requestContext?: { http?: { path?: string; method?: string } };
  body?: string | null;
}
interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const CORS: Record<string, string> = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'POST,OPTIONS',
};

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const path = event.rawPath ?? event.requestContext?.http?.path ?? '';
  if (event.requestContext?.http?.method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const method = path.split('/api/')[1]?.split('/')[0] ?? '';
  const body = event.body ? (JSON.parse(event.body) as { args?: unknown[]; testMode?: boolean }) : {};
  const userId = 'local'; // Phase 11: Cognito `sub` from the validated JWT

  try {
    const result = await handleRpc(doc, {
      userId,
      method,
      args: body.args ?? [],
      testMode: body.testMode,
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result ?? null) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'error';
    const status = message.startsWith('Unknown method') ? 404 : 400;
    return { statusCode: status, headers: CORS, body: JSON.stringify({ error: message }) };
  }
}
