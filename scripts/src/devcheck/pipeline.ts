// One dev-check run, every side effect injected (pipeline.test.ts drives it with fakes):
//   run-start → deploy-wait → sign in → sweep earlier runs' leftovers → in-page build check → scenarios
//   → finally: cleanup by ledger id, verify nothing's left, dev's build unchanged → report → run-end.
// Cleanup runs whatever happened before it. Exit: 0 PASS, 1 FAIL (any reason code), 2 CRASH.
import type { ApiClient } from './api';
import type { DeployRun } from './deploy';
import { parseMarker } from './deploy';
import { DevcheckError, codeOf, type ReasonCode } from './errors';
import { orphanIntents, pendingIds, type Ledger } from './ledger';
import { CREATE_METHODS, idsFromCreateResponse, methodOf } from './recorder';
import type { CreatedRecord, RunResult, StepResult } from './report';
import type { PwPage, PwRequest, PwResponse } from './pw-types';
import { createUi, datesFor, makeShot, type Ctx, type Scenario } from './scenario';
import type { Session } from './token';

export interface BrowserSession {
  page: PwPage;
  signIn(shot: (name: string) => Promise<void>): Promise<Session>;
  readSession(): Promise<Session | null>; // throws WRONG_USER if the page's session isn't the test user
  close(): Promise<void>;
}

export interface PipelineDeps {
  runId: string;
  tier: string;
  expectedSha: string;
  scenarios: Scenario[];
  ledger: Ledger;
  shotsDir: string;
  waitForDeploy?: () => Promise<DeployRun>; // absent with --no-deploy-wait
  fetchShell: () => Promise<string>;
  openBrowser: () => Promise<BrowserSession>;
  makeApi: (token: () => string) => ApiClient;
  now: () => number;
  log: (msg: string) => void;
  responseWaitMs?: number; // how long cleanup waits for a create still in flight (default 30 s)
}

const IN_PAGE_RELOADS = 3; // the PWA's service worker can serve the previous shell first (pwa-two-launch-refresh)

export async function runPipeline(d: PipelineDeps): Promise<RunResult> {
  const t0 = d.now();
  const r: RunResult = {
    runId: d.runId,
    tier: d.tier,
    expectedSha: d.expectedSha,
    status: 'PASS',
    codes: [],
    steps: [],
    created: [],
    swept: [],
    unrecorded: [],
    orphanIntents: [],
    consoleErrors: [],
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
  let browser: BrowserSession | undefined;
  let session: Session | undefined;
  let api: ApiClient | undefined;
  let prefix = 'setup';

  d.ledger.append({ run: d.runId, op: 'run-start' });
  try {
    if (d.waitForDeploy) r.deployUrl = (await d.waitForDeploy()).url;

    browser = await d.openBrowser();
    const page = browser.page;
    page.on('console', (m) => m.type() === 'error' && r.consoleErrors.push(m.text()));
    page.on('pageerror', (e) => r.consoleErrors.push(String(e)));
    // Track creates from the request, not the response: one still in flight when a step times out must be
    // waited for (and its id recorded) before cleanup, not lost.
    page.on('request', (req) => {
      const method = req.method() === 'POST' ? methodOf(req.url()) : undefined;
      if (method && (CREATE_METHODS as readonly string[]).includes(method))
        pendingRecords.push(awaitCreate(req, method));
    });
    const ui = createUi(page);
    const shot = makeShot(page, ui, d.shotsDir, () => prefix, r.shots);

    session = await browser.signIn(shot);
    api = d.makeApi(() => session!.accessToken);

    // A crashed earlier run's ids are still pending in the shared ledger: clean them first.
    for (const id of pendingIds(d.ledger.read())) {
      if ((await api.reads.getTask(id)) === null) d.ledger.append({ run: d.runId, op: 'gone', id });
      else {
        await api.writes.deleteTask(id);
        d.ledger.append({ run: d.runId, op: 'swept', id });
        r.swept.push(id);
      }
    }
    baseline = new Set((await api.reads.listTasks()).map((t) => t.id));

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
      ui,
      nonce: d.runId.replace(/[^a-z0-9]/gi, '').slice(-10),
      dates: datesFor(new Date(d.now())),
      shot,
      createdIds: () => [...runIds],
      consoleErrors: () => [...r.consoleErrors],
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
          status: 'pass',
          ms: 0,
        };
        r.steps.push(res);
        if (failed) {
          res.status = 'skipped';
          continue;
        }
        const s0 = d.now();
        try {
          await step.run(ctx);
          await Promise.all(pendingRecords); // a create's id is in the ledger before the next step reads it
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
    await browser?.close().catch(() => undefined);
    r.durationMs = d.now() - t0;
    d.ledger.append({ run: d.runId, op: 'run-end', status: r.status });
  }
  return r;

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
    const isRecorded = (id: string) => known.some((e) => e.op === 'created' && e.id === id);
    const ids = idsFromCreateResponse(method, await res.json().catch(() => null), isRecorded);
    for (const id of ids) {
      if (runIds.includes(id)) continue;
      runIds.push(id);
      d.ledger.append({ run: d.runId, op: 'created', id, via: `ui:${method}` });
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
      if ((await api.reads.getTask(id)) === null) {
        d.ledger.append({ run: d.runId, op: 'gone', id });
        continue;
      }
      await api.writes.deleteTask(id);
      d.ledger.append({ run: d.runId, op: 'deleted', id });
    }
    // Verify by reading back, not by trusting the deletes.
    const after = d.ledger.read();
    for (const rec of r.created) {
      if ((await api.reads.getTask(rec.id)) !== null) continue; // stays 'left'
      rec.final = after.some((e) => e.id === rec.id && e.op === 'gone') ? 'gone' : 'deleted';
    }
    for (const id of r.swept)
      if ((await api.reads.getTask(id)) !== null)
        r.created.push({ id, via: 'swept', final: 'left' });
    if (r.created.some((c) => c.final === 'left')) fail('LEFTOVERS');

    // A task the ledger doesn't know is never deleted. One that was there before the run is reported; one
    // that appeared during it came from a create path the recorder missed — a leak, so the run fails.
    const known = new Set(after.filter((e) => e.id).map((e) => e.id!));
    const visible = new Set((await api.reads.listTasks()).map((t) => t.id));
    const unknown = [...visible].filter((id) => !known.has(id));
    r.unrecorded = unknown.filter((id) => !baseline || baseline.has(id));
    r.appeared = baseline ? unknown.filter((id) => !baseline!.has(id)) : [];
    if (r.appeared.length) fail('LEFTOVERS');

    if (r.startSha) {
      r.endSha = parseMarker(await d.fetchShell());
      if (r.endSha !== r.startSha) fail('DEV_CHANGED_MID_RUN');
    }
  }
}

export const exitCode = (r: RunResult): number =>
  r.status === 'PASS' ? 0 : r.status === 'FAIL' ? 1 : 2;
