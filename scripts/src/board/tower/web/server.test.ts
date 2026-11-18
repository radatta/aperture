import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, get } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAC_PLACEHOLDER } from '../../../mac-root.ts';
import { liveTests, macInstallLine, parseArgs, sparkBuckets } from './main.ts';
import { build, dayStart, writeDerived } from './main.ts';
import { createHandler, serve } from './server.ts';

const FIXTURES = join(import.meta.dirname, '../fixtures');
// Whether something answers HTTP on 127.0.0.1:<port> (the tower answers 400/403 to a bare GET; any status counts).
const up = (port: number) =>
  new Promise<boolean>((r) =>
    get({ host: '127.0.0.1', port, path: '/', headers: { host: 'localhost' } }, (res) => {
      res.resume();
      r(true);
    }).on('error', () => r(false)),
  );

let server: Server;
let base: string;
let calls: boolean[] = [];
let fail = false;

beforeAll(async () => {
  server = await serve(
    createHandler((history) => {
      calls.push(history);
      if (fail) throw new Error('boom');
      return history ? { v: 1, now: 1, history: [] } : { v: 1, now: 1 };
    }),
    '127.0.0.1',
    0,
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('the HTTP surface', () => {
  it('serves the page and its script, never cached', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await page.text()).toContain('NEEDS YOU');
    const js = await fetch(`${base}/app.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('serves the radar icons: a 180 px PNG at the paths iOS probes, a bolder SVG as the favicon', async () => {
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(page).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    for (const p of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      const png = Buffer.from(await r.arrayBuffer());
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]); // IHDR width, height
    }
    // Safari's tab skips the SVG icon: PNGs at 32 and 64 px, linked first, and /favicon.ico (both sizes) it falls back to
    for (const [p, px] of [
      ['/favicon-32.png', 32],
      ['/favicon-64.png', 64],
    ] as const) {
      expect(page).toContain(
        `<link rel="icon" type="image/png" sizes="${px}x${px}" href="${p}" />`,
      );
      const png = Buffer.from(await (await fetch(`${base}${p}`)).arrayBuffer());
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([px, px]);
    }
    expect(page.indexOf('/favicon-32.png')).toBeLessThan(page.indexOf('/favicon.svg'));
    const ico = await fetch(`${base}/favicon.ico`);
    expect(ico.status).toBe(200);
    expect(ico.headers.get('content-type')).toBe('image/x-icon');
    const icoBytes = Buffer.from(await ico.arrayBuffer());
    expect([icoBytes.readUInt16LE(2), icoBytes.readUInt16LE(4)]).toEqual([1, 2]); // an icon file, two images
    const svg = await fetch(`${base}/icon.svg`);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(await svg.text()).toMatch(/^<svg [^>]*viewBox="0 0 180 180"/);
    // the tab icon is its own, drawn on a 32 grid so its strokes survive 16 px; the Home Screen keeps icon.svg
    const fav = await fetch(`${base}/favicon.svg`);
    expect(fav.headers.get('content-type')).toBe('image/svg+xml');
    expect(await fav.text()).toMatch(/^<svg [^>]*viewBox="0 0 32 32"/);
  });

  it('the tab icon is the no-tile dial; ?favicon is ignored and the trial variants are gone', async () => {
    const plain = await (await fetch(`${base}/`)).text();
    for (const q of ['?favicon=a', '?favicon=b', '?favicon=__proto__'])
      expect(await (await fetch(`${base}/${q}`)).text(), q).toBe(plain);
    // the touch icon comes after the tab icons: Safari's tab must not settle on the opaque 180 px radar
    expect(plain.indexOf('apple-touch-icon')).toBeGreaterThan(plain.indexOf('/favicon.svg'));
    expect(plain).toContain('<link rel="icon" href="/favicon.ico" sizes="any" />');
    // no tile: Safari draws its light plate only behind a low-contrast one (TOWER.md → Phone)
    expect(await (await fetch(`${base}/favicon.svg`)).text()).not.toContain('<rect');
    for (const v of ['a', 'b'])
      for (const p of [
        `/favicon-${v}.svg`,
        `/favicon-${v}-32.png`,
        `/favicon-${v}-64.png`,
        `/favicon-${v}.ico`,
      ])
        expect((await fetch(`${base}${p}`)).status, p).toBe(404);
  });

  it('serves the Home Screen manifest, linked from the page: standalone, its own scope, the radar icons', async () => {
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const r = await fetch(`${base}/manifest.webmanifest`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/manifest+json');
    const m = (await r.json()) as Record<string, unknown>;
    expect(m).toMatchObject({ name: 'tower', start_url: '/', scope: '/', display: 'standalone' });
    for (const i of m.icons as { src: string }[])
      expect((await fetch(`${base}${i.src}`)).status, i.src).toBe(200);
  });

  it('/api/state is the View; ?history=1 asks for the series', async () => {
    calls = [];
    expect(await (await fetch(`${base}/api/state`)).json()).toEqual({ v: 1, now: 1 });
    await fetch(`${base}/api/state?history=1`);
    expect(calls).toEqual([false, true]);
  });

  it('anything else is 404; non-GET is 405; a failing view is a 500 with its message', async () => {
    for (const p of ['/../etc/passwd', '/index.html', '/server.ts', '/main.ts', '/api'])
      expect((await fetch(`${base}${p}`)).status).toBe(404);
    expect((await fetch(`${base}/api/state`, { method: 'POST' })).status).toBe(405);
    fail = true;
    const r = await fetch(`${base}/api/state`);
    fail = false;
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'boom' });
  });
});

describe('parseArgs', () => {
  it('defaults to 0.0.0.0:6183 and validates', () => {
    expect(parseArgs([])).toMatchObject({ port: 6183, bind: '0.0.0.0', gh: true, once: false });
    expect(parseArgs(['--port', '7000', '--bind', '127.0.0.1', '--no-gh', '--once'])).toMatchObject(
      {
        port: 7000,
        bind: '127.0.0.1',
        gh: false,
        once: true,
      },
    );
    expect(() => parseArgs(['--port', '99999'])).toThrow(/port/);
    expect(() => parseArgs(['--now', 'soon'])).toThrow(/ISO/);
    expect(() => parseArgs(['--wat'])).toThrow(/unknown flag/);
  });
});

type V = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('--once on the fixtures', () => {
  it('derives every panel from the recorded board', () => {
    const out = execFileSync(
      'node',
      [
        join(import.meta.dirname, 'main.ts'),
        '--fixtures',
        join(import.meta.dirname, '../fixtures'),
        '--now',
        '2026-11-08T06:10:00Z',
        '--once',
      ],
      { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } },
    );
    const v = JSON.parse(out) as V;
    expect(v.needs.map((n: V) => n.kind)).toEqual(['lane', 'todo', 'todo']);
    expect(v.needs[0].what).toBe('india-branch: admit the branch to dev');
    expect(v.slots.map((s: V) => `${s.slot}:${s.branch}`)).toEqual([
      'dev:bravo-branch',
      'devb:juliet-branch',
    ]);
    expect(v.slots[0].detail).toBe('devcheck running since 06:02');
    expect(v.next.merge.map((r: V) => r.label)).toEqual([
      'HOLD (dev: bravo-branch is testing, lock to 06:37)',
    ]);
    expect(v.active.find((r: V) => r.branch === 'hotel-branch').label).toBe('PR (checks running)');
    expect(v.done.map((d: V) => `${d.number} ${d.deploy}`)).toEqual(['40 deployed ✓']);
    // the landing order, alpha-branch dropped as merged
    expect(v.next.order.map((o: V) => o.branch)).toEqual([
      'charlie-branch',
      'hotel-branch',
      'echo-branch',
    ]);
    expect(v.slipping.map((s: V) => s.kind)).toEqual(['followup', 'parked', 'quiet']);
    expect(v.health.mac.state).toBe('stale');
    expect(v.health.aws.total).toBeCloseTo(0.35);
    expect(v.behind).toBeNull(); // fixtures never compare commits
    // fixtures/board/lanes/mike-branch.json is merged with no PR in the list: finished, so not in NOW
    expect(v.active.map((r: V) => r.branch)).not.toContain('mike-branch');
    // the context and main-sync fixtures are read (the fixed clock is their time, so both are fresh)
    expect(v.ctx.bad.map((e: V) => e.name)).toEqual(['hotel']);
    expect(v.ctx.warn.map((e: V) => e.name)).toEqual(['echo']);
    for (const name of ['context', 'main sync'])
      expect(v.sources.find((s: V) => s.name === name)?.state).toBe('ok');
    // fixtures/prs.json has a fork's open PR on echo-branch's name: no lane, slot or row picks it up
    expect(JSON.stringify(v)).not.toContain('/pull/43');
    // the Actions-minutes estimate is gone (public repo, free runners): no tile, no source row
    expect(v.health.actions).toBeUndefined();
    expect(v.sources.some((s: V) => /actions minutes/i.test(s.name))).toBe(false);
    expect(v.problems).toEqual([]);
    // the recorded board's queue.json contradicts what the tower derives (TOWER.md → Board freshness)
    expect(v.board.items.map((x: V) => `${x.kind} ${x.branch}`)).toEqual(
      expect.arrayContaining(['merge-order alpha-branch']),
    );
    expect(v.heads.slipping).toBe(
      String(3 + v.board.items.filter((x: V) => x.kind !== 'followup').length),
    );
    // A fresh node type-stripping the tower's graph: ~0.35 s alone, but its wall time is the container's contention
    // (F212: past 5 s in a full suite at 8.7 cores), as for this file's other spawned towers.
  }, 20_000);
});

describe('the derived files (board.line, stale.json)', () => {
  it('writes both by rename into the board dir, from a fixture view', () => {
    const t = build({ ...parseArgs(['--fixtures', FIXTURES, '--now', '2026-11-08T06:10:00Z']) });
    const dir = mkdtempSync(join(tmpdir(), 'derived-'));
    try {
      const v = t.view(false);
      writeDerived(dir, v);
      const line = readFileSync(join(dir, 'board.line'), 'utf8').split('\n');
      expect(line[0]).toMatch(/^\d+ (\d+|-) \d+\?? (dim|warn|bad)$/);
      // the slowdown's status line cut, with the view's own tone, and the container's cores
      expect(line).toContain(`slow ${v.health.slowdown.tone} ${v.health.slowdown.short}`);
      expect(line).toContain(`vm ${v.health.container!.cores}`);
      // the fixture's Mac read (load 3.21 2.75 2.4 over 12) is a row only while fresh
      const withMac = (state: 'ok' | 'stale') =>
        writeDerived(dir, { ...v, health: { ...v.health, mac: { ...v.health.mac, state } } });
      const macRow = () =>
        readFileSync(join(dir, 'board.line'), 'utf8')
          .split('\n')
          .filter((l) => l.startsWith('mac '));
      withMac('ok');
      expect(macRow()).toEqual(['mac 3 3 2 12']);
      withMac('stale');
      expect(macRow()).toEqual([]);
      const f = JSON.parse(readFileSync(join(dir, 'stale.json'), 'utf8')) as V;
      expect(f).toMatchObject({ v: 1, t: v.now, tone: v.board.tone });
      expect(f.items).toHaveLength(v.board.items.length);
      expect(
        execFileSync('ls', ['-A', dir], { encoding: 'utf8' }).split('\n').filter(Boolean),
      ).toEqual(['board.line', 'stale.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('conflicts (TOWER.md → Conflicts)', () => {
  it("the fixture view's lane rows carry overlap.json's conflicts", () => {
    const v = build({
      ...parseArgs(['--fixtures', FIXTURES, '--now', '2026-11-08T06:10:00Z']),
    }).view(false);
    const lane = (b: string) => v.active.find((r) => r.branch === b);
    expect(lane('bravo-branch')!.conflicts).toEqual({
      main: ['docs/index.md'],
      lanes: [
        { branch: 'charlie-branch', files: ['packages/core/src/a.ts', 'packages/core/src/b.ts'] },
      ],
      oldMin: null,
    });
    expect(lane('echo-branch')!.conflicts).toEqual({
      main: ['docs/ops/TOWER.md'],
      lanes: [],
      oldMin: null,
    });
    expect(lane('india-branch')!.conflicts).toBeNull();
    // the dev slot's holder carries its lane's conflicts; a free or unknown slot none
    const dev = v.slots.find((x) => x.slot === 'dev')!;
    expect(dev.branch).toBe('bravo-branch');
    expect(dev.conflicts).toEqual(lane('bravo-branch')!.conflicts);
    expect(v.slots.find((x) => x.slot === 'devb')!.conflicts).toBeNull();
    expect(v.needs.some((n) => /✗|conflict/.test(n.what))).toBe(false);
  });
});

describe('liveTests', () => {
  it('a missing leases dir is zero', () => {
    expect(liveTests('/nonexistent-board')).toBe(0);
  });
});

const raw = (path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    get({ host: u.hostname, port: u.port, path, headers: { host } }, (r) => {
      r.resume();
      resolve(r.statusCode ?? 0);
    }).on('error', reject);
  });

describe('round 1 server fixes', () => {
  it('a malformed URL is a 400, and the server keeps serving', async () => {
    expect(await raw('//[', 'localhost:6183')).toBe(400);
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
  });
  it('only a localhost or loopback Host is served (no DNS rebinding)', async () => {
    expect(await raw('/api/state', 'evil.example:6183')).toBe(403);
    expect(await raw('/api/state', 'localhost')).toBe(200);
    expect(await raw('/api/state', '127.0.0.1:6183')).toBe(200);
    expect(await raw('/api/state', '[::1]:6183')).toBe(200);
    expect(await raw('/api/state', 'localhost.evil.example')).toBe(403);
  });
});

describe('board.sh tower status', () => {
  const board = join(import.meta.dirname, '../../../../board/board.sh');
  const tower = (cmd: string, e: NodeJS.ProcessEnv) =>
    spawnSync('bash', [board, 'tower', cmd], {
      encoding: 'utf8',
      env: { ...process.env, APERTURE_BOARD_DIR: tmpdir(), ...e },
    });
  // A port nothing listens on, so the listener fallback can't find the real tower on 6183.
  const freePort = () =>
    new Promise<number>((r) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => r(p));
      });
    });

  it('reads a stale or foreign pidfile as stopped (exit 1), never as running', async () => {
    const pidFile = join(tmpdir(), `tower-pid-${process.pid}`);
    writeFileSync(pidFile, `${process.pid}\n`); // alive, but this vitest worker, not the tower
    const r = tower('status', {
      APERTURE_TOWER_PID: pidFile,
      APERTURE_TOWER_PORT: `${await freePort()}`,
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/tower: stopped/);
  });

  it('never claims a listener on its port that is not the tower', () => {
    const port = (server.address() as AddressInfo).port; // this vitest worker's own HTTP server
    const pidFile = join(tmpdir(), `tower-pid-none-${process.pid}`);
    rmSync(pidFile, { force: true });
    const r = tower('status', { APERTURE_TOWER_PID: pidFile, APERTURE_TOWER_PORT: `${port}` });
    expect(r.status).toBe(1);
    expect(existsSync(pidFile)).toBe(false);
  });

  // A tower on a free port: the board's own (a temp board, no GitHub) or a fixtures proof server.
  async function web(port: number, fixtures: boolean, extra: NodeJS.ProcessEnv = {}) {
    const board = mkdtempSync(join(tmpdir(), 'tower-board-'));
    const args = fixtures ? ['--fixtures', FIXTURES, '--now', '2026-11-08T06:10:00Z'] : [];
    const c = spawn(
      'bash',
      [
        join(import.meta.dirname, '../../../../board/tower-web.sh'),
        ...args,
        '--no-gh',
        '--port',
        `${port}`,
        '--bind',
        '127.0.0.1',
      ],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          APERTURE_BOARD_DIR: board,
          APERTURE_DEVLOCK_SOURCE: `file:${join(board, 'missing')}`, // its lock refresh never asks GitHub
          ...extra,
        },
      },
    );
    for (let i = 0; i < 100 && !(await up(port)); i++) await new Promise((r) => setTimeout(r, 100));
    return { c, board };
  }

  it('finds the server by its listener when the pidfile is gone, writes the pidfile back, and stops it', async () => {
    const port = await freePort();
    const pidFile = join(tmpdir(), `tower-pid-gone-${process.pid}`);
    rmSync(pidFile, { force: true });
    const { c, board } = await web(port, false); // started without APERTURE_TOWER_PID: no pidfile, as if /tmp was cleaned
    try {
      const e = { APERTURE_TOWER_PID: pidFile, APERTURE_TOWER_PORT: `${port}` };
      const r = tower('status', e);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(
        new RegExp(`tower: running \\(pid ${c.pid}\\) — http://localhost:${port}`),
      );
      expect(readFileSync(pidFile, 'utf8').trim()).toBe(`${c.pid}`);
      expect(tower('stop', e).stdout).toMatch(`tower: stopped ${c.pid}`);
      expect(tower('status', e).status).toBe(1);
    } finally {
      c.kill();
      rmSync(pidFile, { force: true });
      rmSync(board, { recursive: true, force: true });
    }
  }, 20_000);

  it('records the commit it serves beside the pidfile: tower version prints it, stop removes it', async () => {
    const port = await freePort();
    const pidFile = join(tmpdir(), `tower-pid-sha-${process.pid}`);
    rmSync(pidFile, { force: true });
    const e = { APERTURE_TOWER_PID: pidFile, APERTURE_TOWER_PORT: `${port}` };
    const { c, board } = await web(port, false, { APERTURE_TOWER_PID: pidFile });
    try {
      for (let i = 0; i < 50 && !existsSync(pidFile); i++)
        await new Promise((r) => setTimeout(r, 100));
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const r = tower('version', e);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(head);
      expect(readFileSync(`${pidFile}.sha`, 'utf8')).toBe(`${c.pid} ${head}\n`);
      // a .sha left by another server (a stale one) is unknown: empty, so sync-main restarts
      writeFileSync(`${pidFile}.sha`, `1 ${head}\n`);
      expect(tower('version', e).stdout).toBe('');
      // none at all (main's older server, or /tmp cleaned while it ran): empty too, exit 0, nothing on stderr
      rmSync(`${pidFile}.sha`);
      const none = tower('version', e);
      expect([none.status, none.stdout, none.stderr]).toEqual([0, '', '']);
      tower('stop', e);
      expect(existsSync(`${pidFile}.sha`)).toBe(false);
      expect(tower('version', e).status).toBe(1); // stopped
    } finally {
      c.kill();
      rmSync(pidFile, { force: true });
      rmSync(`${pidFile}.sha`, { force: true });
      rmSync(board, { recursive: true, force: true });
    }
  }, 20_000);

  it("restart exits with start's status: a tower that fails to come up is a failed restart", () => {
    const port = (server.address() as AddressInfo).port; // held by this worker: the new tower can't bind it
    const pidFile = join(tmpdir(), `tower-pid-restart-${process.pid}`);
    rmSync(pidFile, { force: true });
    const board = mkdtempSync(join(tmpdir(), 'tower-board-')); // start writes its dirs and log here, not in /tmp
    try {
      const r = tower('restart', {
        APERTURE_TOWER_PID: pidFile,
        APERTURE_TOWER_PORT: `${port}`,
        APERTURE_BOARD_DIR: board,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/did not start/);
    } finally {
      rmSync(board, { recursive: true, force: true });
    }
  }, 20_000);

  it('never claims a proof server (--fixtures) on its port: another session owns it', async () => {
    const port = await freePort();
    const pidFile = join(tmpdir(), `tower-pid-proof-${process.pid}`);
    rmSync(pidFile, { force: true });
    const { c, board } = await web(port, true);
    try {
      const e = { APERTURE_TOWER_PID: pidFile, APERTURE_TOWER_PORT: `${port}` };
      expect(tower('status', e).status).toBe(1);
      expect(existsSync(pidFile)).toBe(false);
      tower('stop', e);
      expect(await up(port)).toBe(true); // still serving
    } finally {
      c.kill();
      rmSync(board, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('sparkBuckets', () => {
  it('one point a minute for the last hour, the minute’s peak, null for an empty minute', () => {
    const now = 3_600_000 * 10;
    const b = sparkBuckets(
      [
        [now - 30_000, 5],
        [now - 10_000, 7],
        [now - 59 * 60_000 - 1, 1],
        [now - 61 * 60_000, 9],
        [now - 120_000, null],
      ],
      now,
    );
    expect(b).toHaveLength(60);
    expect(b[59]).toBe(7);
    expect(b[0]).toBe(1);
    expect(b[57]).toBeNull();
    expect(b.filter((x) => x !== null)).toEqual([1, 7]);
  });
  it('a sample a little ahead of our clock lands in the newest minute', () => {
    expect(sparkBuckets([[1_000_000 + 5_000, 3]], 1_000_000)[59]).toBe(3);
  });
});

describe('round 4', () => {
  it("the page's Mac install line is TOWER.md's, word for word", () => {
    const doc = readFileSync(join(import.meta.dirname, '../../../../../docs/ops/TOWER.md'), 'utf8');
    expect(doc).toContain(macInstallLine(MAC_PLACEHOLDER)); // the doc says <mac-repo>; the page, .local/mac-root's
  });
  it('the CSP forbids framing', async () => {
    const r = await fetch(`${base}/`);
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('the day boundary and the Mac series (2026-11-14)', () => {
  it('DONE TODAY begins at local midnight, reaching back 12 h before noon', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 14, h, m).getTime();
    expect(dayStart(at(0, 10))).toBe(at(0, 10) - 12 * 3600e3); // last night's 23:00 merges stay in view
    expect(dayStart(at(11, 59))).toBe(at(11, 59) - 12 * 3600e3);
    expect(dayStart(at(12))).toBe(at(0));
    expect(dayStart(at(23, 30))).toBe(at(0));
  });

  it("the Mac series grows on the server's tick, whether or not a page polls", () => {
    const fx = mkdtempSync(join(tmpdir(), 'tower-mac-'));
    cpSync(FIXTURES, fx, { recursive: true });
    const stats = JSON.parse(readFileSync(join(fx, 'board/mac-stats.json'), 'utf8'));
    const t0 = Date.parse('2026-11-08T06:08:00Z');
    const t = build({
      port: 0,
      bind: '127.0.0.1',
      fixtures: fx,
      now: t0 + 75000,
      gh: false,
      once: true,
    });
    try {
      for (let k = 0; k < 5; k++) {
        const now = t0 + k * 15000;
        writeFileSync(
          join(fx, 'board/mac-stats.json'),
          JSON.stringify({ ...stats, t: new Date(now).toISOString() }),
        );
        t.sample(now);
        t.sample(now); // the same file read twice is one point
      }
      const v = t.view(true) as V;
      expect(v.history.mac).toHaveLength(5);
    } finally {
      rmSync(fx, { recursive: true, force: true });
    }
  });
});

describe('behind main (the served commit vs the checkout)', () => {
  it('reaches the View on each request, from the check build was given', () => {
    let calls = 0;
    const t = build(
      {
        port: 0,
        bind: '127.0.0.1',
        fixtures: FIXTURES,
        now: Date.parse('2026-11-08T06:10:00Z'),
        gh: false,
        once: true,
      },
      { behind: () => (calls++, { head: 'b'.repeat(40), files: 2 }) },
    );
    expect(t.view(false).behind).toEqual({ head: 'b'.repeat(40), files: 2 });
    t.view(false);
    expect(calls).toBe(2); // asked per request: no timer
  });
});
