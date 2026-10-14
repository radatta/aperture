import { describe, expect, it } from 'vitest';
import type { ApiClient, DevTask } from './api';
import { DevcheckError } from './errors';
import type { Ledger, LedgerEntry } from './ledger';
import { exitCode, runPipeline, type BrowserSession, type PipelineDeps } from './pipeline';
import type { PwPage, PwResponse } from './pw-types';
import type { Scenario } from './scenario';

const SHA = 'a'.repeat(40);
const shell = (sha: string) => `<meta name="aperture-build" content="${sha}" />`;

function memLedger(initial: Omit<LedgerEntry, 't'>[] = []): Ledger & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = initial.map((e) => ({ t: '', ...e }));
  return {
    entries,
    append: (x) => void entries.push({ t: '', ...x }),
    read: () => [...entries],
    has: (id) => entries.some((x) => x.op === 'created' && x.id === id),
  };
}

// A fake dev backend: a task store the API reads/deletes, and a page that "creates" by emitting a response.
function world(opts: { inPage?: string[]; shells?: string[]; existing?: string[] } = {}) {
  const tasks = new Map<string, DevTask>(
    (opts.existing ?? []).map((id) => [id, { id, title: id }]),
  );
  const deleted: string[] = [];
  const listeners: ((r: PwResponse) => void)[] = [];
  const inPage = [...(opts.inPage ?? [SHA])];
  let n = 0;
  const page = {
    on: (ev: string, fn: (r: PwResponse) => void) => void (ev === 'response' && listeners.push(fn)),
    evaluate: async (expr: string) =>
      expr.includes('aperture-build') ? (inPage.length > 1 ? inPage.shift() : inPage[0]) : null,
    reload: async () => undefined,
    screenshot: async () => undefined,
    locator: () => ({}),
    getByRole: () => ({}),
    getByText: () => ({}),
  } as unknown as PwPage;
  const uiCreate = (title: string) => {
    const id = `t${++n}`;
    tasks.set(id, { id, title });
    const res = {
      url: () => 'https://dev.aperture.rahuldatta.dev/api/createTask',
      status: () => 200,
      request: () => ({ method: () => 'POST' }),
      json: async () => ({ id }),
    };
    for (const l of listeners) l(res);
    return id;
  };
  const api: ApiClient = {
    reads: {
      listTasks: async () => [...tasks.values()],
      listBacklog: async () => [],
      getTask: async (id) => tasks.get(id) ?? null,
      listCategories: async () => [],
    },
    writes: {
      createTask: async () => {
        throw new Error('unused');
      },
      deleteTask: async (id) => {
        deleted.push(id);
        tasks.delete(id);
      },
    },
  };
  const shells = [...(opts.shells ?? [shell(SHA)])];
  const browser: BrowserSession = {
    page,
    signIn: async () => ({ accessToken: 'tok', expiresAt: 0, email: 'x', sub: 's' }),
    readSession: async () => null,
    close: async () => undefined,
  };
  return {
    tasks,
    deleted,
    uiCreate,
    api,
    browser,
    fetchShell: async () => (shells.length > 1 ? shells.shift()! : shells[0]!),
  };
}

function deps(
  w: ReturnType<typeof world>,
  scenarios: Scenario[],
  ledger = memLedger(),
  over: Partial<PipelineDeps> = {},
): PipelineDeps {
  let t = 0;
  return {
    runId: 'run1',
    tier: 'full',
    expectedSha: SHA,
    scenarios,
    ledger,
    shotsDir: '/nonexistent',
    fetchShell: w.fetchShell,
    openBrowser: async () => w.browser,
    makeApi: () => w.api,
    now: () => (t += 10),
    log: () => undefined,
    ...over,
  };
}

const scenario =
  (...runs: ((w: ReturnType<typeof world>) => Promise<void>)[]) =>
  (w: ReturnType<typeof world>): Scenario => ({
    id: 'sc',
    title: 'sc',
    tiers: ['full'],
    steps: runs.map((run, i) => ({ id: `s${i}`, title: `step ${i}`, run: () => run(w) })),
  });

describe('runPipeline', () => {
  it('PASS: records UI-created ids, deletes them, verifies none left', async () => {
    const w = world();
    const ledger = memLedger();
    const r = await runPipeline(deps(w, [scenario(async (x) => void x.uiCreate('a'))(w)], ledger));
    expect(r.status).toBe('PASS');
    expect(r.created).toEqual([
      { id: 't1', via: 'ui:createTask', title: undefined, final: 'deleted' },
    ]);
    expect(w.tasks.size).toBe(0);
    expect(ledger.entries.map((e) => e.op)).toEqual(['run-start', 'created', 'deleted', 'run-end']);
    expect(exitCode(r)).toBe(0);
  });

  it('a failed step skips the rest of its scenario, and cleanup still runs', async () => {
    const w = world();
    const sc = scenario(
      async (x) => void x.uiCreate('a'),
      async () => {
        throw new Error('boom');
      },
      async (x) => void x.uiCreate('never'),
    )(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.steps.map((s) => s.status)).toEqual(['pass', 'fail', 'skipped']);
    expect(r.status).toBe('FAIL');
    expect(r.codes).toEqual(['STEP_FAILED']);
    expect(w.deleted).toEqual(['t1']);
    expect(exitCode(r)).toBe(1);
  });

  it('a task gone before cleanup (deleted with its parent) is "gone", not a leftover', async () => {
    const w = world();
    const r = await runPipeline(
      deps(w, [
        scenario(async (x) => {
          const id = x.uiCreate('part');
          x.tasks.delete(id);
        })(w),
      ]),
    );
    expect(r.status).toBe('PASS');
    expect(r.created[0]!.final).toBe('gone');
    expect(w.deleted).toEqual([]);
  });

  it('LEFTOVERS when a delete does not take', async () => {
    const w = world();
    w.api.writes.deleteTask = async () => undefined; // server ignores it
    const r = await runPipeline(deps(w, [scenario(async (x) => void x.uiCreate('a'))(w)]));
    expect(r.codes).toContain('LEFTOVERS');
    expect(r.created[0]!.final).toBe('left');
  });

  it('sweeps a crashed earlier run before the scenarios, and never touches unrecorded tasks', async () => {
    const w = world({ existing: ['old1', 'users-own'] });
    const ledger = memLedger([{ run: 'run0', op: 'created', id: 'old1' }]);
    const r = await runPipeline(deps(w, [], ledger));
    expect(r.swept).toEqual(['old1']);
    expect(w.deleted).toEqual(['old1']);
    expect(r.unrecorded).toEqual(['users-own']);
    expect(r.status).toBe('PASS');
  });

  it('reloads until the page shows the expected build; BUILD_MISMATCH_IN_PAGE if it never does', async () => {
    const ok = await runPipeline(deps(world({ inPage: ['old', 'old', SHA] }), []));
    expect(ok.status).toBe('PASS');
    const bad = await runPipeline(deps(world({ inPage: ['old'] }), []));
    expect(bad.codes).toEqual(['BUILD_MISMATCH_IN_PAGE']);
  });

  it('DEV_CHANGED_MID_RUN when the edge build differs at the end', async () => {
    const w = world({ shells: [shell(SHA), shell('b'.repeat(40))] });
    const r = await runPipeline(deps(w, []));
    expect(r.codes).toEqual(['DEV_CHANGED_MID_RUN']);
  });

  it('a setup DevcheckError is a FAIL with its code; anything else is a CRASH (exit 2)', async () => {
    const w = world();
    const fail = await runPipeline(
      deps(w, [], memLedger(), {
        waitForDeploy: async () => Promise.reject(new DevcheckError('DEPLOY_FAILED', 'x')),
      }),
    );
    expect([fail.status, fail.codes]).toEqual(['FAIL', ['DEPLOY_FAILED']]);
    const crash = await runPipeline(
      deps(w, [], memLedger(), {
        openBrowser: async () => Promise.reject(new Error('chromium died')),
      }),
    );
    expect(crash.status).toBe('CRASH');
    expect(exitCode(crash)).toBe(2);
  });

  it('a create whose response never arrived after an API intent is reported as a possible leak', async () => {
    const w = world();
    const ledger = memLedger();
    const sc = scenario(
      async () =>
        void ledger.append({ run: 'run1', op: 'intent', via: 'api:createTask', title: 'x' }),
    )(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(r.orphanIntents).toEqual(['api:createTask "x"']);
    expect(r.codes).toContain('LEFTOVERS');
  });
});
