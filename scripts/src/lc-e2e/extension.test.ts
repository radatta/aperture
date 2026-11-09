// The extension end to end, in the container: the real extension (chrome-build.ts) in headless Chromium, on
// a fake LeetCode page (extension/test/fixtures) served at leetcode.com by a route, sending to A1's real BFF
// running locally (the local check's server) as the test user. What it can't prove: Safari, and LeetCode's real
// DOM — those are the lc-extension scenario's Needs-you rows. Skips when ~/pw has no Playwright (CI).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPlaywright } from '../devcheck/browser';
import { startLocalServer, type Proc } from '../devcheck/local/server';
import { LOCAL_APP_CLIENT, LOCAL_CLAUDE_CLIENT, LOCAL_POOL_ID, LOCAL_SUB, makeLocalAuth } from '../devcheck/local/target';
import type { PwContext, PwPage, PwWorker } from '../devcheck/pw-types';
import { chromeBuild } from './chrome-build';

const worktree = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixtures = join(worktree, 'extension', 'test', 'fixtures');
const playwrightAvailable = existsSync(join(homedir(), 'pw', 'node_modules', 'playwright'));
const AUTH_HEADER = 'x-aperture-authorization';
const SELECTORS = {
  editorReset: '[data-fake=reset]',
  resetConfirm: '[data-fake=confirm]',
  timerClicks: ['[data-fake=timer-reset]', '[data-fake=timer-start]'],
};

type Sitting = { id: string; status: string; problemSlug: string; summary: { submits: number; runs: number; firstSubmit: { verdict: string } | null } };
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe.skipIf(!playwrightAvailable)('the extension, end to end against the local BFF', () => {
  const procs: Proc[] = [];
  const temps: string[] = [];
  let context: PwContext;
  let worker: PwWorker;
  let rpc: <T>(method: string, ...args: unknown[]) => Promise<T>;
  let page: PwPage;
  const phase = () => page.locator('aperture-lc-overlay').getAttribute('data-phase');

  beforeAll(async () => {
    const auth = makeLocalAuth();
    const logs = mkdtempSync(join(tmpdir(), 'aperture-lc-e2e-'));
    temps.push(logs);
    const deviceToken = randomBytes(32).toString('hex');
    const server = await startLocalServer({
      worktree,
      track: (p) => procs.push(p),
      logPath: join(logs, 'server.log'),
      env: {
        ORIGIN_SECRET: auth.originSecret,
        APP_URL: 'http://127.0.0.1:9',
        LOCAL_POOL_ID,
        LOCAL_CLAUDE_CLIENT_ID: LOCAL_CLAUDE_CLIENT,
        LOCAL_JWKS: JSON.stringify(auth.jwks),
        AGENT_TOKEN: randomBytes(32).toString('hex'),
        DEVICE_TOKEN: deviceToken,
        DEVICE_USER_ID: LOCAL_SUB, // the device token writes as the test user, whose JWT reads it back
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const jwt = auth.mint(LOCAL_APP_CLIENT).token;
    rpc = async <T>(method: string, ...args: unknown[]) => {
      const res = await fetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${jwt}` },
        body: JSON.stringify({ args }),
      });
      const body = (await res.json()) as T & { error?: string };
      if (!res.ok) throw new Error(`${method}: ${res.status} ${body.error}`);
      return body;
    };
    const roll = await rpc<{ id: string }>('upsertRoll', { name: 'LeetCode', categoryId: null, estimateMin: 45 });
    await rpc('updateSettings', { leetcodeRollId: roll.id });

    const ext = chromeBuild(join(worktree, 'extension'));
    const profile = mkdtempSync(join(tmpdir(), 'aperture-lc-profile-'));
    temps.push(ext, profile);
    const pw = loadPlaywright();
    context = await pw.chromium.launchPersistentContext!(profile, {
      headless: true,
      channel: 'chromium', // the full browser's headless mode; the headless shell loads no extensions
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox', '--disable-dev-shm-usage'],
    });
    worker = context.serviceWorkers!()[0] ?? (await context.waitForEvent!('serviceworker', { timeout: 10_000 }));
    await worker.evaluate(
      `chrome.storage.local.set(${JSON.stringify({ apiOrigin: origin, deviceToken, selectors: SELECTORS, debug: true })})`,
    );

    const lc = createRequire(import.meta.url)(join(fixtures, 'fake-leetcode-server.js')).createServer();
    const html = readFileSync(join(fixtures, 'fake-leetcode.html'), 'utf8');
    const pageJs = readFileSync(join(fixtures, 'fake-leetcode.js'), 'utf8');
    await context.route!(
      (u) => u.hostname === 'leetcode.com',
      async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === 'GET' && /^\/problems\/[^/]+\//.test(url.pathname) && !url.pathname.includes('/submit'))
          return route.fulfill({ status: 200, body: html, headers: { 'content-type': 'text/html' } });
        if (url.pathname === '/fake-leetcode.js')
          return route.fulfill({ status: 200, body: pageJs, headers: { 'content-type': 'text/javascript' } });
        const r = lc.respond(url.pathname, req.method(), req.postData());
        return route.fulfill(r ? { ...r, headers: { 'content-type': 'application/json' } } : { status: 404, body: '{}' });
      },
    );
    page = await context.newPage();
  }, 90_000);

  afterAll(async () => {
    await context?.close();
    for (const p of procs) await p.stop();
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  });

  it('Start resets the editor, starts the timer and opens a sitting; a submit lands with its verdict', async () => {
    await page.goto('https://leetcode.com/problems/two-sum/description/');
    await until(async () => (await phase()) === 'prompt');
    await page.locator('aperture-lc-overlay [data-ap=start]').click();
    await until(async () => (await phase()) === 'active');
    expect(await page.evaluate<{ resets: number; timerStarts: number }>('window.__fake')).toMatchObject({ resets: 1, timerStarts: 1 });

    await page.locator('[data-fake=code]').fill('class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]\n');
    await page.locator('[data-e2e-locator=console-submit-button]').click();
    await page.locator('[data-e2e-locator=console-run-button]').click();

    await new Promise((r) => setTimeout(r, 8000));
    {
      const s = await rpc<Sitting[]>('listSittings');
      const d = s[0] ? await rpc<{ live: unknown; events: Array<{ type: string }> }>('getSitting', s[0].id) : null;
      const st = await worker.evaluate<unknown>('chrome.storage.local.get(["status","outbox"]).then((g) => JSON.stringify({status: g.status, n: g.outbox && g.outbox.entries.length, e: g.outbox && g.outbox.entries.map((x) => [x.state, x.lastStatus, x.lastError, x.events.map((v) => v.type)])}))');
      console.log('DBG', JSON.stringify(s.map((x) => x.summary)), JSON.stringify(d && d.events.map((e) => e.type)), st);
      console.log('LOG', await worker.evaluate<string>('chrome.storage.local.get("debugLog").then((g) => JSON.stringify((g.debugLog || []).filter((e) => !["click","storage","sample","dom.dialog","controls"].includes(e.type))))'));
    }
    const [head] = await until(async () => {
      const s = await rpc<Sitting[]>('listSittings');
      return s.length && s[0]!.summary.submits === 1 && s[0]!.summary.runs === 1 ? s : null;
    }, 20_000);
    expect(head).toMatchObject({ problemSlug: 'two-sum', status: 'active', summary: { firstSubmit: { verdict: 'accepted' } } });
    await new Promise((r) => setTimeout(r, 6000));
    const dbg = await rpc<{ live: unknown; problem: unknown; events: Array<{ type: string }> }>('getSitting', head!.id);
    console.log('DBG', JSON.stringify({ live: dbg.live, problem: !!dbg.problem, events: dbg.events.map((e) => e.type) }));
    const detail = await until(async () => {
      const d = await rpc<{ live: { code: string } | null; problem: unknown }>('getSitting', head!.id);
      return d.live?.code?.includes('return [0, 1]') && d.problem ? d : null;
    }, 20_000);
    expect(detail.problem).toBeTruthy(); // late-filled from LeetCode's questionDetail after the submit
    const replay = await until(async () => {
      const r = await rpc<unknown[]>('listSittingReplay', head!.id);
      return r.length ? r : null;
    });
    expect(replay.length).toBeGreaterThan(0);
    expect(await page.locator('aperture-lc-badge [data-ap=badge]').textContent()).toMatch(/^Aperture · \dm · /);
  }, 60_000);

  it('resumes a reload mid-sitting with no overlay and no reset, and re-prompts on SPA navigation where a second Start is refused', async () => {
    const before = await rpc<Sitting[]>('listSittings');
    await page.reload();
    await until(async () => (await phase()) === 'active');
    expect(await page.evaluate<{ resets: number }>('window.__fake')).toMatchObject({ resets: 0 });
    const after = await rpc<Sitting[]>('listSittings');
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));

    await page.locator('[data-fake=next]').click();
    await until(async () => (await phase()) === 'prompt');
    await page.locator('aperture-lc-overlay [data-ap=start]').click();
    await until(async () => (await phase()) === 'failed');
    expect(await page.locator('aperture-lc-overlay [data-ap=reason]').textContent()).toContain('Another sitting is still open');
    expect((await rpc<Sitting[]>('listSittings')).length).toBe(before.length);
  }, 60_000);
});
