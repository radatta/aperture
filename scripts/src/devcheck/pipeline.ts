// One dev-check run, every side effect injected (pipeline.test.ts drives it with fakes):
//   run-start → deploy-wait → sign in → sweep earlier runs' leftovers → in-page build check → scenarios
//   → finally: cleanup by ledger id, verify nothing's left, dev's build unchanged → report → run-end.
// Cleanup runs whatever happened before it. Exit: 0 PASS, 1 FAIL (any reason code), 2 CRASH.
import { ledgerKind, type ApiClient } from './api';
import { DEV_ORIGIN } from './config';
import type { DeployRun } from './deploy';
import { parseMarker } from './deploy';
import { DevcheckError, codeOf, type ReasonCode } from './errors';
import { orphanIntents, pendingIds, type Ledger } from './ledger';
import { coverageOf } from './matrix';
import type { McpClient } from './mcp';
import { mcpToken, type McpSession } from './mcp-login';
import { CREATE_METHODS, idsFromCreateResponse, isCreateRequest, methodOf } from './recorder';
import type { CreatedRecord, RunResult, StepResult } from './report';
import type { PwPage, PwRequest, PwResponse, PwRoute } from './pw-types';
import {
  createUi,
  datesFor,
  makeShot,
  type Ctx,
  type InterceptOpts,
  type Interception,
  type Scenario,
} from './scenario';
import type { Session } from './token';

export interface BrowserSession {
  page: PwPage;
  signIn(shot: (name: string) => Promise<void>): Promise<Session>;
  readSession(): Promise<Session | null>; // throws WRONG_USER if the page's session isn't the test user
  // The claude client, as the test user; screenshots come from its own sign-in page.
  signInMcp(shotOf: (page: PwPage) => (name: string) => Promise<void>): Promise<McpSession>;
  close(): Promise<void>;
}

export interface PipelineDeps {
  runId: string;
  tier: string;
  feature?: string[]; // --feature: whose rows the report shows as this feature's
  expectedSha: string;
  scenarioSha?: string; // HEAD, where the scenarios came from
  scenarios: Scenario[];
  ledger: Ledger;
  shotsDir: string;
  waitForDeploy?: () => Promise<DeployRun>; // absent with --no-deploy-wait
  fetchShell: () => Promise<string>;
  openBrowser: () => Promise<BrowserSession>;
  makeApi: (token: () => string) => ApiClient;
  makeMcp: (token: () => string) => McpClient;
  now: () => number;
  log: (msg: string) => void;
  responseWaitMs?: number; // how long cleanup waits for a create still in flight (default 30 s)
}

// Chromium's console line for a failed load names no URL, so while an intercept is live these are the
// harness's own doing (window-scoped, not per method — DEV-CHECK.md → Injected failures).
const INJECTED_CONSOLE =
  /^Failed to load resource: (the server responded with a status of \d+|net::ERR_FAILED)/;

const IN_PAGE_RELOADS = 3; // the PWA's service worker can serve the previous shell first (pwa-two-launch-refresh)

export async function runPipeline(d: PipelineDeps): Promise<RunResult> {
  const t0 = d.now();
  const r: RunResult = {
    runId: d.runId,
    tier: d.tier,
    feature: d.feature ?? [],
    expectedSha: d.expectedSha,
    scenarioSha: d.scenarioSha,
    status: 'PASS',
    codes: [],
    coverage: [],
    steps: [],
    created: [],
    swept: [],
    unrecorded: [],
    orphanIntents: [],
    blockedDeletes: [],
    consoleErrors: [],
    throttled: [],
    injected: [],
    shots: [],
    durationMs: 0,
  };
  const fail = (code: ReasonCode) => {
    if (r.status !== 'CRASH') r.status = 'FAIL';
    r.codes.push(code);
  };
  const runIds: string[] = []; // created in this run, oldest first
  const pendingRecords: Promise<void>[] = []; // one per create request, from the moment it's SENT
  let baseline: Set<string> | undefined; // the partition's task ids right after the sweep
  let placeBaseline: Set<string> | undefined; // and its place ids
  let browser: BrowserSession | undefined;
  let session: Session | undefined;
  let api: ApiClient | undefined;
  let prefix = 'setup';
  const intercepts = new Set<{ method: string; release: () => Promise<void> }>(); // live ctx.intercept()s
  const injectedRequests = new WeakSet<object>(); // the requests an intercept answered itself

  d.ledger.append({ run: d.runId, op: 'run-start' });
  try {
    if (d.waitForDeploy) r.deployUrl = (await d.waitForDeploy()).url;

    browser = await d.openBrowser();
    const page = browser.page;
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (intercepts.size && INJECTED_CONSOLE.test(m.text())) return;
      r.consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => r.consoleErrors.push(String(e)));
    page.on('response', (res) => {
      if (injectedRequests.has(res.request())) return; // ours: in r.injected
      const url = new URL(res.url());
      const method = url.origin === DEV_ORIGIN ? methodOf(res.url()) : undefined;
      // While an intercept is live the console's failed-load lines are dropped (they name no URL), so a real
      // failed load in that window — /api or anything else — is recorded from its response instead.
      if (intercepts.size && res.status() >= 400 && res.status() !== 429)
        r.consoleErrors.push(
          `HTTP ${res.status()} on ${method ? `/api/${method}` : url.host + url.pathname} (during an injected failure)`,
        );
      if (res.status() !== 429) return;
      // Off the dev origin, the host too, so a third party's `/api/x` never reads as a BFF method.
      r.throttled.push(
        method
          ? `/api/${method}`
          : url.origin === DEV_ORIGIN
            ? url.pathname
            : url.host + url.pathname,
      );
    });
    // Track creates from the request, not the response: one still in flight when a step times out must be
    // waited for (and its id recorded) before cleanup, not lost.
    page.on('request', (req) => {
      const method = req.method() === 'POST' ? methodOf(req.url()) : undefined;
      if (
        method &&
        (CREATE_METHODS as readonly string[]).includes(method) &&
        isCreateRequest(method, req.postData())
      )
        pendingRecords.push(awaitCreate(req, method));
    });
    const ui = createUi(page);
    const shot = makeShot(page, ui, d.shotsDir, () => prefix, r.shots);

    session = await browser.signIn(shot);
    api = d.makeApi(() => session!.accessToken);

    // A crashed earlier run's ids are still pending in the shared ledger: clean them first.
    for (const id of pendingIds(d.ledger.read())) {
      if (!(await exists(api, id))) d.ledger.append({ run: d.runId, op: 'gone', id });
      else if (await removeRecorded(api, id)) {
        d.ledger.append({ run: d.runId, op: 'swept', id });
        r.swept.push(id);
      }
    }
    baseline = new Set((await api.reads.listTasks()).map((t) => t.id));
    placeBaseline = new Set((await api.reads.listPlaces()).map((p) => p.id));
    // After the sweep (whose writes use the checked app session), before any step: the MCP token is the
    // test user's — WRONG_USER otherwise — before a step can write through it.
    const mcpSession = await browser.signInMcp((p) =>
      makeShot(p, createUi(p), d.shotsDir, () => 'mcp', r.shots),
    );
    const mcp = d.makeMcp(() => mcpToken(mcpSession, d.now));

    r.startSha = parseMarker(await d.fetchShell());
    let inPage: string | undefined;
    for (let reloads = 0; ; reloads++) {
      inPage = await page.evaluate<string | undefined>(
        `document.querySelector('meta[name="aperture-build"]')?.content`,
      );
      if (inPage === d.expectedSha || reloads === IN_PAGE_RELOADS) break;
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    if (inPage !== d.expectedSha)
      throw new DevcheckError(
        'BUILD_MISMATCH_IN_PAGE',
        `page shows build ${inPage ?? 'none'} after ${IN_PAGE_RELOADS} reloads`,
      );

    const ctx: Ctx = {
      page,
      api,
      mcp,
      ui,
      nonce: d.runId.replace(/[^a-z0-9]/gi, '').slice(-10),
      dates: datesFor(new Date(d.now())),
      shot,
      createdIds: () => [...runIds],
      consoleErrors: () => [...r.consoleErrors],
      intercept: (method, opts) => intercept(page, method, opts),
      log: d.log,
    };
    for (const sc of d.scenarios) {
      let failed = false;
      for (const step of sc.steps) {
        prefix = `${sc.id}-${step.id}`;
        const res: StepResult = {
          scenario: sc.id,
          step: step.id,
          title: step.title,
          status: 'skipped', // until it has run — a row never reads proven off a step that didn't
          ms: 0,
        };
        r.steps.push(res);
        if (failed) continue;
        const s0 = d.now();
        try {
          await step.run(ctx);
          await Promise.all(pendingRecords); // a create's id is in the ledger before the next step reads it
          res.status = 'pass';
        } catch (err) {
          failed = true;
          res.status = 'fail';
          res.error = err instanceof Error ? err.message : String(err);
          fail('STEP_FAILED');
          try {
            await shot('fail');
            res.shot = r.shots.at(-2); // the light one
          } catch {
            // a dead page can't be shot; the error text stands alone
          }
        }
        res.ms = d.now() - s0;
      }
      // An intercept a step left live (it threw, or never released) must not fail the next scenario's reads.
      for (const i of [...intercepts]) await i.release();
    }
  } catch (err) {
    const code = codeOf(err);
    if (code) fail(code);
    else {
      r.status = 'CRASH';
      r.crash = err instanceof Error ? (err.stack ?? err.message) : String(err);
    }
  } finally {
    await Promise.allSettled(pendingRecords);
    await cleanup().catch((err: unknown) => {
      r.status = 'CRASH';
      r.crash = `${r.crash ? `${r.crash}\n` : ''}cleanup: ${err instanceof Error ? err.message : String(err)}`;
    });
    // Scored after cleanup, from whatever ran: a setup failure leaves every step-proven row skipped, and a
    // build change mid-run unproves them all — the steps may have driven another build.
    r.coverage = d.scenarios.flatMap((sc) =>
      coverageOf(sc, r.steps, r.codes.includes('DEV_CHANGED_MID_RUN')),
    );
    await browser?.close().catch(() => undefined);
    r.durationMs = d.now() - t0;
    d.ledger.append({ run: d.runId, op: 'run-end', status: r.status });
  }
  return r;

  async function intercept(
    page: PwPage,
    method: string,
    opts: InterceptOpts = {},
  ): Promise<Interception> {
    const status = opts.status ?? 429;
    let left = opts.times ?? Infinity;
    let hits = 0;
    let passed = 0;
    const match = (u: URL) => u.origin === DEV_ORIGIN && u.pathname === `/api/${method}`;
    const handler = async (route: PwRoute) => {
      if (left <= 0) {
        passed++;
        return route.fallback();
      }
      left--;
      hits++;
      injectedRequests.add(route.request());
      r.injected.push(`/api/${method} → ${opts.abort ? 'dropped' : status}`);
      if (opts.abort) return route.abort('failed');
      return route.fulfill({ status, body: '{}', headers: { 'content-type': 'application/json' } });
    };
    await page.route(match, handler);
    let released = false;
    const entry = {
      method,
      // Unrouted, not just switched off: a live page route turns off the page's HTTP cache.
      release: async () => {
        if (released) return;
        released = true;
        intercepts.delete(entry);
        await page.unroute(match, handler).catch(() => undefined);
      },
    };
    intercepts.add(entry);
    return { hits: () => hits, passed: () => passed, release: entry.release };
  }

  async function awaitCreate(req: PwRequest, method: string): Promise<void> {
    const timeout = new Promise<'timeout'>((res) =>
      setTimeout(() => res('timeout'), d.responseWaitMs ?? 30_000).unref(),
    );
    const res = await Promise.race([req.response().catch(() => null), timeout]);
    if (res === 'timeout') r.orphanIntents.push(`ui:${method} sent, no response within the wait`);
    else if (res) await record(res, method);
  }

  async function record(res: PwResponse, method: string): Promise<void> {
    if (res.status() !== 200) return;
    const known = d.ledger.read();
    const owns = (original: string, parent: string) =>
      known.some((e) => e.op === 'created' && e.id === original) &&
      !!baseline &&
      !baseline.has(parent);
    const ids = idsFromCreateResponse(method, await res.json().catch(() => null), owns);
    for (const id of ids) {
      if (runIds.includes(id)) continue;
      runIds.push(id);
      d.ledger.append({ run: d.runId, op: 'created', id, via: `ui:${method}` });
    }
  }

  // Deleting a parent deletes its parts server-side. Before any delete, the server is asked for parts the
  // ledger doesn't know; if there are any, the delete is skipped and the run fails — never a cascade into them.
  async function safeDelete(client: ApiClient, id: string): Promise<boolean> {
    const known = new Set(
      d.ledger
        .read()
        .filter((e) => e.op === 'created')
        .map((e) => e.id),
    );
    const unknownParts = (await client.reads.listTasks())
      .filter((t) => t.parentId === id && !known.has(t.id))
      .map((t) => t.id);
    if (unknownParts.length) {
      r.blockedDeletes.push(`${id} (unrecorded parts: ${unknownParts.join(', ')})`);
      fail('LEFTOVERS');
      return false;
    }
    await client.writes.deleteTask(id);
    return true;
  }

  // A ledger id is a task unless its `via` says otherwise (ledgerKind) — each kind is read back and deleted
  // through its own method, so a Flux set or a place is never "verified gone" by a task lookup. The place
  // token has no id of its own: `place-token:<run>` stands for "a run minted the test user's token", which
  // exists while the status reads active and is removed by a revoke.
  async function exists(client: ApiClient, id: string): Promise<boolean> {
    switch (ledgerKind(d.ledger.read(), id)) {
      case 'flux':
        return (await client.reads.getFluxSet(id)) !== null;
      case 'place':
        return (await client.reads.listPlaces()).some((p) => p.id === id);
      case 'placeToken':
        return (await client.reads.getPlaceTokenStatus()).active;
      case 'task':
        return (await client.reads.getTask(id)) !== null;
    }
  }
  async function removeRecorded(client: ApiClient, id: string): Promise<boolean> {
    switch (ledgerKind(d.ledger.read(), id)) {
      case 'flux':
        await client.writes.deleteFluxSet(id);
        return true;
      case 'place':
        await client.writes.deletePlace(id, null); // any task still on it just leaves the list
        return true;
      case 'placeToken':
        await client.writes.revokePlaceToken();
        return true;
      case 'task':
        return safeDelete(client, id);
    }
  }

  async function cleanup(): Promise<void> {
    const entries = d.ledger.read();
    r.orphanIntents.push(
      ...orphanIntents(entries.filter((e) => e.run === d.runId)).map(
        (e) => `${e.via} "${e.title ?? ''}"`,
      ),
    );
    if (r.orphanIntents.length) fail('LEFTOVERS');
    const mine = entries.filter((e) => e.run === d.runId && e.op === 'created' && e.id);
    if (!api) {
      // Never signed in: nothing of this run can exist; earlier leftovers wait for the next run.
      if (mine.length) fail('LEFTOVERS');
      return;
    }
    // The token may have renewed in the page since sign-in — and must still be the test user's.
    try {
      const fresh = await browser?.readSession();
      if (fresh) session = fresh;
    } catch (err) {
      if (codeOf(err) === 'WRONG_USER') {
        fail('WRONG_USER');
        return;
      }
      // a dead page: keep the sign-in token
    }

    const pending = new Set(pendingIds(entries));
    for (const e of [...mine].reverse()) {
      const id = e.id!;
      const rec: CreatedRecord = { id, via: e.via ?? '?', title: e.title, final: 'left' };
      r.created.unshift(rec);
      if (!pending.has(id)) continue;
      if (!(await exists(api, id))) {
        d.ledger.append({ run: d.runId, op: 'gone', id });
        continue;
      }
      if (await removeRecorded(api, id)) d.ledger.append({ run: d.runId, op: 'deleted', id });
    }
    // Verify by reading back, not by trusting the deletes.
    const after = d.ledger.read();
    for (const rec of r.created) {
      if (await exists(api, rec.id)) continue; // stays 'left'
      rec.final = after.some((e) => e.id === rec.id && e.op === 'gone') ? 'gone' : 'deleted';
    }
    for (const id of r.swept)
      if (await exists(api, id)) r.created.push({ id, via: 'swept', final: 'left' });
    if (r.created.some((c) => c.final === 'left')) fail('LEFTOVERS');

    // A task the ledger doesn't know is never deleted. One that was there before the run is reported; one
    // that appeared during it came from a create path the recorder missed — a leak, so the run fails.
    const known = new Set(after.filter((e) => e.id).map((e) => e.id!));
    const visible = new Set((await api.reads.listTasks()).map((t) => t.id));
    const unknown = [...visible].filter((id) => !known.has(id));
    r.unrecorded = unknown.filter((id) => !baseline || baseline.has(id));
    r.appeared = baseline ? unknown.filter((id) => !baseline!.has(id)) : [];
    // The same for places: one added by a path the recorder missed would outlive the run unseen.
    const places = (await api.reads.listPlaces()).map((p) => p.id).filter((id) => !known.has(id));
    r.unrecorded.push(...places.filter((id) => !placeBaseline || placeBaseline.has(id)));
    if (placeBaseline) r.appeared.push(...places.filter((id) => !placeBaseline!.has(id)));
    if (r.appeared.length) fail('LEFTOVERS');

    if (r.startSha) {
      r.endSha = parseMarker(await d.fetchShell());
      if (r.endSha !== r.startSha) fail('DEV_CHANGED_MID_RUN');
    }
  }
}

export const exitCode = (r: RunResult): number =>
  r.status === 'PASS' ? 0 : r.status === 'FAIL' ? 1 : 2;
