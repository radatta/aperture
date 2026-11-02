import { describe, expect, it } from 'vitest';
import { FLUX_SET_VIA, type ApiClient, type DevFluxSet, type DevTask } from './api';
import { DevcheckError } from './errors';
import type { Ledger, LedgerEntry } from './ledger';
import { exitCode, runPipeline, type BrowserSession, type PipelineDeps } from './pipeline';
import type { PwPage, PwRequest, PwResponse } from './pw-types';
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

// A fake dev backend: a task store the API reads/deletes, and a page that "creates" by emitting a request
// whose response arrives when `respond` says (immediately by default).
function world(opts: { inPage?: string[]; shells?: string[]; existing?: string[] } = {}) {
  const tasks = new Map<string, DevTask>(
    (opts.existing ?? []).map((id) => [id, { id, title: id }]),
  );
  const deleted: string[] = [];
  const fluxSets = new Map<string, DevFluxSet>();
  const fluxDeleted: string[] = [];
  const listeners: ((r: PwRequest) => void)[] = [];
  const responseListeners: ((r: PwResponse) => void)[] = [];
  const inPage = [...(opts.inPage ?? [SHA])];
  let n = 0;
  const page = {
    on: (ev: string, fn: (r: never) => void) =>
      void (ev === 'request'
        ? listeners.push(fn as (r: PwRequest) => void)
        : ev === 'response' && responseListeners.push(fn as (r: PwResponse) => void)),
    evaluate: async (expr: string) =>
      expr.includes('aperture-build') ? (inPage.length > 1 ? inPage.shift() : inPage[0]) : null,
    reload: async () => undefined,
    screenshot: async () => undefined,
    locator: () => ({}),
    getByRole: () => ({}),
    getByText: () => ({}),
  } as unknown as PwPage;
  const uiCreate = (title: string, respond: Promise<void> | 'never' = Promise.resolve()) => {
    const id = `t${++n}`;
    tasks.set(id, { id, title });
    const url = 'https://dev.aperture.rahuldatta.dev/api/createTask';
    const res = {
      url: () => url,
      status: () => 200,
      request: () => ({ method: () => 'POST' }),
      json: async () => ({ id }),
    };
    const req = {
      url: () => url,
      method: () => 'POST',
      response: () =>
        respond === 'never' ? new Promise<never>(() => undefined) : respond.then(() => res),
    };
    for (const l of listeners) l(req);
    return id;
  };
  // A response the page got with `status` (a throttled call: 429).
  const respond = (path: string, status: number) => {
    const res = {
      url: () =>
        path.startsWith('https://') ? path : `https://dev.aperture.rahuldatta.dev${path}`,
      status: () => status,
      request: () => ({ method: () => 'POST' }),
      json: async () => ({}),
    };
    for (const l of responseListeners) l(res);
  };
  const api: ApiClient = {
    reads: {
      listTasks: async () => [...tasks.values()],
      listBacklog: async () => [],
      getSettings: async () => ({ dayStartHour: 4 }),
      getTask: async (id) => tasks.get(id) ?? null,
      listCategories: async () => [],
      listFluxSets: async () => [...fluxSets.values()],
      getFluxSet: async (id) => fluxSets.get(id) ?? null,
      listAttachments: async () => [],
      getAttachmentDownloadUrl: async () => {
        throw new Error('unused');
      },
      probePresigned: async () => {
        throw new Error('unused');
      },
    },
    writes: {
      createTask: async () => {
        throw new Error('unused');
      },
      recordFluxSet: async () => {
        throw new Error('unused');
      },
      createAttachment: async () => {
        throw new Error('unused');
      },
      deleteAttachment: async () => {
        throw new Error('unused');
      },
      deleteFluxSet: async (id) => {
        fluxDeleted.push(id);
        fluxSets.delete(id);
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
    fluxSets,
    fluxDeleted,
    uiCreate,
    respond,
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
    rows: [],
    steps: runs.map((run, i) => ({
      id: `s${i}`,
      title: `step ${i}`,
      entry: 'api',
      run: () => run(w),
    })),
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

  it('records every 429 by method (or path), and nothing else', async () => {
    const w = world();
    const sc = scenario(async (x) => {
      x.respond('/api/listTasks', 429);
      x.respond('/api/getDay', 200);
      x.respond('/assets/index.js', 429);
      x.respond('/api/getDay', 429);
      x.respond('https://cdn.example.com/api/listTasks', 429);
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.throttled).toEqual([
      '/api/listTasks',
      '/assets/index.js',
      '/api/getDay',
      'cdn.example.com/api/listTasks',
    ]);
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

  it('a create still in flight when its step fails is waited for and cleaned up', async () => {
    const w = world();
    let answer!: () => void;
    const late = new Promise<void>((res) => (answer = res));
    const sc = scenario(async (x) => {
      x.uiCreate('slow', late);
      setTimeout(answer, 5); // the response lands after the step has already thrown
      throw new Error('step timed out');
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.created.map((c) => [c.id, c.final])).toEqual([['t1', 'deleted']]);
    expect(w.tasks.size).toBe(0);
  });

  it('a create that never answers is a possible leak — LEFTOVERS', async () => {
    const w = world();
    const sc = scenario(async (x) => void x.uiCreate('lost', 'never'))(w);
    const r = await runPipeline(deps(w, [sc], memLedger(), { responseWaitMs: 5 }));
    expect(r.orphanIntents).toEqual(['ui:createTask sent, no response within the wait']);
    expect(r.codes).toContain('LEFTOVERS');
  });

  it('a task that appears during the run without a ledger entry fails it, and is not deleted', async () => {
    const w = world();
    const sc = scenario(
      async (x) => void x.tasks.set('ghost', { id: 'ghost', title: 'from getDay' }),
    )(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.appeared).toEqual(['ghost']);
    expect(r.codes).toEqual(['LEFTOVERS']);
    expect(w.deleted).toEqual([]);
  });

  it('a page session that is no longer the test user stops cleanup with WRONG_USER', async () => {
    const w = world();
    w.browser.readSession = async () => Promise.reject(new DevcheckError('WRONG_USER', 'x'));
    const r = await runPipeline(deps(w, [scenario(async (x) => void x.uiCreate('a'))(w)]));
    expect(r.codes).toContain('WRONG_USER');
    expect(w.deleted).toEqual([]);
  });

  it('a swept id that survives its delete is a leftover', async () => {
    const w = world({ existing: ['old1'] });
    w.api.writes.deleteTask = async () => undefined;
    const ledger = memLedger([{ run: 'run0', op: 'created', id: 'old1' }]);
    const r = await runPipeline(deps(w, [], ledger));
    expect(r.created).toEqual([{ id: 'old1', via: 'swept', final: 'left' }]);
    expect(r.codes).toEqual(['LEFTOVERS']);
  });

  it("never deletes a task whose server-side parts the ledger doesn't know — the cascade would take them", async () => {
    const w = world();
    const sc = scenario(async (x) => {
      const id = x.uiCreate('parent');
      x.tasks.set('users-part', { id: 'users-part', title: 'mine', parentId: id }); // attached outside the ledger
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(w.deleted).toEqual([]);
    expect(r.blockedDeletes).toEqual(['t1 (unrecorded parts: users-part)']);
    expect(r.codes).toContain('LEFTOVERS');
  });

  it('the sweep also refuses to delete a leftover that has unrecorded parts', async () => {
    const w = world({ existing: ['old1'] });
    w.tasks.set('users-part', { id: 'users-part', title: 'mine', parentId: 'old1' });
    const ledger = memLedger([{ run: 'run0', op: 'created', id: 'old1' }]);
    const r = await runPipeline(deps(w, [], ledger));
    expect(w.deleted).toEqual([]);
    expect(r.swept).toEqual([]);
    expect(r.blockedDeletes).toEqual(['old1 (unrecorded parts: users-part)']);
    expect(r.codes).toContain('LEFTOVERS');
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

  it('a Flux set in the ledger is read back and deleted as a Flux set, never as a task', async () => {
    // A crashed earlier run's set: getTask would say "gone" (no such task) and leave it on dev.
    const w = world();
    w.fluxSets.set('fx-old', {
      id: 'fx-old',
      day: '2026-10-20',
      exerciseId: 'chin-tuck',
      count: 10,
    });
    const ledger = memLedger([{ run: 'run0', op: 'created', id: 'fx-old', via: FLUX_SET_VIA }]);
    // And this run's own set, recorded by a scenario.
    const sc = scenario(async (x) => {
      ledger.append({ run: 'run1', op: 'created', id: 'fx-new', via: FLUX_SET_VIA });
      x.fluxSets.set('fx-new', {
        id: 'fx-new',
        day: '2026-10-21',
        exerciseId: 'chin-tuck',
        count: 10,
      });
    })(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(w.fluxDeleted).toEqual(['fx-old', 'fx-new']);
    expect(w.deleted).toEqual([]);
    expect(r.swept).toEqual(['fx-old']);
    expect(r.created).toEqual([
      { id: 'fx-new', via: FLUX_SET_VIA, title: undefined, final: 'deleted' },
    ]);
    expect(r.status).toBe('PASS');
  });

  it('reloads until the page shows the expected build; BUILD_MISMATCH_IN_PAGE if it never does', async () => {
    const ok = await runPipeline(deps(world({ inPage: ['old', 'old', SHA] }), []));
    expect(ok.status).toBe('PASS');
    let reloads = 0;
    const w = world({ inPage: ['old'] });
    w.browser.page.reload = async () => void reloads++;
    const bad = await runPipeline(deps(w, []));
    expect(bad.codes).toEqual(['BUILD_MISMATCH_IN_PAGE']);
    expect(reloads).toBe(3);
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

  it('scores each row from its steps: pass, fail, skipped after a failure; declared rows keep their status', async () => {
    const w = world();
    const sc: Scenario = {
      ...scenario(
        async () => undefined,
        async () => {
          throw new Error('boom');
        },
        async () => undefined,
      )(w),
      rows: [
        { id: 'a', entry: 'api', kind: 'nominal', what: 'A' },
        { id: 'b', entry: 'api', kind: 'edge', what: 'B' },
        { id: 'c', entry: 'api', kind: 'edge', what: 'C' },
        { id: 'y', entry: 'ios', kind: 'nominal', what: 'Y', needsYou: 'iOS Safari' },
      ],
    };
    sc.steps[0]!.proves = ['a'];
    sc.steps[1]!.proves = ['b'];
    sc.steps[2]!.proves = ['c'];
    const r = await runPipeline(deps(w, [sc]));
    expect(r.coverage.map((x) => [x.row, x.status, x.failedSteps])).toEqual([
      ['a', 'pass', undefined],
      ['b', 'fail', ['s1']],
      ['c', 'skipped', undefined],
      ['y', 'needs-you', undefined],
    ]);
  });

  it('a setup failure leaves every step-proven row skipped — never proven', async () => {
    const w = world({ inPage: ['old'] });
    const sc: Scenario = {
      ...scenario(async () => undefined)(w),
      rows: [{ id: 'a', entry: 'api', kind: 'nominal', what: 'A' }],
    };
    sc.steps[0]!.proves = ['a'];
    const r = await runPipeline(deps(w, [sc]));
    expect(r.codes).toEqual(['BUILD_MISMATCH_IN_PAGE']);
    expect(r.coverage.map((x) => x.status)).toEqual(['skipped']);
  });

  it('rows are scored after cleanup: a build change mid-run leaves a passing row unproven', async () => {
    const w = world({ shells: [shell(SHA), shell('b'.repeat(40))] });
    const sc: Scenario = {
      ...scenario(async () => undefined)(w),
      rows: [{ id: 'a', entry: 'api', kind: 'nominal', what: 'A' }],
    };
    sc.steps[0]!.proves = ['a'];
    const r = await runPipeline(deps(w, [sc]));
    expect(r.codes).toEqual(['DEV_CHANGED_MID_RUN']);
    expect(r.steps[0]!.status).toBe('pass');
    expect(r.coverage[0]).toMatchObject({ status: 'skipped', note: 'dev’s build changed mid-run' });
  });

  it('carries the feature ids into the result, [] when none', async () => {
    expect(
      (await runPipeline(deps(world(), [], memLedger(), { feature: ['sc'] }))).feature,
    ).toEqual(['sc']);
    expect((await runPipeline(deps(world(), []))).feature).toEqual([]);
  });

  it('carries the scenarios’ commit into the result', async () => {
    const r = await runPipeline(deps(world(), [], memLedger(), { scenarioSha: 'b'.repeat(40) }));
    expect(r.scenarioSha).toBe('b'.repeat(40));
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
