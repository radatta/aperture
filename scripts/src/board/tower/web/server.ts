// The web tower's HTTP surface (docs/ops/TOWER.md): three read-only routes and nothing else.
//   GET /            the page          GET /app.js      its script
//   GET /api/state   the View as JSON  (?history=1 adds the chart series)
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

export type GetState = (history: boolean) => unknown;

// Only a browser on this machine: the Host must be localhost or a loopback address (any port), so a page elsewhere
// can't reach the View through DNS rebinding.
const HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

// Pure of sockets: tests call it with stand-in req/res. Static files are read per request (a restart isn't
// needed to see an edit, and they're a few KB).
export function createHandler(getState: GetState, dir = HERE) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'GET only\n');
    if (!HOST.test(req.headers.host ?? '')) return send(403, 'text/plain', 'localhost only\n');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://tower');
    } catch {
      return send(400, 'text/plain', 'bad URL\n');
    }
    const file = STATIC[url.pathname];
    if (file) {
      try {
        return send(200, file[1], readFileSync(join(dir, file[0]), 'utf8'));
      } catch (e) {
        return send(500, 'text/plain', `tower: ${(e as Error).message}\n`);
      }
    }
    if (url.pathname === '/api/state') {
      try {
        return send(
          200,
          'application/json',
          JSON.stringify(getState(url.searchParams.get('history') === '1')),
        );
      } catch (e) {
        return send(500, 'application/json', JSON.stringify({ error: (e as Error).message }));
      }
    }
    return send(404, 'text/plain', 'not found\n');
  };
}

export function serve(
  handler: ReturnType<typeof createHandler>,
  bind: string,
  port: number,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer(handler);
    s.once('error', reject);
    s.listen(port, bind, () => resolve(s));
  });
}
