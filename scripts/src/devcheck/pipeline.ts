// One dev-check run, every side effect injected (pipeline.test.ts drives it with fakes):
//   run-start → deploy-wait → sign in → sweep earlier runs' leftovers → in-page build check → scenarios
//   → finally: cleanup by ledger id, verify nothing's left, dev's build unchanged → report → run-end.
// Cleanup runs whatever happened before it. Exit: 0 PASS, 1 FAIL (any reason code), 2 CRASH.
import type { ApiClient } from './api';
import type { DeployRun } from './deploy';
import { parseMarker } from './deploy';
import { DevcheckError, codeOf, type ReasonCode } from './errors';
import { orphanIntents, pendingIds, type Ledger } from './ledger';
import { idsFromCreateResponse, methodOf } from './recorder';
import type { CreatedRecord, RunResult, StepResult } from './report';
import type { PwPage, PwResponse } from './pw-types';
import { createUi, datesFor, makeShot, type Ctx, type Scenario } from './scenario';
import type { Session } from './token';

export interface BrowserSession {
  page: PwPage;
  signIn(shot: (name: string) => Promise<void>): Promise<Session>;
  readSession(): Promise<Session | null>;
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
  const pendingRecords: Promise<void>[] = [];
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
    page.on('response', (res) => pendingRecords.push(record(res)));
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

    r.startSha = parseMarker(await d.fetchShell());
    let inPage: string | undefined;
    for (let i = 0; i <= IN_PAGE_RELOADS; i++) {
      inPage = await page.evaluate<string | undefined>(
        `document.querySelector('meta[name="aperture-build"]')?.content`,
      );
      if (inPage === d.expectedSha) break;
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

  async function record(res: PwResponse): Promise<void> {
    if (res.request().method() !== 'POST' || res.status() !== 200) return;
    const method = methodOf(res.url());
    if (!method) return;
    const ids = idsFromCreateResponse(method, await res.json().catch(() => null));
    for (const id of ids) {
      if (runIds.includes(id)) continue;
      runIds.push(id);
      d.ledger.append({ run: d.runId, op: 'created', id, via: `ui:${method}` });
    }
  }

  async function cleanup(): Promise<void> {
    const entries = d.ledger.read();
    r.orphanIntents = orphanIntents(entries.filter((e) => e.run === d.runId)).map(
      (e) => `${e.via} "${e.title ?? ''}"`,
    );
    if (r.orphanIntents.length) fail('LEFTOVERS');
    const mine = entries.filter((e) => e.run === d.runId && e.op === 'created' && e.id);
    if (!api) {
      // Never signed in: nothing of this run can exist; earlier leftovers wait for the next run.
      if (mine.length) fail('LEFTOVERS');
      return;
    }
    // The token may have renewed in the page since sign-in.
    const fresh = await browser?.readSession().catch(() => null);
    if (fresh) session = fresh;

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
    if (r.created.some((c) => c.final === 'left')) fail('LEFTOVERS');

    const known = new Set(after.filter((e) => e.id).map((e) => e.id!));
    const visible = [...(await api.reads.listTasks()), ...(await api.reads.listBacklog())];
    r.unrecorded = [...new Set(visible.map((t) => t.id))].filter((id) => !known.has(id));

    if (r.startSha) {
      r.endSha = parseMarker(await d.fetchShell());
      if (r.endSha !== r.startSha) fail('DEV_CHANGED_MID_RUN');
    }
  }
}

export const exitCode = (r: RunResult): number =>
  r.status === 'PASS' ? 0 : r.status === 'FAIL' ? 1 : 2;
