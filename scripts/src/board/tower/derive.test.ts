import { describe, expect, it } from 'vitest';
import {
  deployFor,
  derive,
  holdReason,
  laneRow,
  liveLock,
  lockRead,
  sources,
  type Inputs,
} from './derive.ts';
import type { GhRun } from './gh.ts';
import type { MacRead, Costs } from './health.ts';
import type { LaneFile } from './lanes.ts';
import type { Lock, TowerState } from './model.ts';
import type { Pr } from './prs.ts';
import type { Lane } from './queue.ts';

const NOW = Date.parse('2026-11-13T20:00:00Z');
const MIN = 60000;
const sha = (c: string) => c.repeat(40);

const lock = (branch: string | null, over: Partial<Lock> = {}): Lock => ({
  branch,
  sha: branch ? sha('a') : null,
  session: null,
  expiresAt: branch ? NOW + 30 * MIN : null,
  asOf: NOW - MIN,
  failed: false,
  ...over,
});
const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 50,
  title: 'A change',
  branch: 'echo',
  state: 'OPEN',
  mergedAt: null,
  createdAt: NOW - 60 * MIN,
  sha: sha('e'),
  mergeSha: null,
  url: 'https://github.com/radatta/aperture/pull/50',
  draft: false,
  ...over,
});
const run = (over: Partial<GhRun> = {}): GhRun => ({
  id: 1,
  name: 'PR',
  title: 'A change',
  event: 'pull_request',
  branch: 'echo',
  sha: sha('e'),
  status: 'completed',
  conclusion: 'success',
  startedAt: NOW - 30 * MIN,
  createdAt: NOW - 30 * MIN,
  url: 'https://github.com/radatta/aperture/actions/runs/1',
  number: 7,
  ...over,
});
const file = (over: Partial<LaneFile> = {}): LaneFile => ({
  branch: 'echo',
  session: 'auto-9',
  phase: 'build',
  step: null,
  phaseSince: NOW - 20 * MIN,
  sha: sha('e'),
  pr: null,
  slot: null,
  needs: null,
  updatedAt: NOW - 5 * MIN,
  ...over,
});
const queueLane = (over: Partial<Lane> = {}): Lane => ({
  branch: 'echo',
  session: null,
  state: 'building',
  slot: 'dev',
  pr: null,
  eta: null,
  waitingOn: null,
  note: null,
  hold: null,
  ...over,
});
const mac: MacRead = { state: 'ok', at: NOW - 10000, error: null, stats: null };
const aws: Costs = {
  state: 'ok',
  at: NOW - 3600e3,
  error: null,
  month: '2026-11',
  through: '2026-11-12',
  total: 0.57,
  byAccount: { dev: 0.54, prod: 0.03 },
};

function inputs(
  over: {
    lock?: Lock | null;
    lockB?: Lock | null;
    prs?: Pr[];
    runs?: GhRun[];
    checks?: Record<string, GhRun[]>;
    files?: Record<string, string[]>;
    lanes?: LaneFile[];
    devQueue?: Lane[];
    ledger?: TowerState['runs'];
    mac?: MacRead;
    followups?: NonNullable<TowerState['queue']['data']>['followups'];
    maintainer?: { text: string; since: string | null }[];
    mergeOrder?: NonNullable<TowerState['queue']['data']>['mergeOrder'];
    plan?: NonNullable<TowerState['queue']['data']>['plan'];
  } = {},
): Inputs {
  const tower = {
    now: NOW,
    gauges: null,
    sessions: [],
    lock: over.lock === undefined ? lock(null) : over.lock,
    lockB: over.lockB === undefined ? lock(null) : over.lockB,
    points: [],
    jobs: [],
    runs: over.ledger ?? [],
    queue: {
      status: 'ok',
      problems: [],
      data: {
        updatedAt: NOW - 10 * MIN,
        devQueue: over.devQueue ?? [],
        maintainer: over.maintainer ?? [],
        wave: null,
        deadRows: null,
        plan: over.plan ?? [],
        followups: over.followups ?? [],
        mergeOrder: over.mergeOrder ?? [],
      },
    },
    prs: { list: over.prs ?? [], at: NOW - MIN, error: null },
    bench: null,
    lockFeed: [],
    leaseFeed: [],
  } as TowerState;
  return {
    now: NOW,
    version: sha('f'),
    tower,
    lanes: over.lanes ?? [],
    laneProblems: [],
    sessionsByBranch: {},
    runs: { value: over.runs ?? [], at: NOW - MIN, error: null, tried: NOW - MIN },
    checks: (s) =>
      over.checks?.[s] ? { runs: over.checks[s]!, at: NOW - MIN, error: null } : null,
    files: (s) => (over.files?.[s] ? { files: over.files[s]!, error: null } : null),
    mac: over.mac ?? mac,
    aws,
    tests: 1,
    testCap: 4,
    macInstall: 'cd /x && install',
    macInstallReady: true,
    dayStart: Date.parse('2026-11-13T08:00:00Z'),
  };
}
const green = { [sha('e')]: [run(), run({ id: 2, name: 'Secret scan' })] };
const row = (i: Inputs, c: Partial<Parameters<typeof laneRow>[0]> = {}) =>
  laneRow({ branch: 'echo', file: null, queue: null, pr: null, ...c }, i);

describe('laneRow states', () => {
  it("BUILDING with the phase word and step, or, with no lane file, dispatch's words quietly", () => {
    expect(row(inputs())).toMatchObject({
      state: 'BUILDING',
      detail: null,
      tone: 'normal',
      fileAge: null,
    });
    // no lane file: dispatch's waitingOn, quietly
    expect(
      row(inputs(), { queue: queueLane({ waitingOn: 'proof PASS, running A/B' }) }).detail,
    ).toBe('proof PASS, running A/B');
    const r = row(inputs(), { file: file({ phase: 'review', step: 'round 2 of 3' }) });
    expect(r).toMatchObject({
      state: 'BUILDING',
      detail: 'Review · round 2 of 3',
      since: NOW - 20 * MIN,
      fileAge: 300,
    });
    expect(row(inputs(), { file: file({ phase: 'blocked' }) }).tone).toBe('bad');
  });

  it('TESTING on dev or devb while it holds a live lock; an expired lock is not testing', () => {
    expect(row(inputs({ lock: lock('echo') }))).toMatchObject({
      state: 'TESTING',
      label: 'TESTING on dev',
    });
    expect(row(inputs({ lockB: lock('echo') }))).toMatchObject({ label: 'TESTING on devb' });
    expect(row(inputs({ lock: lock('echo', { expiresAt: NOW - 1 }) })).state).toBe('BUILDING');
  });

  it("TESTING's detail: deploying, then devcheck running, then held for you, then the step", () => {
    const deploying = run({
      name: 'Deploy dev (dispatch)',
      title: `deploy-dev ${sha('a')} echo-k`,
      event: 'workflow_dispatch',
      branch: 'main',
      status: 'in_progress',
    });
    expect(row(inputs({ lock: lock('echo'), runs: [deploying] })).detail).toBe('deploying');
    const ledger = [
      {
        run: 'r1',
        start: NOW - 4 * MIN,
        end: null,
        status: null,
        full: true,
        slot: 'dev' as const,
      },
    ];
    expect(row(inputs({ lock: lock('echo'), ledger })).detail).toMatch(
      /^devcheck running since \d\d:\d\d$/,
    );
    // an orphan run (no end, over 2 h old) is not in flight
    const orphan = [{ ...ledger[0]!, start: NOW - 3 * 3600e3 }];
    expect(
      row(inputs({ lock: lock('echo'), ledger: orphan }), { file: file({ step: 'devcheck full' }) })
        .detail,
    ).toBe('devcheck full');
    const needs = { what: 'Safari pass', link: null, cmd: 'open x', unblocks: null };
    expect(row(inputs({ lock: lock('echo') }), { file: file({ needs }) }).detail).toBe(
      'held for you: Safari pass',
    );
  });

  it('PR states from the head sha checks: running, none seen, failed, draft', () => {
    const p = pr();
    expect(
      row(inputs({ checks: { [sha('e')]: [run({ status: 'in_progress', conclusion: null })] } }), {
        pr: p,
      }),
    ).toMatchObject({
      label: 'PR (checks running)',
      tone: 'warn',
    });
    expect(row(inputs(), { pr: p })).toMatchObject({ label: 'PR (no checks seen)', tone: 'warn' });
    expect(
      row(inputs({ checks: { [sha('e')]: [run({ conclusion: 'failure' })] } }), { pr: p }),
    ).toMatchObject({
      state: 'CHECKS FAILED',
      detail: 'PR failure',
      tone: 'bad',
    });
    expect(row(inputs({ checks: green }), { pr: pr({ draft: true }) }).label).toBe('PR (draft)');
  });

  it('MERGE ME when every check passed and nothing holds it', () => {
    expect(row(inputs({ checks: green }), { pr: pr() })).toMatchObject({
      state: 'MERGE ME',
      tone: 'good',
      hold: null,
    });
  });

  it('MERGED → DEPLOYING → DONE / DEPLOY FAILED from main Deploy runs', () => {
    const merged = pr({ state: 'MERGED', mergedAt: NOW - 5 * MIN, mergeSha: sha('m') });
    expect(row(inputs(), { pr: merged })).toMatchObject({
      state: 'MERGED',
      detail: 'deploy run not seen yet',
    });
    const dep = (o: Partial<GhRun>) =>
      run({ name: 'Deploy', event: 'push', branch: 'main', sha: sha('m'), ...o });
    expect(
      row(inputs({ runs: [dep({ status: 'in_progress', conclusion: null })] }), { pr: merged })
        .state,
    ).toBe('DEPLOYING');
    expect(row(inputs({ runs: [dep({})] }), { pr: merged }).state).toBe('DONE');
    expect(row(inputs({ runs: [dep({ conclusion: 'failure' })] }), { pr: merged })).toMatchObject({
      state: 'DEPLOY FAILED',
      tone: 'bad',
    });
  });

  it('PARKED from the lane file or dispatch’s PARKED word', () => {
    expect(row(inputs(), { file: file({ phase: 'parked' }) }).state).toBe('PARKED');
    expect(row(inputs(), { queue: queueLane({ waitingOn: 'PARKED until Fri' }) }).state).toBe(
      'PARKED',
    );
  });
});

describe('deployFor', () => {
  const dep = (s: string, created: number, o: Partial<GhRun> = {}) =>
    run({ name: 'Deploy', event: 'push', branch: 'main', sha: s, createdAt: created, ...o });
  it('a merge whose own run was cancelled by a later merge rides the later run', () => {
    const runs = [
      dep(sha('1'), NOW - 9 * MIN, { conclusion: 'cancelled' }),
      dep(sha('2'), NOW - 5 * MIN, { status: 'in_progress', conclusion: null, number: 9 }),
    ];
    expect(deployFor(sha('1'), runs)).toMatchObject({
      run: { number: 9 },
      via: { conclusion: 'cancelled' },
    });
    expect(deployFor(sha('2'), runs)).toMatchObject({ run: { number: 9 }, via: null });
  });
  it('a cancelled run with nothing later stays cancelled; an unknown merge has none', () => {
    const runs = [dep(sha('1'), NOW, { conclusion: 'cancelled' })];
    expect(deployFor(sha('1'), runs)!.run.conclusion).toBe('cancelled');
    expect(deployFor(sha('3'), runs)).toBeNull();
    expect(deployFor(null, runs)).toBeNull();
  });
  it('only main push runs named Deploy count', () => {
    expect(deployFor(sha('1'), [run({ name: 'PR', sha: sha('1') })])).toBeNull();
  });
  it('rides the first later run that was not cancelled too, not the newest (PR 166: 281, not 283)', () => {
    const runs = [
      dep(sha('1'), NOW - 9 * MIN, { conclusion: 'cancelled', number: 280 }),
      dep(sha('2'), NOW - 8 * MIN, { conclusion: 'cancelled', number: 280.5 }),
      dep(sha('3'), NOW - 7 * MIN, { conclusion: 'success', number: 281 }),
      dep(sha('4'), NOW - 2 * MIN, { status: 'in_progress', conclusion: null, number: 283 }),
    ];
    expect(deployFor(sha('1'), runs)).toMatchObject({ run: { number: 281 } });
    expect(deployFor(sha('2'), runs)).toMatchObject({ run: { number: 281 } });
  });
});

describe('the accuracy audit (2026-11-14)', () => {
  it('NEXT shows the landing order, each entry with its lane row; landed entries drop out', () => {
    const v = derive(
      inputs({
        prs: [
          pr({ number: 40, branch: 'alpha', state: 'MERGED', mergedAt: NOW - 3 * 86400e3 }),
          pr({ number: 51, branch: 'bravo' }),
        ],
        lanes: [file({ branch: 'echo', step: 'round 1' })],
        mergeOrder: [
          { branch: 'alpha', pr: 40, note: null },
          { branch: 'echo', pr: null, note: 'lands first' },
          { branch: 'bravo', pr: 51, note: null },
          { branch: 'ghost', pr: null, note: null }, // no file, PR or queue entry: still shown
        ],
      }),
    );
    expect(v.next.order.map((o) => [o.branch, o.row.label, o.note])).toEqual([
      ['echo', 'BUILDING', 'lands first'],
      ['bravo', 'PR (no checks seen)', null],
      ['ghost', 'NOT STARTED', null],
    ]);
    // NEXT only: a lane that hasn't started never shows in NOW
    expect(v.active.map((r) => r.branch)).not.toContain('ghost');
    expect(derive(inputs()).next.order).toEqual([]);
  });

  it('a queue lane that needs you is a NEEDS YOU item, in its own words', () => {
    const v = derive(
      inputs({
        devQueue: [queueLane({ branch: 'kilo', state: 'needs-you', waitingOn: 'clear auto-3' })],
      }),
    );
    expect(v.needs).toEqual([
      expect.objectContaining({ kind: 'lane', what: 'kilo: clear auto-3', branch: 'kilo' }),
    ]);
    // a lane file's own ask is not repeated
    const w = derive(
      inputs({
        lanes: [
          file({
            branch: 'kilo',
            needs: { what: 'push it', link: null, cmd: 'x', unblocks: null },
          }),
        ],
      }),
    );
    expect(w.needs.filter((n) => n.branch === 'kilo')).toHaveLength(1);
  });

  it("YOU NEXT counts the rest; the maintainer's undated plan steps follow", () => {
    const plan = [
      { at: null, what: 'Rotate the test key', kind: 'maintainer' as const, who: null },
      { at: null, what: 'Land in order', kind: 'dev' as const, who: null },
      { at: NOW - 3 * 3600e3, what: 'Long past', kind: 'maintainer' as const, who: null },
      { at: null, what: 'Install the trial', kind: 'maintainer' as const, who: null },
    ];
    const v = derive(
      inputs({
        plan,
        maintainer: [
          { text: 'a', since: null },
          { text: 'b', since: null },
        ],
      }),
    );
    expect(v.next).toMatchObject({
      maintainer: 'a',
      more: 1,
      plan: ['Rotate the test key', 'Install the trial'],
    });
    expect(derive(inputs({ plan })).next).toMatchObject({
      maintainer: 'Rotate the test key',
      more: 0,
      plan: ['Install the trial'],
    });
    // a timed step counts within 2 h of now either way, sorted ahead of the undated (plan[] is by `at`); tomorrow
    // evening's never jumps them
    const timed = [
      { at: NOW + 3600e3, what: 'In an hour', kind: 'maintainer' as const, who: null },
      { at: NOW + 3 * 3600e3, what: 'Tomorrow evening', kind: 'maintainer' as const, who: null },
      ...plan,
    ];
    expect(derive(inputs({ plan: timed })).next).toMatchObject({
      maintainer: 'In an hour',
      plan: ['Rotate the test key', 'Install the trial'],
    });
  });

  it('a bare-date since is the end of that local day, shown as the day', () => {
    const v = derive(inputs({ maintainer: [{ text: 'a', since: '2026-11-13' }] }));
    expect(v.needs[0]).toMatchObject({
      since: new Date(2026, 10, 14).getTime() - 1,
      sinceDay: '11-13',
    });
  });

  it('a follow-up whose trigger has happened is SLIPPING, whatever its age', () => {
    const f = (id: string, after: string) => ({
      id,
      what: `do ${id}`,
      owner: 'lane',
      after,
      status: 'open',
      source: null,
      since: NOW - MIN,
    });
    const v = derive(
      inputs({
        prs: [pr({ number: 41, branch: 'alpha', state: 'MERGED', mergedAt: NOW - 3600e3 })],
        followups: [
          f('F1', 'alpha merge'),
          f('F2', 'wave 4'),
          f('F3', 'alpha merge + 1 week'),
          f('F4', 'PR 41'),
        ],
      }),
    );
    expect(
      v.slipping.filter((s) => s.kind === 'fired').map((s) => [s.what, s.since, s.after]),
    ).toEqual([
      ['F1: do F1', NOW - 3600e3, 'alpha merge'],
      ['F4: do F4', NOW - 3600e3, 'PR 41'],
    ]);
  });

  it('a building lane whose file has not moved in 2 h is quiet; under it, or another state, is not', () => {
    const at = (age: number, phase: LaneFile['phase'] = 'build') =>
      derive(inputs({ lanes: [file({ phase, updatedAt: NOW - age })] })).active[0]!.quiet;
    expect(at(121 * MIN)).toBe(true);
    expect(at(119 * MIN)).toBe(false);
    expect(
      derive(inputs({ lanes: [file({ phase: 'parked', updatedAt: NOW - 5 * 3600e3 })] })).active,
    ).toEqual([]);
  });
});

describe('holdReason (the automatic HOLD)', () => {
  const p = pr();
  it('(a) another branch holds dev → HOLD with who and until when', () => {
    expect(holdReason(p, null, inputs({ lock: lock('bravo') }))).toMatch(
      /^dev: bravo is testing, lock to \d\d:\d\d$/,
    );
    expect(row(inputs({ lock: lock('bravo'), checks: green }), { pr: p })).toMatchObject({
      state: 'HOLD',
      tone: 'warn',
    });
  });
  it('an expired lock, or the PR’s own branch’s lock, never holds', () => {
    expect(holdReason(p, null, inputs({ lock: lock('bravo', { expiresAt: NOW - 1 }) }))).toBeNull();
    expect(holdReason(p, null, inputs({ lock: lock('echo') }))).toBeNull();
  });
  it('(b) devb busy holds only a PR that changes devb’s shape, or whose files are unread', () => {
    const i = (files: string[] | null) =>
      inputs({ lockB: lock('juliet'), ...(files ? { files: { [sha('e')]: files } } : {}) });
    expect(holdReason(p, null, i(['app/src/x.ts']))).toBeNull();
    expect(holdReason(p, null, i(['cdk/lib/x.ts']))).toMatch(/changes devb's shape/);
    expect(holdReason(p, null, i(['pnpm-lock.yaml']))).toMatch(/shape/);
    expect(holdReason(p, null, i(['packages/shared/src/stage.ts']))).toMatch(/shape/);
    expect(holdReason(p, null, i(null))).toMatch(/aren't read yet/);
  });
  it('(c) a main deploy running', () => {
    const r = run({
      name: 'Deploy',
      event: 'push',
      branch: 'main',
      status: 'queued',
      conclusion: null,
      number: 280,
    });
    expect(holdReason(p, null, inputs({ runs: [r] }))).toBe('main deploy 280 running');
  });
  it("(d) dispatch's hold word, last", () => {
    expect(holdReason(p, queueLane({ hold: 'after the Safari pass' }), inputs())).toBe(
      'after the Safari pass',
    );
    expect(holdReason(p, queueLane({ hold: 'x' }), inputs({ lock: lock('bravo') }))).toMatch(
      /^dev:/,
    );
  });
});

describe('derive', () => {
  it('NEEDS YOU: lane asks, then merges with what they unblock, failed deploys, to-dos, the Mac agent', () => {
    const needs = { what: 'Safari pass', link: null, cmd: 'open -a Safari x', unblocks: 'lc PR' };
    const merged = pr({
      number: 48,
      branch: 'golf',
      state: 'MERGED',
      mergedAt: NOW - 50 * MIN,
      mergeSha: sha('9'),
    });
    const v = derive(
      inputs({
        lanes: [file({ branch: 'india', needs })],
        prs: [pr(), merged],
        checks: green,
        runs: [
          run({
            name: 'Deploy',
            event: 'push',
            branch: 'main',
            sha: sha('9'),
            conclusion: 'failure',
          }),
        ],
        devQueue: [queueLane({ branch: 'delta', state: 'waiting', waitingOn: 'you: merge PR 50' })],
        maintainer: [{ text: 'answer §5', since: '2026-11-12' }],
        mac: { state: 'missing', at: null, error: null, stats: null },
      }),
    );
    expect(v.needs.map((n) => n.kind)).toEqual(['lane', 'merge', 'deploy', 'todo', 'source']);
    expect(v.needs[0]).toMatchObject({
      what: 'india: Safari pass',
      cmd: 'open -a Safari x',
      unblocks: 'lc PR',
    });
    expect(v.needs[1]).toMatchObject({
      what: 'Merge PR 50: A change',
      link: pr().url,
      unblocks: 'delta',
    });
    expect(v.needs[2]!.what).toBe('Main deploy failed after PR 48');
    expect(v.needs[4]).toMatchObject({
      what: 'Install the Mac stats agent',
      cmd: 'cd /x && install',
    });
    expect(v.next.maintainer).toBe('india: Safari pass');
  });

  it('a HOLD is never a NEEDS YOU item; it shows in NEXT with its reason', () => {
    const v = derive(inputs({ prs: [pr()], checks: green, lock: lock('bravo') }));
    expect(v.needs.filter((n) => n.kind === 'merge')).toEqual([]);
    expect(v.next.merge.map((r) => r.state)).toEqual(['HOLD']);
    expect(v.slots[0]).toMatchObject({ slot: 'dev', branch: 'bravo', live: true });
  });

  it("lane universe: dispatch's order first, then lane files, open PRs, lock holders", () => {
    const v = derive(
      inputs({
        devQueue: [queueLane({ branch: 'zulu' }), queueLane({ branch: 'alpha' })],
        lanes: [file({ branch: 'mike' }), file({ branch: 'bravo' })],
        prs: [pr({ branch: 'kilo', sha: sha('k') })],
        lockB: lock('yankee'),
      }),
    );
    expect(v.active.map((r) => r.branch)).toEqual([
      'zulu',
      'alpha',
      'bravo',
      'mike',
      'kilo',
      'yankee',
    ]);
  });

  it('DONE TODAY: merges since local midnight with their deploy result', () => {
    const m = (n: number, at: number, s: string) =>
      pr({ number: n, branch: `b${n}`, state: 'MERGED', mergedAt: at, mergeSha: sha(s) });
    const v = derive(
      inputs({
        prs: [
          m(1, NOW - 60 * MIN, '1'),
          m(2, NOW - 30 * MIN, '2'),
          m(3, Date.parse('2026-11-12T20:00:00Z'), '3'),
        ],
        runs: [run({ name: 'Deploy', event: 'push', branch: 'main', sha: sha('1') })],
      }),
    );
    expect(v.done.map((d) => [d.number, d.deploy, d.tone])).toEqual([
      [2, 'deploy not seen', 'warn'],
      [1, 'deployed ✓', 'good'],
    ]);
  });

  it('SLIPPING: STALE follow-ups at 24 h, parked lanes, lanes quiet for a day', () => {
    const f = (id: string, since: number, o = {}) => ({
      id,
      what: 'w',
      owner: 'lane',
      after: 'now',
      status: 'open',
      source: null,
      since,
      ...o,
    });
    const v = derive(
      inputs({
        followups: [
          f('F1', NOW - 24 * 3600e3 - 1000),
          f('F2', NOW - 24 * 3600e3 + 1000),
          f('F3', 0, { after: 'wave 4' }),
          f('F4', 0, { status: 'tracked' }),
        ],
        lanes: [
          file({ branch: 'parky', phase: 'parked' }),
          file({ branch: 'quiet', updatedAt: NOW - 25 * 3600e3 }),
        ],
      }),
    );
    expect(v.slipping.map((s) => [s.kind, s.what.split(':')[0]])).toEqual([
      ['followup', 'F1'],
      ['parked', 'parky'],
      ['quiet', 'quiet'],
    ]);
  });
});

describe('sources: every source with its age; failed is failed, never empty', () => {
  it('names every source and marks failures and staleness', () => {
    const i = inputs({ lock: lock(null, { failed: true, asOf: NOW - 400000 }) });
    i.tower.prs = { list: [pr()], at: NOW - 10 * MIN, error: 'HTTP 502' };
    i.runs = { value: [], at: NOW - 10 * MIN, error: null, tried: NOW };
    const s = Object.fromEntries(sources(i).map((r) => [r.name, r]));
    expect(Object.keys(s)).toEqual([
      'sampler',
      'dev lock',
      'devb lock',
      'queue.json',
      'gh PRs',
      'gh runs',
      'gh checks',
      'Mac stats',
      'AWS costs',
      'lane files',
    ]);
    expect(s['sampler']!.state).toBe('missing');
    expect(s['dev lock']).toMatchObject({ state: 'failed', detail: 'refresh failing' });
    expect(s['gh PRs']).toMatchObject({ state: 'failed', detail: 'HTTP 502' });
    expect(s['gh runs']!.state).toBe('stale');
    // a failed PR read keeps the last list: the lanes still show
    expect(derive(i).active.map((r) => r.branch)).toEqual(['echo']);
  });
  it('liveLock needs a branch and a future expiry', () => {
    expect(liveLock(lock('x'), NOW)).toBe(true);
    expect(liveLock(lock('x', { expiresAt: null }), NOW)).toBe(false);
    expect(liveLock(null, NOW)).toBe(false);
  });
});

describe('round 1: a failed, stale or missing source never reads as good', () => {
  const p = pr();
  it('lockRead: no cache, a failed refresh, a stale cache, an unreadable expiry are unknown', () => {
    expect(lockRead(null, NOW)).toMatchObject({ state: 'unknown', why: 'no lock cache' });
    expect(lockRead(lock(null, { failed: true, asOf: NOW - 301000 }), NOW).why).toMatch(
      /^refresh failed, last read \d\d:\d\d$/,
    );
    expect(lockRead(lock(null, { asOf: NOW - 301000 }), NOW).why).toMatch(/^cache stale/);
    expect(
      lockRead(
        lock(null, { failed: true, failedWhy: 'ls-remote: denied', asOf: NOW - 301000 }),
        NOW,
      ).why,
    ).toMatch(/^refresh failed \(ls-remote: denied\), last read \d\d:\d\d$/);
    // a failed refresh after a read under 5 min old: the read stands (devlock.sh's rule)
    expect(lockRead(lock('x', { failed: true }), NOW).state).toBe('live');
    expect(lockRead(lock('x', { expiresAt: null }), NOW).why).toBe('holder expiry unreadable');
    expect(lockRead(lock('x'), NOW).state).toBe('live');
    expect(lockRead(lock(null), NOW).state).toBe('free');
  });
  it('an unknown dev lock holds every merge', () => {
    expect(
      holdReason(p, null, inputs({ lock: lock(null, { failed: true, asOf: NOW - 400000 }) })),
    ).toMatch(/^dev lock unknown \(refresh failed/);
    expect(holdReason(p, null, inputs({ lock: null }))).toBe('dev lock unknown (no lock cache)');
  });
  it('a dev devcheck in flight or a dev dispatch running holds, even with the lock lapsed', () => {
    const ledger = [
      { run: 'r', start: NOW - 5 * MIN, end: null, status: null, full: true, slot: 'dev' as const },
    ];
    expect(holdReason(p, null, inputs({ ledger }))).toMatch(/^dev: a devcheck is running since/);
    const disp = run({
      name: 'Deploy dev (dispatch)',
      title: `deploy-dev ${sha('c')} k`,
      status: 'in_progress',
      conclusion: null,
    });
    // no devb sha to match: it may be dev's (a lock released mid-deploy), so it holds
    expect(holdReason(p, null, inputs({ runs: [disp] }))).toBe('a dev deploy is running');
  });
  it('failed, stale or unread runs hold as "main deploy state unknown"', () => {
    const i = inputs();
    i.runs = { value: [], at: NOW - MIN, error: 'HTTP 502', tried: NOW };
    expect(holdReason(p, null, i)).toMatch(/^main deploy state unknown \(gh runs failed: HTTP 502/);
    i.runs = { value: [], at: NOW - 10 * MIN, error: null, tried: NOW };
    expect(holdReason(p, null, i)).toMatch(/stale/);
    i.runs = { value: [], at: null, error: null, tried: null };
    expect(holdReason(p, null, i)).toMatch(/not read yet/);
  });
  it('an unknown devb lock holds only a shape-changing or unread PR', () => {
    const i = (files: string[] | null) =>
      inputs({
        lockB: lock(null, { failed: true, asOf: NOW - 400000 }),
        ...(files ? { files: { [sha('e')]: files } } : {}),
      });
    expect(holdReason(p, null, i(['app/x.ts']))).toBeNull();
    expect(holdReason(p, null, i(['cdk/x.ts']))).toMatch(
      /^devb lock unknown .* changes devb's shape$/,
    );
    expect(holdReason(p, null, i(null))).toMatch(/^devb lock unknown .* aren't read yet$/);
  });
  it('green checks are not MERGE ME when the checks read failed, or the PR list is stale or failed', () => {
    const i = inputs({ checks: green });
    i.checks = () => ({ runs: green[sha('e')]!, at: NOW - MIN, error: 'HTTP 403' });
    expect(row(i, { pr: p })).toMatchObject({
      label: 'PR (checks unknown)',
      detail: expect.stringMatching(/failed: HTTP 403/),
    });
    const j = inputs({ checks: green });
    j.tower.prs = { list: [p], at: NOW - 10 * MIN, error: null };
    expect(row(j, { pr: p }).label).toBe('PR (checks unknown)');
    const k = inputs({ checks: green });
    k.checks = () => ({ runs: green[sha('e')]!, at: NOW - 6 * MIN, error: null });
    expect(row(k, { pr: p }).label).toBe('PR (checks unknown)');
    // a failure stays a failure: only green is held back
    const f = inputs({ checks: { [sha('e')]: [run({ conclusion: 'failure' })] } });
    f.tower.prs = { list: [p], at: NOW - 10 * MIN, error: 'x' };
    expect(row(f, { pr: p }).state).toBe('CHECKS FAILED');
  });
  it('a merged PR with failed runs says the deploy is unknown, not "not seen"', () => {
    const i = inputs();
    i.runs = { value: [], at: NOW - MIN, error: 'HTTP 502', tried: NOW };
    expect(
      row(i, { pr: pr({ state: 'MERGED', mergedAt: NOW, mergeSha: sha('m') }) }).detail,
    ).toMatch(/^deploy unknown \(gh runs failed/);
  });
  it('slot cards carry the lock state; an unreadable lane file is a NEEDS YOU item', () => {
    const i = inputs({ lock: lock('bravo', { failed: true, asOf: NOW - 400000 }), lockB: null });
    i.laneProblems = [{ file: 'x.json', problem: 'not JSON: …' }];
    const v = derive(i);
    expect(v.slots.map((s) => [s.slot, s.state, s.branch])).toEqual([
      ['dev', 'unknown', 'bravo'],
      ['devb', 'unknown', null],
    ]);
    expect(v.needs.find((n) => n.kind === 'source')!.what).toMatch(/lanes\/x.json is unreadable/);
  });
  it('a merged lane file whose PR fell out of the list is MERGED, not BUILDING', () => {
    expect(row(inputs(), { file: file({ phase: 'merged' }) })).toMatchObject({
      state: 'MERGED',
      tone: 'warn',
    });
  });
  it('gh checks source: failed with the PR, ok with none open', () => {
    const i = inputs();
    i.tower.prs = { list: [pr()], at: NOW - MIN, error: null };
    i.checks = () => ({ runs: [], at: null, error: 'HTTP 403' });
    expect(sources(i).find((s) => s.name === 'gh checks')).toMatchObject({
      state: 'failed',
      detail: 'PR 50: HTTP 403',
    });
  });
});

describe('round 2: queue states, parked lanes, dispatch slots, unreadable locks', () => {
  it("with no lane file, the queue's state in the maintainer's words", () => {
    const st = (state: Lane['state'], o: Partial<Lane> = {}) =>
      row(inputs(), { queue: queueLane({ state, ...o }) });
    expect(st('waiting')).toMatchObject({ state: 'WAITING', label: 'WAITING', tone: 'dim' });
    expect(st('next').label).toBe('NEXT FOR DEV');
    expect(st('needs-you', { waitingOn: 'MAC_UNREACHABLE; retrying' })).toMatchObject({
      state: 'NEEDS YOU',
      tone: 'warn',
      detail: 'MAC_UNREACHABLE; retrying',
    });
    expect(st('ready')).toMatchObject({ state: 'READY', tone: 'good' });
    expect(st('on-dev', { slot: 'devb' })).toMatchObject({ state: 'ON DEV', label: 'ON devb?' });
    expect(st('building').state).toBe('BUILDING');
  });
  it('parked lanes leave the dev order for one parked line; waiting lanes are not in NOW', () => {
    const v = derive(
      inputs({
        devQueue: [
          queueLane({ branch: 'axe', state: 'waiting', waitingOn: 'PARKED tonight' }),
          queueLane({ branch: 'fast', state: 'waiting', waitingOn: 'start' }),
        ],
      }),
    );
    expect(v.next.queue.map((l) => l.branch)).toEqual(['fast']);
    expect(v.next.parked).toEqual(['axe']);
    expect(v.active.map((r) => r.branch)).toEqual([]);
  });
  it("a dispatch carrying devb's holder sha is devb's and holds only shape PRs; any other holds as dev's", () => {
    const disp = (x: string) =>
      run({
        name: 'Deploy dev (dispatch)',
        title: `deploy-dev ${x} k`,
        status: 'in_progress',
        conclusion: null,
      });
    const p = pr();
    const b = lock('juliet', { sha: sha('b') });
    expect(
      holdReason(
        p,
        null,
        inputs({ lock: lock('bravo', { sha: sha('a') }), runs: [disp(sha('a'))] }),
      ),
    ).toMatch(/^dev: bravo/);
    expect(
      holdReason(
        p,
        null,
        inputs({
          lockB: { ...b, expiresAt: NOW - 1 },
          runs: [disp(sha('b'))],
          files: { [sha('e')]: ['app/x.ts'] },
        }),
      ),
    ).toBeNull();
    expect(
      holdReason(
        p,
        null,
        inputs({
          lockB: { ...b, expiresAt: NOW - 1 },
          runs: [disp(sha('b'))],
          files: { [sha('e')]: ['cdk/x.ts'] },
        }),
      ),
    ).toBe("a devb deploy is running and this PR changes devb's shape");
  });

  it('an unreadable cache or holder is unknown, never free; a stale lock read marks TESTING with ?', () => {
    expect(lockRead(lock(null, { bad: 'lock cache unreadable' }), NOW)).toEqual({
      state: 'unknown',
      why: 'lock cache unreadable',
    });
    expect(lockRead(lock(null, { bad: 'holder unreadable' }), NOW).state).toBe('unknown');
    expect(row(inputs({ lock: lock('echo', { asOf: NOW - 400000 }) }))).toMatchObject({
      label: 'TESTING on dev?',
      detail: expect.stringMatching(/^lock cache stale/),
    });
  });
  it('the gh checks source goes stale when a read is over 5 min old', () => {
    const i = inputs();
    i.tower.prs = { list: [pr()], at: NOW - MIN, error: null };
    i.checks = () => ({ runs: [], at: NOW - 6 * MIN, error: null });
    expect(sources(i).find((s) => s.name === 'gh checks')!.state).toBe('stale');
  });
});

describe('round 3', () => {
  it('a dispatch still running after its lock was released holds as dev; only one carrying devb’s sha is devb’s', () => {
    const disp = (s: string) =>
      run({
        name: 'Deploy dev (dispatch)',
        title: `deploy-dev ${s} k`,
        status: 'in_progress',
        conclusion: null,
      });
    const p = pr();
    const files = { [sha('e')]: ['app/x.ts'] };
    expect(
      holdReason(
        p,
        null,
        inputs({ lock: lock(null, { sha: null }), runs: [disp(sha('9'))], files }),
      ),
    ).toBe('a dev deploy is running');
    expect(
      holdReason(
        p,
        null,
        inputs({
          lockB: lock('juliet', { sha: sha('b'), expiresAt: NOW - 1 }),
          runs: [disp(sha('b'))],
          files,
        }),
      ),
    ).toBeNull();
  });
  it('the phase track: the lane file’s phase, else what the state proves', () => {
    expect(row(inputs(), { file: file({ phase: 'review' }) }).phase).toBe('review');
    expect(row(inputs({ lock: lock('echo') })).phase).toBe('dev');
    expect(row(inputs({ checks: green }), { pr: pr() }).phase).toBe('pr');
    expect(
      row(inputs(), { pr: pr({ state: 'MERGED', mergedAt: NOW, mergeSha: sha('m') }) }).phase,
    ).toBe('merged');
    expect(row(inputs(), { file: file({ phase: 'parked' }) }).phase).toBeNull();
    expect(row(inputs()).phase).toBeNull();
  });
  it("DONE TODAY's short badge keeps the long form in deployDetail", () => {
    const m = pr({ number: 7, state: 'MERGED', mergedAt: NOW - MIN, mergeSha: sha('1') });
    const dep = (s: string, created: number, o: Partial<GhRun> = {}) =>
      run({ name: 'Deploy', event: 'push', branch: 'main', sha: s, createdAt: created, ...o });
    const v = derive(
      inputs({
        prs: [m],
        runs: [
          dep(sha('1'), NOW - 9 * MIN, { conclusion: 'cancelled' }),
          dep(sha('2'), NOW - 5 * MIN, { number: 274 }),
        ],
      }),
    );
    expect(v.done[0]).toMatchObject({
      deploy: 'deployed ✓',
      tone: 'good',
      deployDetail: 'by main deploy 274: its own was superseded by a later merge',
    });
    const i = inputs({ prs: [m] });
    i.runs = { value: [], at: NOW - MIN, error: 'HTTP 502', tried: NOW };
    expect(derive(i).done[0]).toMatchObject({ deploy: 'deploy unknown', tone: 'warn' });
  });
  it('before the installer is on main, a missing Mac agent is not a NEEDS YOU item', () => {
    const missing = { state: 'missing' as const, at: null, error: null, stats: null };
    const i = inputs({ mac: missing });
    i.macInstallReady = false;
    const v = derive(i);
    expect(v.needs.filter((n) => n.kind === 'source')).toEqual([]);
    expect(v.health.macReady).toBe(false);
    i.macInstallReady = true;
    expect(derive(i).needs.find((n) => n.kind === 'source')!.cmd).toBe('cd /x && install');
  });
  it('an unreadable lock is a failed source, not ok', () => {
    const i = inputs({ lock: lock(null, { bad: 'holder unreadable' }) });
    expect(sources(i).find((s) => s.name === 'dev lock')).toMatchObject({
      state: 'failed',
      detail: 'holder unreadable',
    });
  });
});

describe('round 4', () => {
  const disp = (s: string, id: number) =>
    run({
      id,
      name: 'Deploy dev (dispatch)',
      title: `deploy-dev ${s} k`,
      status: 'in_progress',
      conclusion: null,
    });
  const files = { [sha('e')]: ['app/x.ts'] };

  it('every running dispatch is checked: a newer devb one never hides an older dev one', () => {
    const lockB = lock('juliet', { sha: sha('b') });
    const both = [disp(sha('b'), 2), disp(sha('9'), 1)]; // newest first, as the runs list comes
    expect(holdReason(pr(), null, inputs({ lockB, runs: both, files }))).toBe(
      'a dev deploy is running',
    );
    // devb's alone: a PR that doesn't change devb's shape isn't held by it
    expect(holdReason(pr(), null, inputs({ lockB, runs: [both[0]!], files }))).toBeNull();
  });

  it("an unattributed dispatch makes dev's card 'deploying', never free", () => {
    const v = derive(inputs({ lock: lock(null), runs: [disp(sha('9'), 1)] }));
    expect(v.slots[0]).toMatchObject({ slot: 'dev', state: 'free', deploying: true });
    expect(v.slots[1]!.deploying).toBe(false);
    expect(derive(inputs({ lock: lock(null) })).slots[0]!.deploying).toBe(false);
  });

  it("dispatch's hold is unknown when queue.json, or this lane's entry, can't be read", () => {
    const i = inputs({ files });
    i.tower.queue = { status: 'missing', data: null, problems: [] };
    expect(holdReason(pr(), null, i)).toBe("queue.json missing: dispatch's hold unknown");
    const j = inputs({ files });
    j.tower.queue = { ...j.tower.queue, status: 'bad', unread: ['echo'] };
    expect(holdReason(pr(), null, j)).toBe(
      "queue.json: this lane's entry is unreadable, dispatch's hold unknown",
    );
    j.tower.queue.unread = ['zulu'];
    expect(holdReason(pr(), null, j)).toBeNull();
    j.tower.queue.unread = 'all';
    expect(holdReason(pr(), null, j)).toMatch(/hold unknown/);
  });

  it('a holder with an unreadable expiry is a failed source, matching the amber card', () => {
    const s = sources(inputs({ lock: lock('echo', { expiresAt: null }) }));
    expect(s.find((x) => x.name === 'dev lock')).toMatchObject({
      state: 'failed',
      detail: 'holder expiry unreadable',
    });
  });
});
