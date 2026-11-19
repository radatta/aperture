import { describe, expect, it } from 'vitest';
import { DEFER_NOTE, deferral } from './pipeline';
import { IPHONE_TAG, crashed, laneMode, mergeRuns, planLanes, runLanes, splitLanes } from './lanes';
import { lanesLine, renderReport, type RunResult } from './report';
import type { Scenario, Step } from './scenario';

const step = (id: string, cost?: 'slow'): Step => ({
  id,
  title: id,
  entry: 'api',
  ...(cost ? { cost } : {}),
  run: async () => undefined,
});
const sc = (id: string, o: Partial<Scenario> = {}): Scenario => ({
  id,
  title: id,
  tiers: ['full'],
  rows: [{ id: `${id}-row`, entry: 'api', kind: 'nominal', what: `${id} works` }],
  steps: [{ ...step('s'), proves: [`${id}-row`] }],
  ...o,
});

const result = (o: Partial<RunResult> = {}): RunResult => ({
  runId: 'r1',
  tier: 'full',
  feature: [],
  expectedSha: 'a'.repeat(40),
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
  failedLoads: [],
  throttled: [],
  injected: [],
  shots: [],
  durationMs: 1000,
  ...o,
});
const row = (scenario: string, status: 'pass' | 'fail' = 'pass') => ({
  scenario,
  row: `${scenario}-row`,
  entry: 'api' as const,
  kind: 'nominal' as const,
  what: `${scenario} works`,
  status,
  provenBy: 'steps s (api)',
});
const stepResult = (scenario: string, shot?: string) => ({
  scenario,
  step: 's',
  title: 's',
  status: 'pass' as const,
  ms: 1,
  ...(shot ? { shot } : {}),
});
const BASE = { runId: 'r1', tier: 'full', feature: [], expectedSha: 'a'.repeat(40) };

describe('laneMode', () => {
  it('two users side by side on dev once the browser user is set up', () => {
    expect(laneMode({ slot: 'dev', webEnv: true }).mode).toBe('parallel');
    expect(laneMode({ slot: 'dev', webEnv: true, env: '' }).mode).toBe('parallel');
    expect(laneMode({ slot: 'dev', webEnv: true, env: 'parallel' }).mode).toBe('parallel');
  });

  it('serial on request, the iPhone lane first', () => {
    expect(laneMode({ slot: 'dev', webEnv: true, env: 'serial' }).mode).toBe('serial');
  });

  it('one user on devb, before the browser user exists, or on request — today’s path', () => {
    expect(laneMode({ slot: 'devb', webEnv: true })).toEqual({
      mode: 'one-user',
      why: 'devb has no Simulator',
    });
    expect(laneMode({ slot: 'dev', webEnv: false }).why).toMatch(/no browser-user env file/);
    expect(laneMode({ slot: 'dev', webEnv: true, env: 'one-user' }).mode).toBe('one-user');
  });

  it('refuses an unknown DEVCHECK_LANES rather than guessing', () => {
    expect(() => laneMode({ slot: 'dev', webEnv: true, env: 'both' })).toThrow(
      /^LANES_REFUSED: DEVCHECK_LANES=both/,
    );
  });

  it('refuses two users asked for where the run can’t have them: a timing run never quietly measures one', () => {
    for (const env of ['serial', 'parallel']) {
      expect(() => laneMode({ slot: 'devb', webEnv: true, env })).toThrow(
        /^LANES_REFUSED: .*devb has no Simulator/,
      );
      expect(() => laneMode({ slot: 'dev', webEnv: false, env })).toThrow(
        /^LANES_REFUSED: .*no browser-user env file/,
      );
    }
    expect(laneMode({ slot: 'devb', webEnv: false, env: 'one-user' }).mode).toBe('one-user');
  });
});

describe('splitLanes', () => {
  const sim = sc('ios-standalone', { user: 'iphone', steps: [step('launch', 'slow')] });
  const web = sc('areas');
  const all = [sc('smoke'), sim, web];

  it('the iPhone scenarios go to the iPhone lane when a step of theirs runs', () => {
    const { browser, iphone } = splitLanes(all, () => true);
    expect(browser.map((s) => s.id)).toEqual(['smoke', 'areas']);
    expect(iphone.map((s) => s.id)).toEqual(['ios-standalone']);
  });

  it('every iPhone step deferred: they stay in the browser lane, which reports them deferred, and no iPhone lane', () => {
    const { browser, iphone } = splitLanes(all, (_, st) => st.cost !== 'slow');
    expect(browser).toEqual(all);
    expect(iphone).toEqual([]);
  });

  it('a browser scenario’s steps never wake the iPhone lane', () => {
    expect(splitLanes([web], () => true).iphone).toEqual([]);
  });
});

describe('planLanes', () => {
  const sim = sc('ios-standalone', { user: 'iphone', steps: [step('launch', 'slow')] });
  const all = [sc('smoke'), sim, sc('areas')];
  const ids = (xs: Scenario[]) => xs.map((s) => s.id);

  it('a branch reaching an iPhone path: the iPhone lane runs its scenarios, with the Simulator client', () => {
    const p = planLanes({
      scenarios: all,
      defer: { slow: ['ios-standalone'] },
      mainLeftovers: false,
    });
    expect([ids(p.browser), ids(p.iphone)]).toEqual([['smoke', 'areas'], ['ios-standalone']]);
    expect(p).toMatchObject({ iphoneRuns: true, sweepOnly: false, browserGetsIos: false });
  });

  it('every iPhone step deferred, a clean ledger: no iPhone lane; the browser lane carries them and the client', () => {
    const p = planLanes({ scenarios: all, defer: { slow: [] }, mainLeftovers: false });
    expect(ids(p.browser)).toEqual(ids(all));
    expect(p).toMatchObject({
      iphone: [],
      iphoneRuns: false,
      sweepOnly: false,
      browserGetsIos: true,
    });
  });

  it('every iPhone step deferred but its user’s ledger has leftovers: the iPhone lane runs to sweep, steps-less', () => {
    const p = planLanes({ scenarios: all, defer: { slow: [] }, mainLeftovers: true });
    expect(p).toMatchObject({
      iphone: [],
      iphoneRuns: true,
      sweepOnly: true,
      browserGetsIos: true,
    });
  });

  it('a skip (the probe covered by ios-standalone) defers like the pipeline: one rule for both', () => {
    const probe = sc('ios-probe', { user: 'iphone', steps: [step('probe', 'slow')] });
    const defer = {
      slow: ['ios-probe'],
      skip: (id: string) => (id === 'ios-probe' ? 'covered' : null),
    };
    expect(planLanes({ scenarios: [probe], defer, mainLeftovers: false }).iphoneRuns).toBe(false);
    // the pipeline's own loop reads the same rule: a skip's reason first, then a slow step off the branch's paths
    expect(deferral(defer, 'ios-probe', probe.steps[0]!)).toBe('covered');
    expect(deferral({ slow: [] }, 'ios-probe', probe.steps[0]!)).toBe(DEFER_NOTE);
    expect(deferral({ slow: [] }, 'smoke', step('s'))).toBeNull();
  });
});

describe('mergeRuns', () => {
  const browser = result({
    coverage: [row('smoke'), row('areas')],
    steps: [stepResult('smoke'), stepResult('areas', 'areas-s-fail-light.png')],
    created: [{ id: 'w1', via: 'api:createTask', final: 'deleted' }],
    shots: ['areas-s-fail-light.png'],
    startSha: 'b'.repeat(40),
    endSha: 'b'.repeat(40),
    sittingStarts: 4,
    durationMs: 530_000,
  });
  const iphone = result({
    coverage: [row('ios-standalone', 'fail')],
    steps: [stepResult('ios-standalone', 'ios-standalone-s-fail-light.png')],
    status: 'FAIL',
    codes: ['STEP_FAILED', 'LEFTOVERS'],
    failures: [{ code: 'LEFTOVERS', message: 'left: i1' }],
    created: [{ id: 'i1', via: 'mcp:createTask', final: 'left' }],
    throttled: ['/api/getDay'],
    consoleErrors: ['boom'],
    swept: ['old1'],
    shots: ['ios-standalone-s-fail-light.png', 'ios-ios-standalone-launch-a.png'],
    ios: { jobs: [], unavailable: null },
    durationMs: 450_000,
  });
  const order = ['smoke', 'ios-standalone', 'areas'];
  const m = mergeRuns(
    [
      { lane: 'browser', r: browser },
      { lane: 'iphone', r: iphone },
    ],
    { order, mode: 'parallel', wallMs: 540_000 },
  );

  it('rows and steps in the run’s scenario order, whichever lane ran them', () => {
    expect(m.coverage.map((x) => x.scenario)).toEqual(order);
    expect(m.steps.map((x) => x.scenario)).toEqual(order);
  });

  it('the worst status, every code once, and the wall time', () => {
    expect(m.status).toBe('FAIL');
    expect(m.codes).toEqual(['STEP_FAILED', 'LEFTOVERS']);
    expect(m.durationMs).toBe(540_000);
    expect(m.lanes).toEqual({ mode: 'parallel', browserMs: 530_000, iphoneMs: 450_000 });
  });

  it('the iPhone lane’s harness lines say whose they are; its records carry the lane', () => {
    expect(m.failures).toEqual([{ code: 'LEFTOVERS', message: `${IPHONE_TAG}left: i1` }]);
    expect(m.throttled).toEqual([`${IPHONE_TAG}/api/getDay`]);
    expect(m.consoleErrors).toEqual([`${IPHONE_TAG}boom`]);
    expect(m.swept).toEqual(['old1 (iPhone user)']); // an id list: each id says whose it is
    expect(m.created).toEqual([
      { id: 'w1', via: 'api:createTask', final: 'deleted' },
      { id: 'i1', via: 'mcp:createTask', final: 'left', lane: 'iphone' },
    ]);
  });

  it('the iPhone lane’s shots are in its own folder, in the list and on its steps', () => {
    expect(m.shots).toEqual([
      'areas-s-fail-light.png',
      'iphone/ios-standalone-s-fail-light.png',
      'iphone/ios-ios-standalone-launch-a.png',
    ]);
    expect(m.steps.find((s) => s.scenario === 'ios-standalone')?.shot).toBe(
      'iphone/ios-standalone-s-fail-light.png',
    );
    expect(m.steps.find((s) => s.scenario === 'areas')?.shot).toBe('areas-s-fail-light.png');
  });

  it('the pipeline phases are the browser lane’s, never the sum of both lanes', () => {
    const phases = { deployWaitMs: 1, openMs: 2, setupMs: 3, stepsMs: 4, cleanupMs: 5 };
    const both = mergeRuns(
      [
        { lane: 'browser', r: { ...browser, phases } },
        { lane: 'iphone', r: { ...iphone, phases: { ...phases, stepsMs: 900 } } },
      ],
      { order, mode: 'parallel', wallMs: 540_000 },
    );
    expect(both.phases).toEqual(phases);
  });

  it('the build, budget and deploy are the browser lane’s; the Simulator section the iPhone lane’s', () => {
    expect(m.startSha).toBe('b'.repeat(40));
    expect(m.sittingStarts).toBe(4);
    expect(m.ios).toEqual({ jobs: [], unavailable: null });
  });

  it('the report names both lanes and their times, the iPhone user’s leftovers, and the 429 caveat', () => {
    const md = renderReport(m);
    expect(md).toContain('Lanes: parallel — browser 530.0s ∥ iPhone user 450.0s · wall 540.0s');
    expect(md).toContain('- `i1` via mcp:createTask (iPhone user) → **left**');
    expect(md).toMatch(/lanes ran side by side: a 429 here may be the two users’ load/);
    expect(md).toContain('**Failed:** LEFTOVERS — iPhone user: left: i1');
  });

  it('the Simulator section is the iPhone lane’s when it ran, else the browser lane’s (an idle iPhone lane’s client)', () => {
    const own = { jobs: [], unavailable: { reason: 'Mac asleep', rows: 2 } };
    expect(
      mergeRuns([{ lane: 'browser', r: { ...browser, ios: own } }], {
        order,
        mode: 'parallel',
        wallMs: 1,
      }).ios,
    ).toBe(own);
    expect(
      mergeRuns(
        [
          { lane: 'browser', r: { ...browser, ios: own } },
          { lane: 'iphone', r: iphone },
        ],
        { order, mode: 'parallel', wallMs: 1 },
      ).ios,
    ).toBe(iphone.ios);
  });

  it('Mac unreachable: the iPhone rows read needs-you, the run stays PASS and says why', () => {
    const away = mergeRuns(
      [
        { lane: 'browser', r: browser },
        {
          lane: 'iphone',
          r: result({
            coverage: [{ ...row('ios-standalone'), status: 'needs-you' }],
            ios: { jobs: [], unavailable: { reason: 'the Mac is unreachable', rows: 1 } },
          }),
        },
      ],
      { order, mode: 'parallel', wallMs: 1 },
    );
    expect(away.status).toBe('PASS');
    expect(away.coverage.find((x) => x.scenario === 'ios-standalone')?.status).toBe('needs-you');
    expect(renderReport(away)).toMatch(/PASS — .*the Mac is unreachable/);
  });

  it('no 429 caveat when only one lane ran', () => {
    const one = mergeRuns([{ lane: 'browser', r: { ...browser, throttled: ['/api/getDay'] } }], {
      order,
      mode: 'parallel',
      wallMs: 1,
    });
    expect(renderReport(one)).not.toMatch(/side by side/);
    expect(renderReport(one)).toContain('Lanes: parallel — browser 530.0s only');
  });

  it('a crash in one lane is the run’s, named by lane, beside the other’s results', () => {
    const c = mergeRuns(
      [
        { lane: 'browser', r: browser },
        { lane: 'iphone', r: { ...iphone, status: 'CRASH', crash: 'Error: x' } },
      ],
      { order, mode: 'parallel', wallMs: 1 },
    );
    expect(c.status).toBe('CRASH');
    expect(c.crash).toBe(`${IPHONE_TAG}Error: x`);
    expect(c.leftoversUnknown).toBeUndefined();
    expect(c.coverage.map((x) => x.scenario)).toEqual(order);
    expect(
      mergeRuns([{ lane: 'browser', r: browser }], { order, mode: 'serial', wallMs: 1 }).crash,
    ).toBeUndefined();
  });
});

describe('crashed', () => {
  it('a lane that threw still lists its scenarios’ rows, unproven', () => {
    const r = crashed(BASE, [sc('ios-standalone')], new Error('no browser'));
    expect(r.status).toBe('CRASH');
    expect(r.crash).toMatch(/no browser/);
    expect(r.coverage).toEqual([
      expect.objectContaining({ scenario: 'ios-standalone', status: 'skipped' }),
    ]);
  });

  it('as the browser lane (the merge’s base): the header keeps its slot, and leftovers read unknown, not 0', () => {
    const r = crashed(
      { ...BASE, target: 'dev (https://dev.example)' },
      [sc('areas')],
      new Error('x'),
    );
    const m = mergeRuns([{ lane: 'browser', r }], {
      order: ['areas'],
      mode: 'parallel',
      wallMs: 1,
    });
    const md = renderReport(m);
    expect(md).toContain('on dev (https://dev.example)');
    expect(md).toMatch(
      /Leftovers: \*\*0\*\* · \*\*unknown\*\* besides: the lane threw, so its cleanup may not have finished/,
    );
    expect(m.crash).not.toContain(IPHONE_TAG); // the browser lane's lines are untagged
  });
});

describe('lanesLine', () => {
  it('parallel side by side; serial the iPhone lane first, as it ran; one lane alone; one-user bare', () => {
    expect(lanesLine({ mode: 'parallel', browserMs: 2000, iphoneMs: 1000 }, 2100)).toBe(
      'Lanes: parallel — browser 2.0s ∥ iPhone user 1.0s · wall 2.1s',
    );
    expect(lanesLine({ mode: 'serial', browserMs: 2000, iphoneMs: 1000 }, 3000)).toBe(
      'Lanes: serial — iPhone user 1.0s then browser 2.0s · wall 3.0s',
    );
    expect(lanesLine({ mode: 'serial', browserMs: 2000 }, 2000)).toBe(
      'Lanes: serial — browser 2.0s only · wall 2.0s',
    );
    expect(lanesLine({ mode: 'one-user' }, 5000)).toBe('Lanes: one-user · wall 5.0s');
  });

  it('a result with no lanes (the local check, older reports) has no lanes line', () => {
    expect(renderReport(result())).not.toMatch(/^Lanes:/m);
  });
});

describe('runLanes', () => {
  const clock = () => {
    let t = 0;
    return () => (t += 10);
  };
  const deferred = () => {
    let resolve!: (r: RunResult) => void;
    const p = new Promise<RunResult>((r) => (resolve = r));
    return { p, resolve };
  };

  it('parallel: both lanes start before either finishes', async () => {
    const started: string[] = [];
    const b = deferred();
    const i = deferred();
    const run = runLanes({
      mode: 'parallel',
      browser: { scenarios: [sc('areas')], run: () => (started.push('browser'), b.p) },
      iphone: { scenarios: [sc('ios-standalone')], run: () => (started.push('iphone'), i.p) },
      base: BASE,
      order: ['ios-standalone', 'areas'],
      now: clock(),
    });
    await Promise.resolve();
    expect(started.sort()).toEqual(['browser', 'iphone']);
    i.resolve(result({ coverage: [row('ios-standalone')] }));
    b.resolve(result({ coverage: [row('areas')] }));
    expect((await run).coverage.map((x) => x.scenario)).toEqual(['ios-standalone', 'areas']);
  });

  it('serial: the iPhone lane, then the browser lane', async () => {
    const order: string[] = [];
    await runLanes({
      mode: 'serial',
      browser: { scenarios: [], run: async () => (order.push('browser'), result()) },
      iphone: { scenarios: [], run: async () => (order.push('iphone'), result()) },
      base: BASE,
      order: [],
      now: clock(),
    });
    expect(order).toEqual(['iphone', 'browser']);
  });

  it('the Simulator lane failing early: its rows fail in its section, the browser lane still completes', async () => {
    const m = await runLanes({
      mode: 'parallel',
      browser: { scenarios: [sc('areas')], run: async () => result({ coverage: [row('areas')] }) },
      iphone: {
        scenarios: [sc('ios-standalone')],
        run: async () =>
          result({
            status: 'FAIL',
            codes: ['STEP_FAILED'],
            coverage: [row('ios-standalone', 'fail')],
          }),
      },
      base: BASE,
      order: ['ios-standalone', 'areas'],
      now: clock(),
    });
    expect(m.status).toBe('FAIL');
    expect(m.coverage.map((x) => [x.scenario, x.status])).toEqual([
      ['ios-standalone', 'fail'],
      ['areas', 'pass'],
    ]);
  });

  it('a lane that throws (its sign-in, its browser) is a CRASH naming its lane; the other’s rows stand', async () => {
    const m = await runLanes({
      mode: 'parallel',
      browser: {
        scenarios: [sc('areas')],
        run: async () => {
          throw new Error('chromium died');
        },
      },
      iphone: {
        scenarios: [sc('ios-standalone')],
        run: async () => result({ coverage: [row('ios-standalone')] }),
      },
      base: BASE,
      order: ['ios-standalone', 'areas'],
      now: clock(),
    });
    expect(m.status).toBe('CRASH');
    expect(m.crash).toMatch(/^Error: chromium died/);
    expect(m.coverage.map((x) => [x.scenario, x.status])).toEqual([
      ['ios-standalone', 'pass'],
      ['areas', 'skipped'],
    ]);
  });

  it('no iPhone lane: the browser lane alone, timed by the wall', async () => {
    const m = await runLanes({
      mode: 'parallel',
      browser: { scenarios: [], run: async () => result({ durationMs: 7 }) },
      base: BASE,
      order: [],
      now: clock(),
    });
    expect(m.lanes).toEqual({ mode: 'parallel', browserMs: 7 });
    expect(m.durationMs).toBe(10);
  });
});
