// A CloudFront stand-in for the local devcheck server: it turns a Node request into the Function URL event
// the edges read, forwarding only what the deployed distribution forwards (cdk/src/lib/app-stack.ts →
// ApiOriginPolicy, McpOriginPolicy, McpCachePolicy) and stamping the origin secret. A header the app starts
// relying on that CloudFront would strip fails here too. edge.test.ts reads app-stack.ts and fails on drift.
// Like the distribution's errorResponses, a Lambda's 403/404 reaches the browser as index.html with a 200.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AGENT_TOKEN_HEADER, AUTH_HEADER, ORIGIN_SECRET_HEADER } from '@aperture/shared';

export const API_HEADERS = [AUTH_HEADER, 'content-type'];
export const API_QUERY = ['code', 'state', 'error'];
export const MCP_HEADERS = [
  AGENT_TOKEN_HEADER,
  'content-type',
  'accept',
  'mcp-protocol-version',
  'authorization',
];
// The façade behaviors (app-stack.ts wellKnownBehavior): the first two are `*` patterns, the last exact.
export const WELL_KNOWN = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
];

export interface EdgeEvent {
  rawPath: string;
  requestContext: { http: { path: string; method: string } };
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body: string | null;
  isBase64Encoded: false;
}
export interface EdgeResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
type Fn = (event: EdgeEvent) => Promise<EdgeResult>;

export type Route = 'api' | 'mcp' | 'well-known';
export function routeOf(path: string): Route | null {
  if (path.startsWith('/api/')) return 'api';
  if (path === '/mcp') return 'mcp';
  // Only the façade behaviors — never all of /.well-known.
  if (path === WELL_KNOWN[2]) return 'well-known';
  if (WELL_KNOWN.slice(0, 2).some((p) => path.startsWith(p))) return 'well-known';
  return null;
}

// Node lowercases header names already; a repeated header arrives as an array and is joined like a Function URL.
export function toEvent(
  route: Route,
  method: string,
  url: URL,
  headers: IncomingMessage['headers'],
  body: string,
  originSecret: string,
): EdgeEvent {
  const allow = route === 'api' ? API_HEADERS : route === 'mcp' ? MCP_HEADERS : [];
  const out: Record<string, string> = {};
  for (const name of allow) {
    const v = headers[name];
    if (v !== undefined) out[name] = Array.isArray(v) ? v.join(',') : v;
  }
  out[ORIGIN_SECRET_HEADER] = originSecret; // CloudFront overwrites any viewer-sent value
  const query: Record<string, string> = {};
  if (route === 'api')
    for (const k of API_QUERY) {
      const v = url.searchParams.get(k);
      if (v !== null) query[k] = v;
    }
  return {
    rawPath: url.pathname,
    requestContext: { http: { path: url.pathname, method } },
    headers: out,
    ...(Object.keys(query).length ? { queryStringParameters: query } : {}),
    body: body || null,
    isBase64Encoded: false,
  };
}

export function createEdge(
  fns: { bff: Fn; mcp: Fn },
  originSecret: string,
  errorPage: () => Promise<string> = async () => '<!doctype html>',
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://local');
    const route = routeOf(url.pathname);
    if (!route) {
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end('{"error":"not an edge path"}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const event = toEvent(
      route,
      req.method ?? 'GET',
      url,
      req.headers,
      Buffer.concat(chunks).toString('utf8'),
      originSecret,
    );
    try {
      const out = await (route === 'api' ? fns.bff : fns.mcp)(event);
      if (out.statusCode === 403 || out.statusCode === 404)
        res.writeHead(200, { 'content-type': 'text/html' }).end(await errorPage());
      else res.writeHead(out.statusCode, out.headers).end(out.body);
    } catch (err) {
      // A Lambda that throws is a 502 at CloudFront — never the app's index.html.
      console.error(err);
      res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"handler threw"}');
    }
  };
}
