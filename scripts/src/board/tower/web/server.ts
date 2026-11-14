// The web tower's HTTP surface (docs/ops/TOWER.md): these read-only routes and nothing else.
//   GET /            the page          GET /app.js      its script
//   GET /icon.svg    its icon          GET /apple-touch-icon.png (and -precomposed, which iOS probes)  180 px
//   GET /api/state   the View as JSON  (?history=1 adds the chart series)
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon-precomposed.png': ['apple-touch-icon.png', 'image/png'],
};

export type GetState = (history: boolean) => unknown;

// Only a browser on this machine: the Host must be localhost or a loopback address (any port), so a page elsewhere
// can't reach the View through DNS rebinding.
const HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

// Pure of sockets: tests call it with stand-in req/res. The page and its script are read once, here: they must be
// the same commit as the View code in this process (/workspace moves at every kickoff, and nothing restarts the
// tower then), so an edit needs `board.sh tower restart`, and the page's version check then reloads it.
export function createHandler(getState: GetState, dir = HERE) {
  const files = Object.fromEntries(
    Object.entries(STATIC).map(([path, [name, type]]) => [
      path,
      [readFileSync(join(dir, name)), type] as const,
    ]),
  );
  return (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, type: string, body: string | Buffer) => {
      res.writeHead(code, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
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
    const file = files[url.pathname];
    if (file) return send(200, file[1], file[0]);
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
