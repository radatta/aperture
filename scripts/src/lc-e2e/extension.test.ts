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
import {
  LOCAL_APP_CLIENT,
  LOCAL_CLAUDE_CLIENT,
  LOCAL_POOL_ID,
  LOCAL_SUB,
  makeLocalAuth,
} from '../devcheck/local/target';
import type { PwContext, PwPage, PwWorker } from '../devcheck/pw-types';
import { chromeBuild } from './chrome-build';

const worktree = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixtures = join(worktree, 'extension', 'test', 'fixtures');
const playwrightAvailable = existsSync(join(homedir(), 'pw', 'node_modules', 'playwright'));
const AUTH_HEADER = 'x-aperture-authorization';

type Sitting = {
  id: string;
  status: string;
  problemSlug: string;
  summary: {
    submits: number;
    runs: number;
    firstSubmit: { verdict: string } | null;
    coach?: { config: Record<string, boolean> | null; trace: string | null; nudges: number };
  };
};
const until = async <T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
): Promise<T> => {
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
  let tabId = 0;
  // The overlay's roots are closed: read them in the extension's isolated world (chrome-build.ts).
  const inIsolated = <T>(func: string, args: unknown[] = []) =>
    worker.evaluate<T>(
      `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'ISOLATED', func: ${func}, args: ${JSON.stringify(args)} }).then((r) => r[0] && r[0].result)`,
    );
  const ROOT = `(sel) => globalThis.__apertureTestRoots && globalThis.__apertureTestRoots(document.querySelector(sel))`;
  const phase = () =>
    inIsolated<string | null>(
      `() => { const r = (${ROOT})('aperture-lc-overlay'); const p = r && r.querySelector('[data-phase]'); return p ? p.getAttribute('data-phase') : null; }`,
    );
  const textOf = (host: string, sel: string) =>
    inIsolated<string | null>(
      `(host, sel) => { const r = (${ROOT})(host); const el = r && r.querySelector(sel); return el ? el.textContent : null; }`,
      [host, sel],
    );
  // A trusted click at the button's centre, as a user's — the overlay's, or the badge host's pill.
  const click = async (ap: string, host = 'aperture-lc-overlay') => {
    const at = await inIsolated<{ x: number; y: number } | null>(
      `(ap, host) => { const r = (${ROOT})(host); const b = r && r.querySelector('[data-ap=' + ap + ']'); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; }`,
      [ap, host],
    );
    if (!at) throw new Error(`no ${ap} button`);
    await page.mouse!.click(at.x, at.y);
  };

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
    const roll = await rpc<{ id: string }>('upsertRoll', {
      name: 'LeetCode',
      categoryId: null,
      estimateMin: 45,
    });
    await rpc('updateSettings', { leetcodeRollId: roll.id });

    const ext = chromeBuild(join(worktree, 'extension'));
    const profile = mkdtempSync(join(tmpdir(), 'aperture-lc-profile-'));
    temps.push(ext, profile);
    const pw = loadPlaywright();
    context = await pw.chromium.launchPersistentContext!(profile, {
      headless: true,
      channel: 'chromium', // the full browser's headless mode; the headless shell loads no extensions
      args: [
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    worker =
      context.serviceWorkers!()[0] ??
      (await context.waitForEvent!('serviceworker', { timeout: 10_000 }));
    await worker.evaluate(
      `chrome.storage.local.set(${JSON.stringify({ apiOrigin: origin, deviceToken })})`,
    );

    const lc = createRequire(import.meta.url)(
      join(fixtures, 'fake-leetcode-server.js'),
    ).createServer();
    const html = readFileSync(join(fixtures, 'fake-leetcode.html'), 'utf8');
    const pageJs = readFileSync(join(fixtures, 'fake-leetcode.js'), 'utf8');
    await context.route!(
      (u) => u.hostname === 'leetcode.com',
      async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (
          req.method() === 'GET' &&
          /^\/problems\/[^/]+\//.test(url.pathname) &&
          !url.pathname.includes('/submit')
        )
          return route.fulfill({
            status: 200,
            body: html,
            headers: { 'content-type': 'text/html' },
          });
        if (url.pathname === '/fake-leetcode.js')
          return route.fulfill({
            status: 200,
            body: pageJs,
            headers: { 'content-type': 'text/javascript' },
          });
        const r = lc.respond(url.pathname, req.method(), req.postData());
        return route.fulfill(
          r
            ? { ...r, headers: { 'content-type': 'application/json' } }
            : { status: 404, body: '{}' },
        );
      },
    );
    page = await context.newPage();
  }, 90_000);

  afterAll(async () => {
    await context?.close();
    for (const p of procs) await p.stop();
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  });

  it('Start resets the editor, starts the timer and opens a sitting; the first Submit goes straight through, no trace card; a submit lands with its verdict', async () => {
    await page.goto('https://leetcode.com/problems/two-sum/description/');
    // A countdown left paused, as the debug log recorded one: Start resets it, then starts it again.
    await page.evaluate(
      `window.__fake.setTimer(${JSON.stringify({ mode: 'reverse', startTimestamp: null, pauseMs: 6550, endMs: 3600000, lastUsedEndMs: 3600000, status: 'pause', isUserPaused: true, alertMinute: 10 })})`,
    );
    tabId = await worker.evaluate<number>(
      "chrome.tabs.query({ url: 'https://leetcode.com/*' }).then((t) => t[0].id)",
    );
    await until(async () => (await phase()) === 'prompt');
    await click('start');
    await until(async () => (await phase()) === 'active');
    // On the shipped selectors, in Chrome's own CSS engine.
    expect(await page.evaluate<Record<string, number>>('window.__fake')).toMatchObject({
      resets: 1,
      timerResets: 1,
      timerStarts: 1,
      strays: 0,
    });
    expect(
      await page.evaluate<{ mode: string; status: string }>(
        "JSON.parse(localStorage.getItem('QD_TIMER_STATE'))",
      ),
    ).toMatchObject({ mode: 'reverse', status: 'running' });

    await page
      .locator('[data-fake=code]')
      .fill('class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]\n');
    // LeetCode's autosave (300 ms debounce in the fake) lands first; the Submit then carries that pending
    // snapshot ahead of it. Code typed inside the debounce reaches live within the 30 s snapshot window.
    await until(async () => (await page.evaluate<{ syncs: number }>('window.__fake')).syncs >= 2);
    await new Promise((r) => setTimeout(r, 200)); // the relay's hand-off
    // The first real Submit goes straight to LeetCode: the trace card is retired (2.2.0), nothing is held.
    await page.locator('[data-e2e-locator=console-submit-button]').click();
    await page.locator('[data-e2e-locator=console-run-button]').click();

    const [head] = await until(async () => {
      const s = await rpc<Sitting[]>('listSittings');
      return s.length && s[0]!.summary.submits === 1 && s[0]!.summary.runs === 1 ? s : null;
    }, 20_000);
    expect(head).toMatchObject({
      problemSlug: 'two-sum',
      status: 'active',
      // The real background stamped its manifest's build on the Start, and A1 kept it.
      extensionVersion: (
        JSON.parse(readFileSync(new URL('../../../extension/manifest.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version,
      summary: { firstSubmit: { verdict: 'accepted' } },
    });
    expect(await page.evaluate<boolean>("!!document.querySelector('aperture-lc-coach')")).toBe(false); // no card host at all
    // The coach's config landed and folded: the card and its hold off, the note on. Whether the sitting was
    // traced is the server's call from the code, not the extension's.
    const coached = await until(async () => {
      const [s] = await rpc<Sitting[]>('listSittings');
      return s?.summary.coach?.config ? s : null;
    });
    expect(coached.summary.coach).toMatchObject({
      config: { trace: false, hold: false, nudge: true },
      nudges: 0,
    });
    expect(coached.summary.coach?.trace).not.toBe('traced');
    const detail = await until(async () => {
      const d = await rpc<{ live: { code: string } | null; problem: unknown }>(
        'getSitting',
        head!.id,
      );
      return d.live?.code?.includes('return [0, 1]') && d.problem ? d : null;
    }, 20_000);
    expect(detail.problem).toBeTruthy(); // late-filled from LeetCode's questionDetail after the submit
    const replay = await until(async () => {
      const r = await rpc<unknown[]>('listSittingReplay', head!.id);
      return r.length ? r : null;
    });
    expect(replay.length).toBeGreaterThan(0);
    expect(await textOf('aperture-lc-badge', '[data-ap=badge]')).toMatch(/^Aperture · \dm · /);
  }, 60_000);

  it('resumes a reload mid-sitting with no overlay and no reset, Submit passes, and re-prompts on SPA navigation where a second Start is refused', async () => {
    const before = await rpc<Sitting[]>('listSittings');
    await page.reload();
    await until(async () => (await phase()) === 'active');
    expect(await page.evaluate<Record<string, number>>('window.__fake')).toMatchObject({
      resets: 0,
      timerResets: 0,
      timerStarts: 0,
      timerOpens: 0,
    });
    const after = await rpc<Sitting[]>('listSittings');
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    // A Submit after the reload goes straight through, no card.
    const submits = (await page.evaluate<{ submits: number }>('window.__fake')).submits;
    await page.locator('[data-e2e-locator=console-submit-button]').click();
    await until(
      async () => (await page.evaluate<{ submits: number }>('window.__fake')).submits > submits,
    );
    expect(await page.evaluate<boolean>("!!document.querySelector('aperture-lc-coach')")).toBe(false);

    await page.locator('[data-fake=next]').click();
    await until(async () => (await phase()) === 'prompt');
    await click('start');
    await until(async () => (await phase()) === 'failed');
    expect(await textOf('aperture-lc-overlay', '[data-ap=reason]')).toContain(
      'Another sitting is still open',
    );
    // Refused before any click: the editor is untouched.
    expect(await page.evaluate<{ resets: number }>('window.__fake')).toMatchObject({ resets: 0 });
    expect((await rpc<Sitting[]>('listSittings')).length).toBe(before.length);

    // Just looking, then the pill at its real place (bottom-right, a fixed child of a zero-size host): the
    // prompt again.
    await click('look');
    await until(async () => (await phase()) === 'hidden');
    expect(await textOf('aperture-lc-badge', '[data-ap=reopen]')).toBe(
      'Aperture · Start a sitting',
    );
    await click('reopen', 'aperture-lc-badge');
    await until(async () => (await phase()) === 'prompt');
    expect(await textOf('aperture-lc-badge', '[data-ap=reopen]')).toBeNull();
  }, 60_000);

  // Safari sends LeetCode's GraphQL as blob XHRs (debug log 9); Chromium's real XHR and Blob prove the read.
  it('reads LeetCode’s GraphQL from a real blob XHR, and the page still gets its own', async () => {
    await worker.evaluate(`chrome.storage.local.set({ debug: true })`);
    const blob = await context.newPage();
    try {
      await blob.addInitScript!('window.__fakeOpts = { blobGql: true }');
      await blob.goto('https://leetcode.com/problems/two-sum/description/');
      // The page's own read, through FileReader (in its load handler, before our loadend): whole and parsed.
      expect(
        await blob.evaluate<string>(
          'window.__fake.fetchDoc().then((r) => r.data.question.titleSlug)',
        ),
      ).toBe('two-sum');
      const entry = await until(async () => {
        const log = await worker.evaluate<Array<Record<string, unknown>>>(
          "chrome.storage.local.get('debugLog').then((r) => r.debugLog || [])",
        );
        return log.find((e) => e.type === 'wire' && e.how === 'xhr:blob-ok');
      });
      expect(entry).toMatchObject({
        how: 'xhr:blob-ok',
        items: ['problem'],
        ops: ['questionDetail'],
        res: expect.any(Number),
      });
    } finally {
      await blob.close();
      await worker.evaluate(`chrome.storage.local.set({ debug: false })`);
    }
  }, 60_000);
});
