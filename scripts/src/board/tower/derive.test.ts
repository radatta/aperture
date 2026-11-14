import { describe, expect, it } from 'vitest';
import { deployFor, derive, holdReason, laneRow, liveLock, sources, type Inputs } from './derive.ts';
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
const aws: Costs = { state: 'ok', at: NOW - 3600e3, error: null, month: '2026-11', through: '2026-11-12', total: 0.57, byAccount: { dev: 0.54, prod: 0.03 } };

function inputs(over: {
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
  rahul?: { text: string; since: string | null }[];
} = {}): Inputs {
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
        rahul: over.rahul ?? [],
        wave: null,
        deadRows: null,
        plan: [],
        followups: over.followups ?? [],
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
    checks: (s) => (over.checks?.[s] ? { runs: over.checks[s]!, at: NOW - MIN, error: null } : null),
    files: (s) => (over.files?.[s] ? { files: over.files[s]!, error: null } : null),
    minutes: null,
    mac: over.mac ?? mac,
    aws,
    tests: 1,
    testCap: 4,
    macInstall: 'cd /x && install',
    midnight: Date.parse('2026-11-13T08:00:00Z'),
  };
}
const green = { [sha('e')]: [run(), run({ id: 2, name: 'Secret scan' })] };
const row = (i: Inputs, c: Partial<Parameters<typeof laneRow>[0]> = {}) =>
  laneRow({ branch: 'echo', file: null, queue: null, pr: null, ...c }, i);

describe('laneRow states', () => {
  it('BUILDING with the phase word and step, or "no status file" in grey', () => {
    expect(row(inputs())).toMatchObject({ state: 'BUILDING', detail: 'no status file', tone: 'dim', fileAge: null });
    const r = row(inputs(), { file: file({ phase: 'review', step: 'round 2 of 3' }) });
    expect(r).toMatchObject({ state: 'BUILDING', detail: 'Review · round 2 of 3', since: NOW - 20 * MIN, fileAge: 300 });
    expect(row(inputs(), { file: file({ phase: 'blocked' }) }).tone).toBe('bad');
  });

  it('TESTING on dev or devb while it holds a live lock; an expired lock is not testing', () => {
    expect(row(inputs({ lock: lock('echo') }))).toMatchObject({ state: 'TESTING', label: 'TESTING on dev' });
    expect(row(inputs({ lockB: lock('echo') }))).toMatchObject({ label: 'TESTING on devb' });
    expect(row(inputs({ lock: lock('echo', { expiresAt: NOW - 1 }) })).state).toBe('BUILDING');
  });

  it("TESTING's detail: deploying, then devcheck running, then held for Rahul, then the step", () => {
    const deploying = run({ name: `deploy-dev ${sha('a')} echo-k`, event: 'workflow_dispatch', branch: 'main', status: 'in_progress' });
    expect(row(inputs({ lock: lock('echo'), runs: [deploying] })).detail).toBe('deploying');
    const ledger = [{ run: 'r1', start: NOW - 4 * MIN, end: null, status: null, full: true, slot: 'dev' as const }];
    expect(row(inputs({ lock: lock('echo'), ledger })).detail).toMatch(/^devcheck running since \d\d:\d\d$/);
    // an orphan run (no end, over 2 h old) is not in flight
    const orphan = [{ ...ledger[0]!, start: NOW - 3 * 3600e3 }];
    expect(row(inputs({ lock: lock('echo'), ledger: orphan }), { file: file({ step: 'devcheck full' }) }).detail).toBe('devcheck full');
    const needs = { what: 'Safari pass', link: null, cmd: 'open x', unblocks: null };
    expect(row(inputs({ lock: lock('echo') }), { file: file({ needs }) }).detail).toBe('held for Rahul: Safari pass');
  });

  it('PR states from the head sha checks: running, none seen, failed, draft', () => {
    const p = pr();
    expect(row(inputs({ checks: { [sha('e')]: [run({ status: 'in_progress', conclusion: null })] } }), { pr: p })).toMatchObject({
      label: 'PR (checks running)',
      tone: 'warn',
    });
    expect(row(inputs(), { pr: p })).toMatchObject({ label: 'PR (no checks seen)', tone: 'warn' });
    expect(row(inputs({ checks: { [sha('e')]: [run({ conclusion: 'failure' })] } }), { pr: p })).toMatchObject({
      state: 'CHECKS FAILED',
      detail: 'PR failure',
      tone: 'bad',
    });
    expect(row(inputs({ checks: green }), { pr: pr({ draft: true }) }).label).toBe('PR (draft)');
  });

  it('MERGE ME when every check passed and nothing holds it', () => {
    expect(row(inputs({ checks: green }), { pr: pr() })).toMatchObject({ state: 'MERGE ME', tone: 'good', hold: null });
  });

  it('MERGED → DEPLOYING → DONE / DEPLOY FAILED from main Deploy runs', () => {
    const merged = pr({ state: 'MERGED', mergedAt: NOW - 5 * MIN, mergeSha: sha('m') });
    expect(row(inputs(), { pr: merged })).toMatchObject({ state: 'MERGED', detail: 'deploy run not seen yet' });
    const dep = (o: Partial<GhRun>) => run({ name: 'Deploy', event: 'push', branch: 'main', sha: sha('m'), ...o });
    expect(row(inputs({ runs: [dep({ status: 'in_progress', conclusion: null })] }), { pr: merged }).state).toBe('DEPLOYING');
    expect(row(inputs({ runs: [dep({})] }), { pr: merged }).state).toBe('DONE');
    expect(row(inputs({ runs: [dep({ conclusion: 'failure' })] }), { pr: merged })).toMatchObject({ state: 'DEPLOY FAILED', tone: 'bad' });
  });

  it('PARKED from the lane file or dispatch’s PARKED word', () => {
    expect(row(inputs(), { file: file({ phase: 'parked' }) }).state).toBe('PARKED');
    expect(row(inputs(), { queue: queueLane({ waitingOn: 'PARKED until Fri' }) }).state).toBe('PARKED');
  });
});

describe('deployFor', () => {
  const dep = (s: string, created: number, o: Partial<GhRun> = {}) =>
    run({ name: 'Deploy', event: 'push', branch: 'main', sha: s, createdAt: created, ...o });
  it("a merge whose own run was cancelled by a later merge rides the later run", () => {
    const runs = [dep(sha('1'), NOW - 9 * MIN, { conclusion: 'cancelled' }), dep(sha('2'), NOW - 5 * MIN, { status: 'in_progress', conclusion: null, number: 9 })];
    expect(deployFor(sha('1'), runs)).toMatchObject({ run: { number: 9 }, via: { conclusion: 'cancelled' } });
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
});

describe('holdReason (the automatic HOLD)', () => {
  const p = pr();
  it('(a) another branch holds dev → HOLD with who and until when', () => {
    expect(holdReason(p, null, inputs({ lock: lock('bravo') }))).toMatch(/^dev: bravo is testing, lock to \d\d:\d\d$/);
    expect(row(inputs({ lock: lock('bravo'), checks: green }), { pr: p })).toMatchObject({ state: 'HOLD', tone: 'warn' });
  });
  it('an expired lock, or the PR’s own branch’s lock, never holds', () => {
    expect(holdReason(p, null, inputs({ lock: lock('bravo', { expiresAt: NOW - 1 }) }))).toBeNull();
    expect(holdReason(p, null, inputs({ lock: lock('echo') }))).toBeNull();
  });
  it('(b) devb busy holds only a PR that changes devb’s shape, or whose files are unread', () => {
    const i = (files: string[] | null) => inputs({ lockB: lock('juliet'), ...(files ? { files: { [sha('e')]: files } } : {}) });
    expect(holdReason(p, null, i(['app/src/x.ts']))).toBeNull();
    expect(holdReason(p, null, i(['cdk/lib/x.ts']))).toMatch(/changes devb's shape/);
    expect(holdReason(p, null, i(['pnpm-lock.yaml']))).toMatch(/shape/);
    expect(holdReason(p, null, i(['packages/shared/src/stage.ts']))).toMatch(/shape/);
    expect(holdReason(p, null, i(null))).toMatch(/aren't read yet/);
  });
  it('(c) a main deploy running', () => {
    const r = run({ name: 'Deploy', event: 'push', branch: 'main', status: 'queued', conclusion: null, number: 280 });
    expect(holdReason(p, null, inputs({ runs: [r] }))).toBe('main deploy 280 running');
  });
  it("(d) dispatch's hold word, last", () => {
    expect(holdReason(p, queueLane({ hold: 'after the Safari pass' }), inputs())).toBe('after the Safari pass');
    expect(holdReason(p, queueLane({ hold: 'x' }), inputs({ lock: lock('bravo') }))).toMatch(/^dev:/);
  });
});

describe('derive', () => {
  it('NEEDS YOU: lane asks, then merges with what they unblock, failed deploys, to-dos, the Mac agent', () => {
    const needs = { what: 'Safari pass', link: null, cmd: 'open -a Safari x', unblocks: 'lc PR' };
    const merged = pr({ number: 48, branch: 'golf', state: 'MERGED', mergedAt: NOW - 50 * MIN, mergeSha: sha('9') });
    const v = derive(
      inputs({
        lanes: [file({ branch: 'india', needs })],
        prs: [pr(), merged],
        checks: green,
        runs: [run({ name: 'Deploy', event: 'push', branch: 'main', sha: sha('9'), conclusion: 'failure' })],
        devQueue: [queueLane({ branch: 'delta', state: 'waiting', waitingOn: 'Rahul: merge PR 50' })],
        rahul: [{ text: 'answer §5', since: '2026-11-12' }],
        mac: { state: 'missing', at: null, error: null, stats: null },
      }),
    );
    expect(v.needs.map((n) => n.kind)).toEqual(['lane', 'merge', 'deploy', 'todo', 'source']);
    expect(v.needs[0]).toMatchObject({ what: 'india: Safari pass', cmd: 'open -a Safari x', unblocks: 'lc PR' });
    expect(v.needs[1]).toMatchObject({ what: 'Merge PR 50: A change', link: pr().url, unblocks: 'delta' });
    expect(v.needs[2]!.what).toBe('Main deploy failed after PR 48');
    expect(v.needs[4]).toMatchObject({ what: 'Install the Mac stats agent', cmd: 'cd /x && install' });
    expect(v.next.rahul).toBe('india: Safari pass');
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
    expect(v.active.map((r) => r.branch)).toEqual(['zulu', 'alpha', 'bravo', 'mike', 'kilo', 'yankee']);
  });

  it('DONE TODAY: merges since local midnight with their deploy result', () => {
    const m = (n: number, at: number, s: string) => pr({ number: n, branch: `b${n}`, state: 'MERGED', mergedAt: at, mergeSha: sha(s) });
    const v = derive(
      inputs({
        prs: [m(1, NOW - 60 * MIN, '1'), m(2, NOW - 30 * MIN, '2'), m(3, Date.parse('2026-11-12T20:00:00Z'), '3')],
        runs: [run({ name: 'Deploy', event: 'push', branch: 'main', sha: sha('1') })],
      }),
    );
    expect(v.done.map((d) => [d.number, d.deploy, d.tone])).toEqual([
      [2, 'deploy not seen', 'warn'],
      [1, 'deployed', 'good'],
    ]);
  });

  it('SLIPPING: STALE follow-ups at 24 h, parked lanes, lanes quiet for a day', () => {
    const f = (id: string, since: number, o = {}) => ({ id, what: 'w', owner: 'lane', after: 'now', status: 'open', source: null, since, ...o });
    const v = derive(
      inputs({
        followups: [f('F1', NOW - 24 * 3600e3 - 1000), f('F2', NOW - 24 * 3600e3 + 1000), f('F3', 0, { after: 'wave 4' }), f('F4', 0, { status: 'tracked' })],
        lanes: [file({ branch: 'parky', phase: 'parked' }), file({ branch: 'quiet', updatedAt: NOW - 25 * 3600e3 })],
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
    const i = inputs({ lock: lock(null, { failed: true }) });
    i.tower.prs = { list: [pr()], at: NOW - 10 * MIN, error: 'HTTP 502' };
    i.runs = { value: [], at: NOW - 10 * MIN, error: null, tried: NOW };
    const s = Object.fromEntries(sources(i).map((r) => [r.name, r]));
    expect(Object.keys(s)).toEqual(['sampler', 'dev lock', 'devb lock', 'queue.json', 'gh PRs', 'gh runs', 'Actions minutes', 'Mac stats', 'AWS costs', 'lane files']);
    expect(s['sampler']!.state).toBe('missing');
    expect(s['dev lock']).toMatchObject({ state: 'failed', detail: 'last refresh failed' });
    expect(s['gh PRs']).toMatchObject({ state: 'failed', detail: 'HTTP 502' });
    expect(s['gh runs']!.state).toBe('stale');
    expect(s['Actions minutes']!.state).toBe('missing');
    // a failed PR read keeps the last list: the lanes still show
    expect(derive(i).active.map((r) => r.branch)).toEqual(['echo']);
  });
  it('liveLock needs a branch and a future expiry', () => {
    expect(liveLock(lock('x'), NOW)).toBe(true);
    expect(liveLock(lock('x', { expiresAt: null }), NOW)).toBe(false);
    expect(liveLock(null, NOW)).toBe(false);
  });
});
