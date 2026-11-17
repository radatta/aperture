// The web tower's HTTP surface (docs/ops/TOWER.md): these read-only routes and nothing else.
//   GET /            the page          GET /app.js      its script
//   GET /icon.svg    its icon          GET /apple-touch-icon.png (and -precomposed, which iOS probes)  180 px
//   GET /favicon.svg, /favicon-32.png, /favicon-64.png, /favicon.ico (both sizes)  the tab icon, bolder for 16 px;
//     Safari skips the SVG one. /favicon-a…, /favicon-b… the same four of two trial variants (a: no tile, b: a light
//     tile), which `/?favicon=a|b` links instead: Safari draws a plate behind a low-contrast tab icon (TOWER.md)
//   GET /manifest.webmanifest  the Home Screen app's manifest
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
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/apple-touch-icon-precomposed.png': ['apple-touch-icon.png', 'image/png'],
  '/favicon-32.png': ['favicon-32.png', 'image/png'],
  '/favicon-64.png': ['favicon-64.png', 'image/png'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
  // a manifest with display standalone: iOS 26 opens a Home Screen site without one in a mode the page's
  // display-mode query may not match (TOWER.md → Phone)
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};
const VARIANTS = ['a', 'b'] as const;
for (const v of VARIANTS)
  Object.assign(STATIC, {
    [`/favicon-${v}.svg`]: [`favicon-${v}.svg`, 'image/svg+xml'],
    [`/favicon-${v}-32.png`]: [`favicon-${v}-32.png`, 'image/png'],
    [`/favicon-${v}-64.png`]: [`favicon-${v}-64.png`, 'image/png'],
    [`/favicon-${v}.ico`]: [`favicon-${v}.ico`, 'image/x-icon'],
  });

// The page linking variant `v`'s tab icons, plus its .ico (the default page leans on Safari's /favicon.ico probe).
// The links are read by the browser as the page parses, and the CSP allows no inline script: so a page per variant.
function withFavicon(page: string, v: string): string {
  let out = page;
  for (const [from, to] of [
    ['href="/favicon-32.png"', `href="/favicon-${v}-32.png"`],
    ['href="/favicon-64.png"', `href="/favicon-${v}-64.png"`],
    [
      '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
      `<link rel="icon" href="/favicon-${v}.svg" type="image/svg+xml" />\n    <link rel="icon" href="/favicon-${v}.ico" sizes="any" />`,
    ],
  ]) {
    if (!out.includes(from!)) throw new Error(`index.html: no ${from} to swap for favicon ${v}`);
    out = out.replace(from!, to!);
  }
  return out;
}

export type GetState = (history: boolean) => unknown;

// Only a browser on this machine: the Host must be localhost or a loopback address (any port), so a page elsewhere
// can't reach the View through DNS rebinding.
const HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

// Pure of sockets: tests call it with stand-in req/res. The page and its script are read once, here: they must be
// the same commit as the View code in this process (/workspace moves at every kickoff, and nothing restarts the
// tower then: the page says "behind main"), so an edit needs `pnpm board sync-main` (or `board.sh tower restart`),
// and the page's version check then reloads it.
export function createHandler(getState: GetState, dir = HERE) {
  const files = Object.fromEntries(
    Object.entries(STATIC).map(([path, [name, type]]) => [
      path,
      [readFileSync(join(dir, name)), type] as const,
    ]),
  );
  const page = files['/']![0].toString('utf8');
  const pages = Object.fromEntries(VARIANTS.map((v) => [v, Buffer.from(withFavicon(page, v))]));
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
    const q = url.searchParams.get('favicon') ?? '';
    // own keys only: `__proto__` or `constructor` must never reach res.end
    const variant = url.pathname === '/' && Object.hasOwn(pages, q) ? pages[q] : undefined;
    if (variant) return send(200, file![1], variant);
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
