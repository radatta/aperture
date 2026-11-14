import { execFileSync, spawnSync } from 'node:child_process';
import { get } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveTests, MAC_INSTALL, parseArgs, sparkBuckets } from './main.ts';
import { createHandler, serve } from './server.ts';

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
    expect(v.slipping.map((s: V) => s.kind)).toEqual(['followup', 'parked', 'quiet']);
    expect(v.health.mac.state).toBe('stale');
    expect(v.health.aws.total).toBeCloseTo(0.35);
    expect(v.sources.find((s: V) => s.name === 'Actions minutes').state).toBe('missing');
    expect(v.problems).toEqual([]);
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
  it('reads a stale or foreign pidfile as stopped (exit 1), never as running', () => {
    const board = join(import.meta.dirname, '../../../../board/board.sh');
    const pidFile = join(tmpdir(), `tower-pid-${process.pid}`);
    writeFileSync(pidFile, `${process.pid}\n`); // alive, but this vitest worker, not the tower
    const r = spawnSync('bash', [board, 'tower', 'status'], {
      encoding: 'utf8',
      env: { ...process.env, APERTURE_TOWER_PID: pidFile, APERTURE_BOARD_DIR: tmpdir() },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/tower: stopped/);
  });
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
    expect(doc).toContain(MAC_INSTALL);
  });
  it('the CSP forbids framing', async () => {
    const r = await fetch(`${base}/`);
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
