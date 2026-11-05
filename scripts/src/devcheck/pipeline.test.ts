import { describe, expect, it, vi } from 'vitest';
import {
  FINANCE_BUCKET_VIA,
  FINANCE_LINK_VIA,
  FINANCE_RULE_VIA,
  FLUX_SET_VIA,
  CATEGORY_VIA,
  PLACE_TOKEN_VIA,
  PUSH_SUB_VIA,
  type ApiClient,
  type DevCategory,
  type DevFinanceRule,
  type DevFinanceTransaction,
  type DevFluxSet,
  type DevPlace,
  type DevTask,
} from './api';
import { DevcheckError } from './errors';
import type { Ledger, LedgerEntry } from './ledger';
import { IOS_NOTE, type Ios } from './ios';
import {
  DEFER_NOTE,
  exitCode,
  runPipeline,
  type BrowserSession,
  type PipelineDeps,
} from './pipeline';
import { statusLine } from './report';
import type { McpClient } from './mcp';
import type { PwPage, PwRequest, PwResponse, PwRoute } from './pw-types';
import { hidingSecret, needsYou, type Ctx, type Scenario } from './scenario';

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
  let settings = {
    dayStartHour: 4,
    pomodoroWorkMin: 25,
    fluxSets: {},
    remindTimed: true,
    remindDueDay: true,
    remindPlanned: true,
  };
  const tasks = new Map<string, DevTask>(
    (opts.existing ?? []).map((id) => [id, { id, title: id }]),
  );
  const deleted: string[] = [];
  const fluxSets = new Map<string, DevFluxSet>();
  const fluxDeleted: string[] = [];
  const places = new Map<string, DevPlace>();
  const placesDeleted: string[] = [];
  const categories = new Map<string, DevCategory>();
  const categoriesDeleted: string[] = [];
  const placeToken = { active: false, revokes: 0 };
  // The fixture bank's rows and the run's rules: cleanup clears a bucket / a link, deletes a rule.
  const finance = {
    rows: new Map<string, DevFinanceTransaction>(),
    rules: new Map<string, DevFinanceRule>(),
    unset: [] as string[],
    unlinked: [] as string[],
    rulesDeleted: [] as string[],
  };
  const pushDevices = new Set<string>();
  const pushRemoved: string[] = [];
  const listeners: ((r: PwRequest) => void)[] = [];
  const responseListeners: ((r: PwResponse) => void)[] = [];
  const consoleListeners: ((m: { type(): string; text(): string }) => void)[] = [];
  const failedListeners: ((r: PwRequest) => void)[] = [];
  type Match = (u: URL) => boolean;
  type Handler = (r: PwRoute) => Promise<void> | void;
  const routes: { match: Match; handler: Handler }[] = [];
  const inPage = [...(opts.inPage ?? [SHA])];
  const gotos: string[] = [];
  let n = 0;
  const page = {
    on: (ev: string, fn: (r: never) => void) =>
      void (ev === 'request'
        ? listeners.push(fn as (r: PwRequest) => void)
        : ev === 'response'
          ? responseListeners.push(fn as (r: PwResponse) => void)
          : ev === 'requestfailed'
            ? failedListeners.push(fn as (r: PwRequest) => void)
            : ev === 'console' && consoleListeners.push(fn as never)),
    route: async (match: Match, handler: Handler) => void routes.push({ match, handler }),
    unroute: async (match: Match, handler: Handler) => {
      const i = routes.findIndex((x) => x.match === match && x.handler === handler);
      if (i >= 0) routes.splice(i, 1);
    },
    evaluate: async (expr: string) =>
      expr.includes('aperture-build') ? (inPage.length > 1 ? inPage.shift() : inPage[0]) : null,
    reload: async () => undefined,
    goto: async (url: string) => void gotos.push(url),
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
      postData: () => JSON.stringify({ args: [{ title }] }),
      response: () =>
        respond === 'never' ? new Promise<never>(() => undefined) : respond.then(() => res),
    };
    for (const l of listeners) l(req);
    return id;
  };
  // Settings' Add (no id: a create) or a row's rename (an id: an edit) — the browser's upsertPlace.
  const uiPlace = (name: string, editId?: string) => {
    const id = editId ?? `p${++n}`;
    places.set(id, { id, name, slug: name.toLowerCase(), lastReadAt: null });
    const url = 'https://dev.aperture.rahuldatta.dev/api/upsertPlace';
    const res = {
      url: () => url,
      status: () => 200,
      request: () => ({ method: () => 'POST' }),
      json: async () => places.get(id),
    };
    const req = {
      url: () => url,
      method: () => 'POST',
      postData: () => JSON.stringify({ args: [editId ? { id: editId, name } : { name }] }),
      response: async () => res,
    };
    for (const l of listeners) l(req);
    return id;
  };
  // A response the page got with `status` (a throttled call: 429).
  const respond = (
    path: string,
    status: number,
    request: { method(): string } = { method: () => 'POST' },
  ) => {
    const res = {
      url: () =>
        path.startsWith('https://') ? path : `https://dev.aperture.rahuldatta.dev${path}`,
      status: () => status,
      request: () => request,
      json: async () => ({}),
    };
    for (const l of responseListeners) l(res);
  };
  // A request that never got a response (`errorText` as Chromium names it).
  const requestFailed = (path: string, errorText: string, method = 'GET') => {
    const url = path.startsWith('https://') ? path : `https://dev.aperture.rahuldatta.dev${path}`;
    const req = {
      url: () => url,
      method: () => method,
      postData: () => null,
      response: async () => null,
      failure: () => ({ errorText }),
    };
    for (const l of failedListeners) l(req);
  };
  // The page's console printing an error line.
  const consoleError = (text: string) => {
    for (const l of consoleListeners) l({ type: () => 'error', text: () => text });
  };
  // The app calling /api/<method>: the first matching route decides; a fulfilled 429 also reaches the
  // response listeners, as a real one would.
  const injectedBodies: (string | undefined)[] = [];
  const call = async (method: string): Promise<number | 'real' | 'dropped'> => {
    const url = `https://dev.aperture.rahuldatta.dev/api/${method}`;
    const hit = [...routes].reverse().find((x) => x.match(new URL(url))); // Playwright: last registered wins
    if (!hit) return 'real';
    let out: number | 'real' | 'dropped' = 'real';
    const request = {
      url: () => url,
      method: () => 'POST',
      postData: () => null,
      response: async () => null,
    };
    await hit.handler({
      request: () => request,
      continue: async () => void (out = 'real'),
      fallback: async () => void (out = 'real'),
      abort: async () => {
        out = 'dropped';
        // Playwright fails the route's own request object: the one the harness marked as injected.
        const failed = Object.assign(request, {
          failure: () => ({ errorText: 'net::ERR_FAILED' }),
        });
        for (const l of failedListeners) l(failed);
      },
      fulfill: async ({ status, body }) => {
        out = status;
        injectedBodies.push(body);
        respond(`/api/${method}`, status, request);
      },
    });
    return out;
  };
  const api: ApiClient = {
    reads: {
      listTasks: async () => [...tasks.values()],
      listBacklog: async () => [],
      getSettings: async () => settings,
      getFluxWeekNote: async () => null,
      listRunningSessions: async () => [],
      listSessionsForDay: async () => [],
      getTask: async (id) => tasks.get(id) ?? null,
      listCategories: async () => [...categories.values()],
      listPlansForDay: async () => [],
      listHabits: async () => [],
      listHabitChecks: async () => [],
      getDay: async () => {
        throw new Error('unused');
      },
      listFluxSets: async () => [...fluxSets.values()],
      getFluxSet: async (id) => fluxSets.get(id) ?? null,
      listAttachments: async () => [],
      getAttachmentDownloadUrl: async () => {
        throw new Error('unused');
      },
      listSeries: async () => [],
      probePresigned: async () => {
        throw new Error('unused');
      },
      listPlaces: async () => [...places.values()],
      listPlaceTasks: async () => {
        throw new Error('unused');
      },
      getPlaceTokenStatus: async () => ({
        active: placeToken.active,
        createdAt: null,
        lastUsedAt: null,
        hint: null,
        readsToday: 0,
      }),
      getPushStatus: async () => ({
        configured: true,
        vapidPublicKey: 'B',
        devices: [...pushDevices].map((id) => ({
          id,
          label: 'x',
          createdAt: 0,
          lastOkAt: null,
          lastError: null,
          lastErrorAt: null,
        })),
        removedDeviceIds: [...pushRemoved],
        poller: { lastRunAt: null, lastSentAt: null, lastError: null, lastErrorAt: null },
      }),
      getCalibration: async () => [],
      placeDigestRaw: async () => {
        throw new Error('unused');
      },
      listFinanceTransactions: async () => [...finance.rows.values()],
      getFinanceTransaction: async (id) => finance.rows.get(id) ?? null,
      listFinanceRules: async () => [...finance.rules.values()],
    },
    writes: {
      updateSettings: async (patch) => {
        settings = { ...settings, ...patch };
        return settings;
      },
      stopSession: async () => {
        throw new Error('unused');
      },
      createTask: async () => {
        throw new Error('unused');
      },
      startSession: async () => {
        throw new Error('unused');
      },
      recordFluxSet: async () => {
        throw new Error('unused');
      },
      setTaskActual: async () => {
        throw new Error('unused');
      },
      recordPlaceTokenMint: () => {
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
      upsertPlan: async () => {
        throw new Error('unused');
      },
      removePlan: async () => {
        throw new Error('unused');
      },
      transitionTask: async () => {
        throw new Error('unused');
      },
      upsertHabit: async () => {
        throw new Error('unused');
      },
      archiveHabit: async () => {
        throw new Error('unused');
      },
      checkHabit: async () => {
        throw new Error('unused');
      },
      uncheckHabit: async () => {
        throw new Error('unused');
      },
      setDayCapacity: async () => {
        throw new Error('unused');
      },
      setDayIntent: async () => {
        throw new Error('unused');
      },
      createSeries: async () => {
        throw new Error('unused');
      },
      deleteSeries: async () => {
        throw new Error('unused');
      },
      upsertPlace: async () => {
        throw new Error('unused');
      },
      deletePlace: async (id) => {
        placesDeleted.push(id);
        places.delete(id);
      },
      rotatePlaceToken: async () => {
        throw new Error('unused');
      },
      revokePlaceToken: async () => {
        placeToken.revokes++;
        placeToken.active = false;
      },
      recordFinanceBucket: () => {
        throw new Error('unused');
      },
      recordFinanceLink: () => {
        throw new Error('unused');
      },
      unsetFinanceBucket: async (id) => {
        finance.unset.push(id);
        const row = finance.rows.get(id.split(':')[2]!);
        if (row) row.bucket = null;
      },
      unlinkFinanceRefund: async (id) => {
        finance.unlinked.push(id);
        const row = finance.rows.get(id.split(':')[2]!);
        if (row) row.refundOfId = null;
      },
      upsertFinanceRule: async () => {
        throw new Error('unused');
      },
      deleteFinanceRule: async (id) => {
        finance.rulesDeleted.push(id);
        finance.rules.delete(id);
      },
      upsertCategory: async () => {
        throw new Error('unused');
      },
      setCategoryArea: async () => {
        throw new Error('unused');
      },
      deleteCategory: async (id) => {
        categoriesDeleted.push(id);
        categories.delete(id);
      },
      subscribePush: async () => {
        throw new Error('unused');
      },
      unsubscribePush: async (id) => {
        pushDevices.delete(id);
        pushRemoved.push(id);
      },
      sendTestPush: async () => {
        throw new Error('unused');
      },
      setReminderSettings: async () => {
        throw new Error('unused');
      },
    },
  };
  const shells = [...(opts.shells ?? [shell(SHA)])];
  const browser: BrowserSession = {
    page,
    signIn: async () => ({ accessToken: 'tok', expiresAt: 0, email: 'x', sub: 's' }),
    readSession: async () => null,
    // Far from expiry; a test overrides it to check the MCP sign-in's failure path.
    signInMcp: async () => ({
      accessToken: 'mcp',
      expiresAt: 1e10,
      email: 'x',
      sub: 's',
      clientId: 'claude',
    }),
    close: async () => undefined,
  };
  // A fake MCP client whose one read reads the token, so an expired token fails the step that uses it.
  const mcp = (token: () => string) =>
    ({
      reads: { toolsList: async () => [token()] },
      writes: {},
    }) as unknown as McpClient;
  return {
    tasks,
    deleted,
    fluxSets,
    categories,
    categoriesDeleted,
    fluxDeleted,
    places,
    placesDeleted,
    placeToken,
    finance,
    pushDevices,
    pushRemoved,
    uiCreate,
    uiPlace,
    respond,
    requestFailed,
    consoleError,
    call,
    injectedBodies,
    routes,
    gotos,
    api,
    mcp,
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
    makeMcp: w.mcp,
    now: () => (t += 10),
    log: () => undefined,
    ...over,
  };
}

const scenario =
  (...runs: ((w: ReturnType<typeof world>, ctx: Ctx) => Promise<void>)[]) =>
  (w: ReturnType<typeof world>): Scenario => ({
    id: 'sc',
    title: 'sc',
    tiers: ['full'],
    rows: [],
    steps: runs.map((run, i) => ({
      id: `s${i}`,
      title: `step ${i}`,
      entry: 'api',
      run: (ctx) => run(w, ctx),
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

  it('a leftover short work block from a killed run is put back before any step', async () => {
    const w = world();
    await w.api.writes.updateSettings({ pomodoroWorkMin: 1 });
    let seen = 0;
    const s = scenario(async () => {
      seen = (await w.api.reads.getSettings()).pomodoroWorkMin;
    })(w);
    await runPipeline(deps(w, [s], memLedger()));
    expect(seen).toBe(25);
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
    expect(r.failures).toEqual([]);
    expect(w.deleted).toEqual(['t1']);
    expect(exitCode(r)).toBe(1);
  });

  it('a failed step is shot — unless it failed with a secret on screen (hidingSecret): blanked, no shot', async () => {
    const w = world();
    const plain = scenario(async () => {
      throw new Error('boom');
    })(w);
    const secret = {
      ...scenario(async (_x, ctx) =>
        hidingSecret(ctx.page, async () => {
          throw new Error('the reveal never closed');
        }),
      )(w),
      id: 'sc2',
    };
    const r = await runPipeline(deps(w, [plain, secret]));
    expect(r.steps.map((s) => [s.scenario, s.status, s.error])).toEqual([
      ['sc', 'fail', 'boom'],
      ['sc2', 'fail', 'the reveal never closed'],
    ]);
    expect(r.steps[0]!.shot).toBe('sc-s0-fail-light.png');
    expect(r.steps[1]!.shot).toBeUndefined();
    expect(r.shots.filter((f) => f.startsWith('sc2-'))).toEqual([]);
    expect(w.gotos).toEqual(['about:blank']);
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
    expect(r.failures).toEqual([
      {
        code: 'LEFTOVERS',
        message: 'create sent, id never recorded: ui:createTask sent, no response within the wait',
      },
      { code: 'LEFTOVERS', message: 'appeared during the run, not in the ledger: t1' }, // the one that landed
    ]);
  });

  it('a task that appears during the run without a ledger entry fails it, and is not deleted', async () => {
    const w = world();
    const sc = scenario(
      async (x) => void x.tasks.set('ghost', { id: 'ghost', title: 'from getDay' }),
    )(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.appeared).toEqual(['ghost']);
    expect(r.codes).toEqual(['LEFTOVERS']);
    expect(r.failures).toEqual([
      { code: 'LEFTOVERS', message: 'appeared during the run, not in the ledger: ghost' },
    ]);
    expect(w.deleted).toEqual([]);
  });

  it('a page session that is no longer the test user stops cleanup with WRONG_USER', async () => {
    const w = world();
    let ran = false;
    w.browser.readSession = async () =>
      ran ? Promise.reject(new DevcheckError('WRONG_USER', 'x')) : null;
    const sc = scenario(async (x) => {
      await x.uiCreate('a');
      ran = true;
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.codes).toContain('WRONG_USER');
    expect(r.failures).toEqual([{ code: 'WRONG_USER', message: 'x' }]);
    expect(w.deleted).toEqual([]);
  });

  it('each step runs on the token the page holds now, renewed mid-run', async () => {
    const w = world();
    const seen: string[] = [];
    let token: () => string = () => '';
    w.browser.readSession = async () =>
      seen.length ? { accessToken: 'renewed', expiresAt: 0, email: 'x', sub: 's' } : null;
    const base = scenario(async () => void seen.push(token()))(w);
    const sc = { ...base, steps: [base.steps[0]!, { ...base.steps[0]!, id: 'second' }] };
    const r = await runPipeline({
      ...deps(w, [sc]),
      makeApi: (t) => {
        token = t;
        return w.api;
      },
    });
    expect(r.steps.map((x) => x.status)).toEqual(['pass', 'pass']);
    expect(seen).toEqual(['tok', 'renewed']);
  });

  it('a page session that stopped being the test user mid-run fails the step before it runs', async () => {
    const w = world();
    let ran = false;
    w.browser.readSession = async () => Promise.reject(new DevcheckError('WRONG_USER', 'x'));
    const r = await runPipeline(deps(w, [scenario(async () => void (ran = true))(w)]));
    expect(ran).toBe(false);
    expect(r.codes).toContain('WRONG_USER');
    expect(r.steps[0]?.status).toBe('fail');
  });

  it('a swept id that survives its delete is a leftover', async () => {
    const w = world({ existing: ['old1'] });
    w.api.writes.deleteTask = async () => undefined;
    const ledger = memLedger([{ run: 'run0', op: 'created', id: 'old1' }]);
    const r = await runPipeline(deps(w, [], ledger));
    expect(r.created).toEqual([{ id: 'old1', via: 'swept', final: 'left' }]);
    expect(r.codes).toEqual(['LEFTOVERS']);
    expect(r.failures).toEqual([{ code: 'LEFTOVERS', message: 'left: old1' }]);
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
    expect(r.failures).toEqual([
      { code: 'LEFTOVERS', message: 't1 kept: unrecorded parts users-part' },
      { code: 'LEFTOVERS', message: 'left: t1' },
      { code: 'LEFTOVERS', message: 'appeared during the run, not in the ledger: users-part' },
    ]);
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
    expect(r.failures).toEqual([
      { code: 'LEFTOVERS', message: 'old1 kept: unrecorded parts users-part' },
    ]); // never in `created`, so this is its only line
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

  it('a place added in Settings is recorded, then deleted as a place (its tasks off the list), never as a task', async () => {
    const w = world();
    const ledger = memLedger();
    const sc = scenario(async (x) => {
      x.uiPlace('Shop');
      x.uiCreate('errand');
    })(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(r.status).toBe('PASS');
    expect(w.placesDeleted).toEqual(['p1']);
    expect(w.deleted).toEqual(['t2']); // the task first (newest first), the place after
    expect(r.created).toEqual([
      { id: 'p1', via: 'ui:upsertPlace', title: undefined, final: 'deleted' },
      { id: 't2', via: 'ui:createTask', title: undefined, final: 'deleted' },
    ]);
  });

  it('never records a rename of an existing place — cleanup must not delete a place the run didn’t make', async () => {
    const w = world();
    w.places.set('users', { id: 'users', name: 'Home', slug: 'home', lastReadAt: null });
    const r = await runPipeline(
      deps(w, [scenario(async (x) => void x.uiPlace('Home2', 'users'))(w)]),
    );
    expect(r.created).toEqual([]);
    expect(w.placesDeleted).toEqual([]);
    expect(r.unrecorded).toEqual(['users']); // there before the run: reported, not deleted
    expect(r.status).toBe('PASS');
  });

  it('a place that appears during the run without a ledger entry fails it, and is not deleted', async () => {
    const w = world();
    const sc = scenario(async (x) => {
      x.places.set('ghost', { id: 'ghost', name: 'G', slug: 'g', lastReadAt: null });
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.appeared).toEqual(['ghost']);
    expect(r.codes).toContain('LEFTOVERS');
    expect(w.placesDeleted).toEqual([]);
  });

  it('deletes a category this run created (after its tasks — cleanup is newest-first), by its recorded id only', async () => {
    const w = world();
    const ledger = memLedger();
    const cat = (id: string): DevCategory => ({
      id,
      label: id,
      isWork: true,
      order: 0,
      active: true,
      area: 'school',
    });
    w.categories.set('users', cat('users')); // the test user's own: never touched
    let taskId = '';
    const sc = scenario(async (x) => {
      ledger.append({ run: 'run1', op: 'created', id: 'c1', via: CATEGORY_VIA, title: 'c1' });
      x.categories.set('c1', cat('c1'));
      taskId = x.uiCreate('on c1'); // created after the category, so cleaned before it
    })(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(w.categoriesDeleted).toEqual(['c1']);
    expect(w.deleted).toEqual([taskId]);
    expect(w.categories.has('users')).toBe(true);
    expect(r.created.map((c) => [c.id, c.final])).toEqual([
      ['c1', 'deleted'],
      [taskId, 'deleted'],
    ]);
    expect(r.status).toBe('PASS');
  });

  it('a category that appears during the run without a ledger entry fails it; one from before is reported', async () => {
    const w = world();
    const cat = (id: string): DevCategory => ({
      id,
      label: id,
      isWork: true,
      order: 0,
      active: true,
      area: null,
    });
    w.categories.set('users', cat('users'));
    const sc = scenario(async (x) => {
      x.categories.set('ghost', cat('ghost'));
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.appeared).toEqual(['ghost']);
    expect(r.unrecorded).toEqual(['users']);
    expect(r.codes).toContain('LEFTOVERS');
    expect(w.categoriesDeleted).toEqual([]);
  });

  it('revokes a token this run minted, and verifies it inactive', async () => {
    const w = world();
    const ledger = memLedger();
    const sc = scenario(async (x) => {
      ledger.append({ run: 'run1', op: 'created', id: 'place-token:run1', via: PLACE_TOKEN_VIA });
      x.placeToken.active = true;
    })(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(w.placeToken).toEqual({ active: false, revokes: 1 });
    expect(r.created).toEqual([
      { id: 'place-token:run1', via: PLACE_TOKEN_VIA, title: undefined, final: 'deleted' },
    ]);
    expect(r.status).toBe('PASS');
  });

  it('removes a push device this run subscribed by its id; one the poller already dropped is "gone"', async () => {
    const w = world();
    const ledger = memLedger();
    const sc = scenario(async (x) => {
      ledger.append({ run: 'run1', op: 'created', id: 'D1', via: PUSH_SUB_VIA, title: 'devcheck' });
      ledger.append({ run: 'run1', op: 'created', id: 'D2', via: PUSH_SUB_VIA, title: 'devcheck' });
      x.pushDevices.add('D1'); // D2: the push service answered 410 and the poller deleted it
    })(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(w.pushRemoved).toEqual(['D1']);
    expect(r.created.map((c) => [c.id, c.final])).toEqual([
      ['D1', 'deleted'],
      ['D2', 'gone'],
    ]);
    expect(r.status).toBe('PASS');
  });

  it('a token revoked mid-run is "gone"; a crashed run’s active token is swept first', async () => {
    const w = world();
    w.placeToken.active = true;
    const ledger = memLedger([
      { run: 'run0', op: 'created', id: 'place-token:run0', via: PLACE_TOKEN_VIA },
    ]);
    const sc = scenario(async () => {
      ledger.append({ run: 'run1', op: 'created', id: 'place-token:run1', via: PLACE_TOKEN_VIA });
      // minted and revoked by the steps themselves: inactive at cleanup
    })(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(r.swept).toEqual(['place-token:run0']);
    expect(w.placeToken.revokes).toBe(1); // the sweep's; cleanup found nothing active
    expect(r.created).toEqual([
      { id: 'place-token:run1', via: PLACE_TOKEN_VIA, title: undefined, final: 'gone' },
    ]);
    expect(r.status).toBe('PASS');
  });

  it('a removal that throws (a revoke racing another device) never stops cleanup: the rest go, LEFTOVERS', async () => {
    const w = world();
    const race = 'The Shortcut token changed on another device — try again';
    w.api.writes.revokePlaceToken = async () => {
      throw new Error(race);
    };
    const ledger = memLedger();
    const sc = scenario(
      async (x) => void x.uiPlace('Shop'),
      async (x) => {
        ledger.append({ run: 'run1', op: 'created', id: 'place-token:run1', via: PLACE_TOKEN_VIA });
        x.placeToken.active = true;
        x.uiCreate('errand');
      },
    )(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    // Newest first: the task, the token (throws), then the place — still deleted after the throw.
    expect(w.deleted).toEqual(['t2']);
    expect(w.placesDeleted).toEqual(['p1']);
    expect(r.failedDeletes).toEqual([`place-token:run1: ${race}`]);
    expect(r.created.map((c) => [c.id, c.final])).toEqual([
      ['p1', 'deleted'],
      ['place-token:run1', 'left'],
      ['t2', 'deleted'],
    ]);
    expect(r.status).toBe('FAIL'); // reported, not a crash
    expect(r.codes).toContain('LEFTOVERS');
    // Still pending, so the next run's sweep retries it.
    expect(ledger.entries.some((e) => e.id === 'place-token:run1' && e.op !== 'created')).toBe(
      false,
    );
  });

  it('a sweep delete that throws is reported and the sweep goes on to the next id', async () => {
    const w = world({ existing: ['old1', 'old2'] });
    const del = w.api.writes.deleteTask;
    w.api.writes.deleteTask = async (id) => {
      if (id === 'old1') throw new Error('HTTP 500 on deleteTask');
      await del(id);
    };
    const ledger = memLedger([
      { run: 'run0', op: 'created', id: 'old1' },
      { run: 'run0', op: 'created', id: 'old2' },
    ]);
    const ran: string[] = [];
    const sc = scenario(async () => void ran.push('step'))(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(w.deleted).toEqual(['old2']);
    expect(r.swept).toEqual(['old2']);
    expect(r.failedDeletes).toEqual(['old1: HTTP 500 on deleteTask']);
    expect(ran).toEqual(['step']); // the run went on
    expect(r.status).toBe('FAIL');
    expect(r.codes).toContain('LEFTOVERS');
    expect(r.failures).toEqual([{ code: 'LEFTOVERS', message: 'old1: HTTP 500 on deleteTask' }]);
  });

  it('a guard refusal during cleanup keeps its own code beside LEFTOVERS', async () => {
    const w = world();
    w.api.writes.deleteTask = async (id) => {
      throw new DevcheckError('LEDGER_GUARD', `refusing to touch ${id}`);
    };
    const r = await runPipeline(deps(w, [scenario(async (x) => void x.uiCreate('a'))(w)]));
    expect(r.failedDeletes).toEqual(['t1: LEDGER_GUARD: refusing to touch t1']);
    expect(r.codes).toEqual(expect.arrayContaining(['LEDGER_GUARD', 'LEFTOVERS']));
    expect(r.status).toBe('FAIL');
  });

  it('a read-back that throws proves nothing: the id stays left, the error reported', async () => {
    const w = world();
    const get = w.api.reads.getTask;
    let deletedOnce = false;
    w.api.writes.deleteTask = async (id) => {
      deletedOnce = true;
      w.tasks.delete(id);
    };
    w.api.reads.getTask = async (id) => {
      if (deletedOnce) throw new Error('HTTP 502 on getTask');
      return get(id);
    };
    const r = await runPipeline(deps(w, [scenario(async (x) => void x.uiCreate('a'))(w)]));
    expect(r.created[0]!.final).toBe('left');
    expect(r.failedDeletes).toEqual(['t1: read-back: HTTP 502 on getTask']);
    expect(r.codes).toContain('LEFTOVERS');
    expect(r.status).toBe('FAIL');
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
    expect(r.failures).toEqual([
      { code: 'DEV_CHANGED_MID_RUN', message: `end build bbbbbbb ≠ start ${SHA.slice(0, 7)}` },
    ]);
  });

  it('a setup DevcheckError is a FAIL with its code; anything else is a CRASH (exit 2)', async () => {
    const w = world();
    const fail = await runPipeline(
      deps(w, [], memLedger(), {
        waitForDeploy: async () => Promise.reject(new DevcheckError('DEPLOY_FAILED', 'x')),
      }),
    );
    expect([fail.status, fail.codes]).toEqual(['FAIL', ['DEPLOY_FAILED']]);
    expect(fail.failures).toEqual([{ code: 'DEPLOY_FAILED', message: 'x' }]); // the text, not `DEPLOY_FAILED: x`
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

  it('signs MCP in after the sweep and hands its client to the steps', async () => {
    const w = world();
    const order: string[] = [];
    w.api.reads.listTasks = async () => (order.push('baseline'), []);
    w.browser.signInMcp = async () => {
      order.push('mcp');
      return { accessToken: 'mcp', expiresAt: 1e10, email: 'x', sub: 's', clientId: 'c' };
    };
    let tools: string[] = [];
    const r = await runPipeline(
      deps(w, [scenario(async (_, ctx) => void (tools = await ctx.mcp.reads.toolsList()))(w)]),
    );
    expect(r.status).toBe('PASS');
    expect(order.slice(0, 2)).toEqual(['baseline', 'mcp']);
    expect(tools).toEqual(['mcp']);
  });

  it('an MCP sign-in failure fails the run with its code before any step, and cleanup still runs', async () => {
    const w = world();
    w.browser.signInMcp = async () => {
      throw new DevcheckError('MCP_AUTH_FAILED', 'Cognito refused the sign-in: invalid_client');
    };
    let ran = false;
    const r = await runPipeline(deps(w, [scenario(async () => void (ran = true))(w)]));
    expect([r.status, r.codes]).toEqual(['FAIL', ['MCP_AUTH_FAILED']]);
    expect(ran).toBe(false);
    expect(r.steps).toEqual([]);
  });

  it('an MCP token past its expiry fails the step that uses it, not the run setup', async () => {
    const w = world();
    w.browser.signInMcp = async () => ({
      accessToken: 'mcp',
      expiresAt: 0,
      email: 'x',
      sub: 's',
      clientId: 'c',
    });
    const r = await runPipeline(
      deps(w, [scenario(async (_, ctx) => void (await ctx.mcp.reads.toolsList()))(w)]),
    );
    expect(r.steps[0]).toMatchObject({ status: 'fail', error: expect.stringMatching(/expired/) });
    expect(r.codes).toEqual(['STEP_FAILED']);
    expect(r.failures).toEqual([]);
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

  it('an intercept answers with `body` as JSON, `{}` without one', async () => {
    const w = world();
    const sc = scenario(async (x, ctx) => {
      const canned = await ctx.intercept('parseTask', {
        status: 200,
        times: 1,
        body: { ok: true },
      });
      expect(await x.call('parseTask')).toBe(200);
      await canned.release();
      const bare = await ctx.intercept('parseTask', { times: 1 });
      expect(await x.call('parseTask')).toBe(429);
      await bare.release();
      expect(x.injectedBodies).toEqual(['{"ok":true}', '{}']);
    })(w);
    expect((await runPipeline(deps(w, [sc]))).injected).toEqual([
      '/api/parseTask → 200',
      '/api/parseTask → 429',
    ]);
  });

  it('an intercept fails `times` calls, then passes through, and counts both', async () => {
    const w = world();
    const seen: (number | string)[] = [];
    const sc = scenario(async (x, ctx) => {
      const i = await ctx.intercept('listCategories', { times: 2 });
      for (let n = 0; n < 3; n++) seen.push(await x.call('listCategories'));
      seen.push(await x.call('listTasks')); // another method is untouched
      expect([i.hits(), i.passed()]).toEqual([2, 1]);
      await i.release();
      seen.push(await x.call('listCategories'));
      const drop = await ctx.intercept('getDay', { abort: true });
      seen.push(await x.call('getDay'));
      await drop.release();
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(seen).toEqual([429, 429, 'real', 'real', 'real', 'dropped']);
    expect(r.injected).toEqual([
      '/api/listCategories → 429',
      '/api/listCategories → 429',
      '/api/getDay → dropped',
    ]);
  });

  it('an injected 429 is reported as injected, not throttled', async () => {
    const w = world();
    const sc = scenario(async (x, ctx) => {
      const i = await ctx.intercept('listCategories');
      await x.call('listCategories');
      await i.release();
      x.respond('/api/listCategories', 429); // a real one, after release
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.injected).toEqual(['/api/listCategories → 429']);
    expect(r.throttled).toEqual(['/api/listCategories']);
  });

  it('inside an intercept window, a real throttle still counts and a real failure is recorded', async () => {
    const w = world();
    const sc = scenario(async (x, ctx) => {
      const i = await ctx.intercept('listCategories', { times: 1 });
      await x.call('listCategories'); // injected
      x.respond('/api/listCategories', 429); // a real one on the same method, passed through
      x.respond('/api/getDay', 500); // a real failure while the console lines are being dropped
      x.respond('/assets/app.js', 404); // not /api: recorded too
      await i.release();
      x.respond('/api/getDay', 500); // outside the window: the console line itself carries it
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.injected).toEqual(['/api/listCategories → 429']);
    expect(r.throttled).toEqual(['/api/listCategories']);
    expect(r.consoleErrors).toEqual([
      'HTTP 500 on /api/getDay (during an injected failure)',
      'HTTP 404 on dev.aperture.rahuldatta.dev/assets/app.js (during an injected failure)',
    ]);
  });

  it('console 429 lines inside an intercept window are dropped; later ones count', async () => {
    const w = world();
    const line = 'Failed to load resource: the server responded with a status of 429 ()';
    const sc = scenario(async (x, ctx) => {
      const i = await ctx.intercept('listCategories');
      x.consoleError(line);
      x.consoleError('Failed to load resource: net::ERR_FAILED');
      x.consoleError('TypeError: x is undefined'); // never the harness's doing
      await i.release();
      x.consoleError(line);
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.consoleErrors).toEqual(['TypeError: x is undefined', line]);
  });

  it('a canned 200 opens no console window: a failed load during it still counts', async () => {
    const w = world();
    const line = 'Failed to load resource: the server responded with a status of 500 ()';
    const sc = scenario(async (x, ctx) => {
      const i = await ctx.intercept('parseTask', { status: 200, body: { ok: true } });
      x.consoleError(line);
      await i.release();
    })(w);
    expect((await runPipeline(deps(w, [sc]))).consoleErrors).toEqual([line]);
  });

  it('names every failed load by status, method and URL, without its query; a pass stays a pass', async () => {
    const w = world();
    const sc = scenario(async (x) => {
      x.respond('/api/getDay', 200);
      x.respond('/api/listTasks?x=1', 400); // the console line for this one names no URL
      x.respond('/api/listCategories', 429); // a throttle is a failed load too
      x.respond('https://cdn.example.com/f.woff2?v=2', 404, { method: () => 'GET' });
      x.requestFailed('/api/getSettings', 'net::ERR_FAILED', 'POST');
      x.requestFailed('/assets/old.js', 'net::ERR_ABORTED'); // cancelled by the page itself: not a failure
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.failedLoads).toEqual([
      '400 POST dev.aperture.rahuldatta.dev/api/listTasks',
      '429 POST dev.aperture.rahuldatta.dev/api/listCategories',
      '404 GET cdn.example.com/f.woff2',
      'net::ERR_FAILED POST dev.aperture.rahuldatta.dev/api/getSettings',
    ]);
    expect(r.status).toBe('PASS'); // informational: only the console line fails a row
  });

  it('a load the harness itself failed is not a failed load', async () => {
    const w = world();
    const sc = scenario(async (x, ctx) => {
      const i = await ctx.intercept('listCategories', { times: 1 });
      await x.call('listCategories');
      await i.release();
      const dropped = await ctx.intercept('getDay', { abort: true, times: 1 });
      await x.call('getDay');
      await dropped.release();
    })(w);
    const r = await runPipeline(deps(w, [sc]));
    expect(r.injected).toEqual(['/api/listCategories → 429', '/api/getDay → dropped']);
    expect(r.failedLoads).toEqual([]);
  });

  it('a scenario’s intercepts are released before the next scenario', async () => {
    const w = world();
    let next: number | string = 0;
    const leaky = scenario(async (_x, ctx) => {
      await ctx.intercept('listCategories');
      throw new Error('step failed mid-intercept');
    })(w);
    const after = {
      ...scenario(async (x) => void (next = await x.call('listCategories')))(w),
      id: 'after',
    };
    const r = await runPipeline(deps(w, [leaky, after]));
    expect(next).toBe('real');
    expect(w.routes).toHaveLength(0);
    expect(r.steps.map((s) => s.status)).toEqual(['fail', 'pass']);
  });

  it('a step that says needs-you leaves the run green: it and the rest of its scenario read needs-you, the rows too', async () => {
    const w = world();
    let ran = 0;
    const sc: Scenario = {
      id: 'fin',
      title: 'fin',
      tiers: ['full'],
      rows: [
        { id: 'a', entry: 'api', kind: 'nominal', what: 'a' },
        { id: 'b', entry: 'api', kind: 'nominal', what: 'b' },
      ],
      steps: [
        { id: 'setup', title: 'setup', entry: 'api', run: async () => void ran++ },
        {
          id: 'fixture',
          title: 'fixture',
          entry: 'api',
          proves: ['a'],
          run: async () => needsYou('link the fixture bank'),
        },
        {
          id: 'rows',
          title: 'rows',
          entry: 'api',
          proves: ['a', 'b'],
          run: async () => void ran++,
        },
      ],
    };
    const after = scenario(async () => void ran++)(w); // the next scenario still runs
    const r = await runPipeline(deps(w, [sc, after]));
    expect(ran).toBe(2);
    expect(r.status).toBe('PASS');
    expect(r.codes).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.steps.map((s) => [s.step, s.status, s.note])).toEqual([
      ['setup', 'pass', undefined],
      ['fixture', 'needs-you', 'link the fixture bank'],
      ['rows', 'needs-you', 'link the fixture bank'],
      ['s0', 'pass', undefined],
    ]);
    expect(r.steps[1]!.error).toBeUndefined();
    expect(r.steps[1]!.shot).toBeUndefined();
    expect(r.coverage.map((x) => [x.row, x.status, x.note])).toEqual([
      ['a', 'needs-you', 'link the fixture bank'],
      ['b', 'needs-you', 'link the fixture bank'],
    ]);
  });

  it('a step-only needs-you (the sim’s keyboard) leaves the rest of its scenario running', async () => {
    const w = world();
    let ran = 0;
    const sc: Scenario = {
      id: 'kb',
      title: 'kb',
      tiers: ['full'],
      rows: [
        { id: 'a', entry: 'api', kind: 'nominal', what: 'a' },
        { id: 'b', entry: 'api', kind: 'nominal', what: 'b' },
      ],
      steps: [
        {
          id: 'typing',
          title: 'typing',
          entry: 'api',
          proves: ['a'],
          run: async () => needsYou('no soft keyboard', { stepOnly: true }),
        },
        { id: 'next', title: 'next', entry: 'api', proves: ['b'], run: async () => void ran++ },
      ],
    };
    const r = await runPipeline(deps(w, [sc]));
    expect(ran).toBe(1);
    expect(r.status).toBe('PASS');
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ['typing', 'needs-you'],
      ['next', 'pass'],
    ]);
    expect(r.coverage.map((x) => [x.row, x.status])).toEqual([
      ['a', 'needs-you'],
      ['b', 'pass'],
    ]);
  });

  describe('slow tier and the iOS sim', () => {
    const slowSc = (run: () => Promise<void>): Scenario => ({
      id: 'slw',
      title: 'slw',
      tiers: ['full'],
      slowPaths: ['app/**'],
      rows: [
        { id: 'slow', entry: 'ios', kind: 'nominal', what: 'slow' },
        { id: 'cheap', entry: 'api', kind: 'nominal', what: 'cheap' },
        { id: 'both', entry: 'api', kind: 'edge', what: 'both' },
      ],
      steps: [
        { id: 'wait', title: 'wait', entry: 'ios', cost: 'slow', proves: ['slow', 'both'], run },
        {
          id: 'quick',
          title: 'quick',
          entry: 'api',
          proves: ['cheap', 'both'],
          run: async () => undefined,
        },
      ],
    });

    it('a slow step outside the slow set is deferred, the scenario goes on, and the run stays green', async () => {
      let slowRan = 0;
      const r = await runPipeline(
        deps(world(), [slowSc(async () => void slowRan++)], memLedger(), { slow: [] }),
      );
      expect(slowRan).toBe(0);
      expect(r.status).toBe('PASS');
      expect(r.steps.map((s) => [s.step, s.status])).toEqual([
        ['wait', 'deferred'],
        ['quick', 'pass'],
      ]);
      expect(r.steps[0]!.note).toBe(DEFER_NOTE);
      expect(r.coverage.map((x) => [x.row, x.status])).toEqual([
        ['slow', 'deferred'],
        ['cheap', 'pass'],
        ['both', 'pass'], // a row a run step proves is judged on that step
      ]);
    });

    it('in the slow set, or with no slow set at all, a slow step runs', async () => {
      for (const slow of [['slw'], undefined]) {
        let slowRan = 0;
        const r = await runPipeline(
          deps(world(), [slowSc(async () => void slowRan++)], memLedger(), { slow }),
        );
        expect(slowRan).toBe(1);
        expect(r.steps[0]!.status).toBe('pass');
      }
    });

    it('an iOS step whose sim is out reads needs you, and the run says iOS NOT RUN with the row count', async () => {
      const finish = vi.fn(async () => undefined);
      const ios: Ios = {
        forScenario: () => ({ run: () => needsYou(`${IOS_NOTE}: MAC_UNREACHABLE`) }),
        finish,
        jobs: [
          {
            id: 'j1',
            step: 'wait',
            status: 'unavailable',
            reason: 'MAC_UNREACHABLE',
            buildsSeen: [],
          },
        ],
        shots: ['ios-slw-wait-01-home.png'],
        unavailable: () => 'MAC_UNREACHABLE',
      };
      const r = await runPipeline(
        deps(world(), [slowSc(async () => undefined)], memLedger(), {
          ios,
          scenarios: [
            {
              ...slowSc(async () => undefined),
              steps: [
                {
                  id: 'wait',
                  title: 'wait',
                  entry: 'ios',
                  cost: 'slow',
                  proves: ['slow', 'both'],
                  run: (ctx) => ctx.ios.run('wait', [{ op: 'launch' }]).then(() => undefined),
                },
                {
                  id: 'quick',
                  title: 'quick',
                  entry: 'api',
                  proves: ['cheap'],
                  run: async () => undefined,
                },
              ],
            },
          ],
        }),
      );
      expect(r.status).toBe('PASS');
      // the later step inherits the needs-you too, but only an ios row counts as an iPhone row
      expect(r.ios?.unavailable).toEqual({ reason: 'MAC_UNREACHABLE', rows: 1 });
      expect(statusLine(r)).toBe('PASS — iOS NOT RUN (MAC_UNREACHABLE): 1 iPhone row untested');
      expect(finish).toHaveBeenCalledOnce();
      expect(r.shots).toContain('ios-slw-wait-01-home.png');
    });

    it('an outage with no ios row left to count still reaches the status line', async () => {
      const ios = {
        forScenario: () => ({ run: async () => ({}) }),
        finish: async () => undefined,
        jobs: [],
        shots: [],
        unavailable: () => 'MAC_UNREACHABLE',
      } as unknown as Ios;
      const r = await runPipeline(
        deps(world(), [scenario(async () => undefined)(world())], memLedger(), { ios }),
      );
      expect(r.ios?.unavailable).toEqual({ reason: 'MAC_UNREACHABLE', rows: 0 });
      expect(statusLine(r)).toBe('PASS — iOS NOT RUN (MAC_UNREACHABLE)');
    });

    it('without an iOS client a step that asks for the sim reads needs you, never crashes', async () => {
      const sc = slowSc(async () => undefined);
      sc.steps[0]!.run = (ctx) => ctx.ios.run('wait', [{ op: 'launch' }]).then(() => undefined);
      const r = await runPipeline(deps(world(), [sc]));
      expect(r.status).toBe('PASS');
      expect(r.steps[0]!.status).toBe('needs-you');
      expect(r.ios?.unavailable?.reason).toBe('no mailroom in this run');
    });
  });

  it('a bucket, a link and a rule in the ledger are cleared their own way, and an earlier run’s swept', async () => {
    const w = world();
    const row = (id: string, over: Partial<DevFinanceTransaction>): DevFinanceTransaction => ({
      id,
      accountId: 'acct',
      date: '2026-11-01',
      name: `DEVCHECK ${id}`,
      merchantName: null,
      rawAmountCents: 100,
      bucket: null,
      refundOfId: null,
      ...over,
    });
    w.finance.rows.set('tx1', row('tx1', { bucket: 'budget' }));
    w.finance.rows.set('tx2', row('tx2', { refundOfId: 'c' }));
    w.finance.rows.set('tx3', row('tx3', { bucket: 'i_pay' }));
    w.finance.rules.set('R1', { id: 'R1', pattern: 'devcheck', bucket: 'budget' });
    const ledger = memLedger([
      { run: 'run0', op: 'created', id: 'finance-bucket:run0:tx3', via: FINANCE_BUCKET_VIA },
    ]);
    const sc = scenario(async () => {
      ledger.append({
        run: 'run1',
        op: 'created',
        id: 'finance-bucket:run1:tx1',
        via: FINANCE_BUCKET_VIA,
      });
      ledger.append({
        run: 'run1',
        op: 'created',
        id: 'finance-link:run1:tx2',
        via: FINANCE_LINK_VIA,
      });
      ledger.append({ run: 'run1', op: 'created', id: 'R1', via: FINANCE_RULE_VIA });
    })(w);
    const r = await runPipeline(deps(w, [sc], ledger));
    expect(r.swept).toEqual(['finance-bucket:run0:tx3']);
    expect(w.finance.unset).toEqual(['finance-bucket:run0:tx3', 'finance-bucket:run1:tx1']);
    expect(w.finance.unlinked).toEqual(['finance-link:run1:tx2']);
    expect(w.finance.rulesDeleted).toEqual(['R1']);
    expect([...w.finance.rows.values()].map((t) => [t.bucket, t.refundOfId])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(r.created.map((c) => [c.id, c.final])).toEqual([
      ['finance-bucket:run1:tx1', 'deleted'],
      ['finance-link:run1:tx2', 'deleted'],
      ['R1', 'deleted'],
    ]);
    expect(r.status).toBe('PASS');
  });
});

// The local check (local/run-local.ts): its skip hook and the running-timer check — dev runs pass neither.
describe('runPipeline — the local check’s hooks', () => {
  it('a skipped step is deferred with its reason and never runs; the rest of the scenario does', async () => {
    const w = world();
    const ran: string[] = [];
    const sc = scenario(
      async () => void ran.push('s0'),
      async () => void ran.push('s1'),
    )(w);
    const r = await runPipeline(
      deps(w, [sc], memLedger(), {
        skip: (_sc, step) => (step.id === 's0' ? 'local: x — runs on dev' : null),
      }),
    );
    expect(r.status).toBe('PASS');
    expect(ran).toEqual(['s1']);
    expect(r.steps.map((s) => [s.step, s.status, s.note])).toEqual([
      ['s0', 'deferred', 'local: x — runs on dev'],
      ['s1', 'pass', undefined],
    ]);
  });

  it('a timer left running fails the run LEFTOVERS — only when checkSessions is on', async () => {
    const w = world();
    w.api.reads.listRunningSessions = async () => [
      {
        id: 'sess1',
        taskId: null,
        status: 'running',
        startedAt: 0,
        endedAt: null,
        activeMinutes: 0,
      },
    ];
    const sc = scenario(async () => undefined)(w);
    const on = await runPipeline(deps(w, [sc], memLedger(), { checkSessions: true }));
    expect(on.status).toBe('FAIL');
    expect(on.failures).toContainEqual({
      code: 'LEFTOVERS',
      message: 'a timer was left running: sess1',
    });
    const off = await runPipeline(deps(w, [sc], memLedger()));
    expect(off.status).toBe('PASS');
  });
});
