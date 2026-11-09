// One dev-check run, every side effect injected (pipeline.test.ts drives it with fakes):
//   run-start → deploy-wait → sign in → sweep earlier runs' leftovers → in-page build check → scenarios
//   → finally: cleanup by ledger id, verify nothing's left, dev's build unchanged → report → run-end.
// Cleanup runs whatever happened before it. Exit: 0 PASS, 1 FAIL (any reason code), 2 CRASH.
import { DEV_WORK_MIN, financeRowOf, ledgerKind, type ApiClient } from './api';
import { targetOrigin } from './config';
import type { DeployRun } from './deploy';
import { parseMarker } from './deploy';
import { DevcheckError, codeOf, detailOf, type ReasonCode } from './errors';
import { IOS_NOTE, type Ios, type IosClient } from './ios';
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
  NeedsYou,
  needsYou,
  needsYouReason,
  shotWithheld,
  type Ctx,
  type InterceptOpts,
  type Interception,
  type Scenario,
} from './scenario';
import { nearExpiry, type Session } from './token';

export interface BrowserSession {
  page: PwPage;
  signIn(shot: (name: string) => Promise<void>): Promise<Session>;
  readSession(): Promise<Session | null>; // throws WRONG_USER if the page's session isn't the test user
  // The page hasn't renewed: a refresh_token grant from node (login.ts). Absent locally (12 h tokens).
  refreshSession?(): Promise<Session | null>;
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
  makeApi: (token: () => string, fresh: () => Promise<void>) => ApiClient;
  makeMcp: (token: () => string) => McpClient;
  now: () => number;
  log: (msg: string) => void;
  responseWaitMs?: number; // how long cleanup waits for a create still in flight (default 30 s)
  // Scenarios whose slow steps run this time (run.ts decides: --tier all, --feature, or a touched slowPath);
  // absent: every slow step runs. The rest are deferred — reported, never failed (DEV-CHECK.md → Slow tier).
  slow?: string[];
  ios?: Ios; // the Mac's iOS Simulator (ios.ts); absent, an iOS step says needs you
  // The local check only (local/run-local.ts): a step this returns a reason for is deferred with it — a row
  // that only dev can prove ('local: … runs on dev') — and the end of the run asserts no timer was left running.
  skip?: (scenario: string, step: { id: string; entry: string }) => string | null;
  checkSessions?: boolean;
}

export const DEFER_NOTE = 'slow tier: the branch touches none of its paths — run --tier all';
const NO_IOS: IosClient = {
  run: () => needsYou(`${IOS_NOTE}: no mailroom in this run`),
};

// Chromium's console line for a failed load names no URL, so while a failing intercept is live these are the
// harness's own doing (window-scoped, not per method — DEV-CHECK.md → Injected failures).
const INJECTED_CONSOLE =
  /^Failed to load resource: (the server responded with a status of \d+|net::ERR_FAILED)/;

// A failed load's URL for the report: host and path, never the query (a sign-in callback's code rides there).
const loadUrl = (u: string) => {
  try {
    const url = new URL(u);
    return url.host + url.pathname;
  } catch {
    return u.split(/[?#]/)[0]; // never throw inside a page listener
  }
};
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
    failures: [],
    coverage: [],
    steps: [],
    created: [],
    swept: [],
    unrecorded: [],
    orphanIntents: [],
    blockedDeletes: [],
    failedDeletes: [],
    consoleErrors: [],
    throttled: [],
    failedLoads: [],
    injected: [],
    shots: [],
    durationMs: 0,
  };
  // A message keeps the failure's detail in the report (status line + a Failed line); a step's failure has
  // its row, so STEP_FAILED passes none and the status line stays `FAIL: STEP_FAILED`.
  // The token may have renewed in the page since sign-in, and must still be the test user's (throws WRONG_USER);
  // a dead page keeps the token we have.
  const renewSession = async () => {
    try {
      const fresh = await browser?.readSession();
      // Never back to an older token: after a refresh from here the page still holds the expired one.
      if (fresh && (!session || fresh.expiresAt >= session.expiresAt)) session = fresh;
    } catch (err) {
      if (codeOf(err) === 'WRONG_USER') throw err;
    }
  };
  // Before every API request (api.ts backoff): a token within the margin is re-read from the page — the app
  // renews itself (automaticSilentRenew) — and, if the page hasn't, renewed from here with its refresh token.
  // One renewal at a time: a step's parallel calls share it.
  let refreshing: Promise<void> | undefined;
  const fresh = async () => {
    if (!session || !nearExpiry(session, d.now())) return;
    await renewSession();
    if (!nearExpiry(session, d.now())) return;
    refreshing ??= (async () => {
      const s = await browser?.refreshSession?.();
      if (s) session = s;
    })().finally(() => (refreshing = undefined));
    // A failed refresh (a dead page, the network, invalid_grant) still lets a token with life left go out;
    // another identity never does.
    await refreshing.catch((err: unknown) => {
      if (codeOf(err) === 'WRONG_USER' || session!.expiresAt * 1000 <= d.now()) throw err;
    });
  };
  const fail = (code: ReasonCode, message?: string) => {
    if (r.status !== 'CRASH') r.status = 'FAIL';
    r.codes.push(code);
    if (message) r.failures.push({ code, message });
  };
  const runIds: string[] = []; // created in this run, oldest first
  const pendingRecords: Promise<void>[] = []; // one per create request, from the moment it's SENT
  let baseline: Set<string> | undefined; // the partition's task ids right after the sweep
  let placeBaseline: Set<string> | undefined; // and its place ids
  let categoryBaseline: Set<string> | undefined; // and its category ids
  let browser: BrowserSession | undefined;
  let session: Session | undefined;
  let api: ApiClient | undefined;
  let prefix = 'setup';
  const intercepts = new Set<{ method: string; fails: boolean; release: () => Promise<void> }>(); // live ctx.intercept()s
  const failing = () => [...intercepts].some((i) => i.fails); // a canned 200 opens no console window
  const injectedRequests = new WeakSet<object>(); // the requests an intercept answered itself

  d.ledger.append({ run: d.runId, op: 'run-start' });
  try {
    if (d.waitForDeploy) r.deployUrl = (await d.waitForDeploy()).url;

    browser = await d.openBrowser();
    const page = browser.page;
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (failing() && INJECTED_CONSOLE.test(m.text())) return;
      r.consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => r.consoleErrors.push(String(e)));
    page.on('response', (res) => {
      if (injectedRequests.has(res.request())) return; // ours: in r.injected
      const url = new URL(res.url());
      const method = url.origin === targetOrigin() ? methodOf(res.url()) : undefined;
      // While a failing intercept is live the console's failed-load lines are dropped (they name no URL), so a real
      // failed load in that window — /api or anything else — is recorded from its response instead.
      if (failing() && res.status() >= 400 && res.status() !== 429)
        r.consoleErrors.push(
          `HTTP ${res.status()} on ${method ? `/api/${method}` : url.host + url.pathname} (during an injected failure)`,
        );
      if (res.status() !== 429) return;
      // Off the dev origin, the host too, so a third party's `/api/x` never reads as a BFF method.
      r.throttled.push(
        method
          ? `/api/${method}`
          : url.origin === targetOrigin()
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
    // Chromium's console line for a failed load names no URL ("status of 400 ()"): record each one's method, status
    // and URL, in order, so the report can name it. Informational only — the console line is what fails a row.
    page.on('response', (res) => {
      if (res.status() >= 400 && !injectedRequests.has(res.request()))
        r.failedLoads.push(`${res.status()} ${res.request().method()} ${loadUrl(res.url())}`);
    });
    page.on('requestfailed', (req) => {
      const why = req.failure?.()?.errorText ?? 'failed';
      // A navigation or unmount cancelling its own request is no failed load (and prints no console line).
      if (why !== 'net::ERR_ABORTED' && !injectedRequests.has(req))
        r.failedLoads.push(`${why} ${req.method()} ${loadUrl(req.url())}`);
    });
    const ui = createUi(page);
    const shot = makeShot(page, ui, d.shotsDir, () => prefix, r.shots);

    session = await browser.signIn(shot);
    api = d.makeApi(() => session!.accessToken, fresh);

    // A crashed earlier run's ids are still pending in the shared ledger: clean them first.
    for (const id of pendingIds(d.ledger.read())) {
      const out = await clean(api, id);
      if (out === 'gone') d.ledger.append({ run: d.runId, op: 'gone', id });
      else if (out === 'removed') {
        d.ledger.append({ run: d.runId, op: 'swept', id });
        r.swept.push(id);
      }
    }
    // A killed run skips a step's `finally`, and the settings row isn't ledgered: a leftover 1-minute block
    // would have every later timer hit Done at 60 s.
    if ((await api.reads.getSettings()).pomodoroWorkMin !== DEV_WORK_MIN)
      await api.writes.updateSettings({ pomodoroWorkMin: DEV_WORK_MIN });
    baseline = new Set((await api.reads.listTasks()).map((t) => t.id));
    placeBaseline = new Set((await api.reads.listPlaces()).map((p) => p.id));
    categoryBaseline = new Set((await api.reads.listCategories()).map((c) => c.id));
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
      ios: NO_IOS,
      log: d.log,
    };
    for (const sc of d.scenarios) {
      ctx.ios = d.ios?.forScenario(sc.id) ?? NO_IOS;
      let failed = false;
      let needs: string | null = null; // a step said needs you: the rest of the scenario reads so too
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
        if (needs !== null) {
          res.status = 'needs-you';
          res.note = needs;
          continue;
        }
        const skipped = d.skip?.(sc.id, step) ?? null;
        if (skipped !== null) {
          res.status = 'deferred';
          res.note = skipped;
          continue;
        }
        if (step.cost === 'slow' && d.slow && !d.slow.includes(sc.id)) {
          res.status = 'deferred'; // the scenario goes on: a slow step is never a cheap one's prerequisite
          res.note = DEFER_NOTE;
          continue;
        }
        const s0 = d.now();
        try {
          await renewSession(); // a cached token can lapse mid-run, and a run with sim steps is minutes long
          await step.run(ctx);
          await Promise.all(pendingRecords); // a create's id is in the ledger before the next step reads it
          res.status = 'pass';
        } catch (err) {
          const reason = needsYouReason(err);
          if (reason !== null) {
            // Not a failure: the run stays green, the rows read needs-you with the reason (matrix.ts).
            if (!(err instanceof NeedsYou && err.stepOnly)) needs = reason;
            res.status = 'needs-you';
            res.note = reason;
            res.ms = d.now() - s0;
            continue;
          }
          failed = true;
          res.status = 'fail';
          res.error = err instanceof Error ? err.message : String(err);
          fail('STEP_FAILED');
          // A secret may have been on screen (scenario.ts hidingSecret): the error text stands alone.
          if (!shotWithheld(err))
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
    if (code) fail(code, detailOf(err));
    else {
      r.status = 'CRASH';
      r.crash = err instanceof Error ? (err.stack ?? err.message) : String(err);
    }
  } finally {
    await Promise.allSettled(pendingRecords);
    if (d.ios) {
      await d.ios.finish().catch(() => undefined);
      r.shots.push(...d.ios.shots);
    }
    // A coded error (a dead session the refresh couldn't renew, WRONG_USER) fails the run naming it, as the
    // outer catch does; anything else is a crash.
    await cleanup().catch((err: unknown) => {
      const code = codeOf(err);
      if (code) {
        fail(code, `cleanup: ${detailOf(err)}`);
        return fail(
          'LEFTOVERS',
          'cleanup stopped before the leak check: dev may hold more of this run',
        );
      }
      r.status = 'CRASH';
      r.crash = `${r.crash ? `${r.crash}\n` : ''}cleanup: ${err instanceof Error ? err.message : String(err)}`;
    });
    // Scored after cleanup, from whatever ran: a setup failure leaves every step-proven row skipped, and a
    // build change mid-run unproves them all — the steps may have driven another build.
    r.coverage = d.scenarios.flatMap((sc) =>
      coverageOf(sc, r.steps, r.codes.includes('DEV_CHANGED_MID_RUN')),
    );
    // A thin layer over needs-you: the rows the sim couldn't prove, and why, for the status line and the PR.
    const iosOut = r.coverage.filter(
      (x) => x.entry === 'ios' && x.status === 'needs-you' && x.note?.startsWith(`${IOS_NOTE}: `),
    );
    if (d.ios || iosOut.length)
      r.ios = {
        jobs: d.ios?.jobs ?? [],
        unavailable: iosOut.length
          ? { reason: iosOut[0]!.note!.slice(IOS_NOTE.length + 2), rows: iosOut.length }
          : // an outage reaches the banner even if no ios row inherited it
            d.ios?.unavailable()
            ? { reason: d.ios.unavailable()!, rows: 0 }
            : null,
      };
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
    const match = (u: URL) => u.origin === targetOrigin() && u.pathname === `/api/${method}`;
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
      return route.fulfill({
        status,
        body: JSON.stringify(opts.body ?? {}),
        headers: { 'content-type': 'application/json' },
      });
    };
    await page.route(match, handler);
    let released = false;
    const entry = {
      method,
      fails: !!opts.abort || status >= 400,
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
      fail('LEFTOVERS', `${id} kept: unrecorded parts ${unknownParts.join(', ')}`);
      return false;
    }
    await client.writes.deleteTask(id);
    return true;
  }

  // A ledger id is a task unless its `via` says otherwise (ledgerKind) — each kind is read back and deleted
  // through its own method, so a Flux set or a place is never "verified gone" by a task lookup. The place
  // token has no id of its own: `place-token:<run>` stands for "a run minted the test user's token", which
  // exists while the status reads active and is removed by a revoke.
  // A finance bucket or link names a row the fixture bank owns (api.ts financeRowOf): it "exists" while
  // the row still carries what the run set, and removing it clears that, never the row.
  // A push device exists while it's among the status's alive devices (a removed one is a keyless
  // tombstone; one the poller dropped is gone).
  // The reminder toggles, `reminder-toggles:<run>`, exist while any reads off; removing them switches all on.
  async function exists(client: ApiClient, id: string): Promise<boolean> {
    switch (ledgerKind(d.ledger.read(), id)) {
      case 'flux':
        return (await client.reads.getFluxSet(id)) !== null;
      case 'place':
        return (await client.reads.listPlaces()).some((p) => p.id === id);
      case 'category':
        return (await client.reads.listCategories()).some((c) => c.id === id);
      case 'habit': // archived reads as gone: the API has no habit delete (api.ts HABIT_VIA)
        return (await client.reads.listHabits()).some((h) => h.id === id && h.active);
      case 'placeToken':
        return (await client.reads.getPlaceTokenStatus()).active;
      case 'financeBucket':
        return (await client.reads.getFinanceTransaction(financeRowOf(id)))?.bucket != null;
      case 'financeLink':
        return (await client.reads.getFinanceTransaction(financeRowOf(id)))?.refundOfId != null;
      case 'financeRule':
        return (await client.reads.listFinanceRules()).some((x) => x.id === id);
      case 'series':
        return (await client.reads.listSeries()).some((x) => x.id === id);
      case 'pushsub':
        return (await client.reads.getPushStatus()).devices.some((d) => d.id === id);
      case 'reminderToggles': {
        const st = await client.reads.getSettings();
        return !st.remindTimed || !st.remindDueDay || !st.remindPlanned;
      }
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
      case 'category':
        await client.writes.deleteCategory(id, null); // newest-first: a run's tasks made after it went first
        return true;
      case 'habit':
        await client.writes.archiveHabit(id);
        return true;
      case 'placeToken':
        await client.writes.revokePlaceToken();
        return true;
      case 'financeBucket':
        await client.writes.unsetFinanceBucket(id);
        return true;
      case 'financeLink':
        await client.writes.unlinkFinanceRefund(id);
        return true;
      case 'financeRule':
        await client.writes.deleteFinanceRule(id);
        return true;
      case 'series':
        await client.writes.deleteSeries(id); // its occurrences first, by this id (api.ts)
        return true;
      case 'pushsub':
        await client.writes.unsubscribePush(id);
        return true;
      case 'reminderToggles':
        await client.writes.restoreReminderToggles();
        return true;
      case 'task':
        return safeDelete(client, id);
    }
  }

  // One id's read-back and removal. A throw (a revoke racing another device, any delete's error) is caught
  // here, so the loop goes on to the rest: the id stays pending (the next run's sweep retries it), the error
  // is reported, and the run fails LEFTOVERS.
  async function clean(client: ApiClient, id: string): Promise<'gone' | 'removed' | 'kept'> {
    try {
      if (!(await exists(client, id))) return 'gone';
      return (await removeRecorded(client, id)) ? 'removed' : 'kept';
    } catch (err) {
      const what = `${id}: ${err instanceof Error ? err.message : String(err)}`;
      r.failedDeletes.push(what);
      const code = codeOf(err); // a guard's refusal (LEDGER_GUARD…) keeps its own code too
      if (code && code !== 'LEFTOVERS') fail(code, detailOf(err));
      fail('LEFTOVERS', what); // a swept id has no `left:` verdict later, so the why is recorded here
      return 'kept';
    }
  }

  async function cleanup(): Promise<void> {
    const entries = d.ledger.read();
    r.orphanIntents.push(
      ...orphanIntents(entries.filter((e) => e.run === d.runId)).map(
        (e) => `${e.via} "${e.title ?? ''}"`,
      ),
    );
    if (r.orphanIntents.length)
      fail('LEFTOVERS', `create sent, id never recorded: ${r.orphanIntents.join('; ')}`);
    const mine = entries.filter((e) => e.run === d.runId && e.op === 'created' && e.id);
    if (!api) {
      // Never signed in: nothing of this run can exist; earlier leftovers wait for the next run.
      if (mine.length)
        fail(
          'LEFTOVERS',
          `never signed in, yet this run recorded: ${mine.map((e) => e.id).join(', ')}`,
        );
      return;
    }
    try {
      await renewSession();
    } catch (err) {
      fail('WRONG_USER', detailOf(err));
      return;
    }

    const pending = new Set(pendingIds(entries));
    for (const e of [...mine].reverse()) {
      const id = e.id!;
      const rec: CreatedRecord = { id, via: e.via ?? '?', title: e.title, final: 'left' };
      r.created.unshift(rec);
      if (!pending.has(id)) continue;
      const out = await clean(api, id);
      if (out === 'gone') d.ledger.append({ run: d.runId, op: 'gone', id });
      else if (out === 'removed') d.ledger.append({ run: d.runId, op: 'deleted', id });
    }
    // Verify by reading back, not by trusting the deletes. A read-back that throws proves nothing: 'left'.
    const after = d.ledger.read();
    const stillThere = (id: string) =>
      exists(api!, id).catch((err: unknown) => {
        r.failedDeletes.push(
          `${id}: read-back: ${err instanceof Error ? err.message : String(err)}`,
        );
        return true;
      });
    for (const rec of r.created) {
      if (await stillThere(rec.id)) continue; // stays 'left'
      // This run's own `gone` — a reused id (a push device) may carry an older run's.
      rec.final = after.some((e) => e.id === rec.id && e.op === 'gone' && e.run === d.runId)
        ? 'gone'
        : 'deleted';
    }
    for (const id of r.swept)
      if (await stillThere(id)) r.created.push({ id, via: 'swept', final: 'left' });
    const left = r.created.filter((c) => c.final === 'left').map((c) => c.id);
    if (left.length) fail('LEFTOVERS', `left: ${left.join(', ')}`);

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
    // And categories (Settings' Add, MCP create_category): the same leak check.
    const cats = (await api.reads.listCategories()).map((c) => c.id).filter((id) => !known.has(id));
    r.unrecorded.push(...cats.filter((id) => !categoryBaseline || categoryBaseline.has(id)));
    if (categoryBaseline) r.appeared.push(...cats.filter((id) => !categoryBaseline!.has(id)));
    if (r.appeared.length)
      fail('LEFTOVERS', `appeared during the run, not in the ledger: ${r.appeared.join(', ')}`);
    // Sessions aren't ledgered: a timer a run leaves running breaks every later timer scenario (and, on dev,
    // the next run's). Locally the table is fresh, so any running one is this run's leak.
    if (d.checkSessions) {
      const running = await api.reads.listRunningSessions();
      if (running.length)
        fail('LEFTOVERS', `a timer was left running: ${running.map((s) => s.id).join(', ')}`);
    }

    if (r.startSha) {
      r.endSha = parseMarker(await d.fetchShell());
      if (r.endSha !== r.startSha)
        fail(
          'DEV_CHANGED_MID_RUN',
          `end build ${r.endSha?.slice(0, 7) ?? 'none'} ≠ start ${r.startSha.slice(0, 7)}`,
        );
    }
  }
}

export const exitCode = (r: RunResult): number =>
  r.status === 'PASS' ? 0 : r.status === 'FAIL' ? 1 : 2;
