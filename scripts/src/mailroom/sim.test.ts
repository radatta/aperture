import { describe, expect, it } from 'vitest';
import { fakeClock } from '../bot/fakes.ts';
import { memFs } from './fakes.ts';
import {
  HEARTBEAT_MS,
  IosAssert,
  IosUnavailable,
  PICKUP_MS,
  makeSimJob,
  runSimJob,
  validateSimParams,
} from './sim.ts';
import type { SimParams, SimResult } from './sim.ts';

const HJ = '/repo/.hostjobs';
const params: SimParams = {
  sha: 'a'.repeat(40),
  timeoutSec: 120,
  shutdown: false,
  steps: [{ op: 'launch' }, { op: 'readBuild' }, { op: 'expectBuild' }],
};
const job = makeSimJob(
  'ios-standalone',
  params,
  Date.parse('2026-11-04T19:00:00Z'),
  '20261104T190000Z-ios-x-ab12',
);
const rdir = `${HJ}/results/${job.id}`;
const res = (r: Partial<SimResult>): string =>
  JSON.stringify({
    v: 1,
    id: job.id,
    job: 'sim',
    status: 'pass',
    reason: null,
    startedAt: '',
    finishedAt: '',
    durationMs: 1,
    runnerVersion: 'v',
    ...r,
  });

// The Mac, played by a hook on each poll: `script(n)` runs before the n-th read of anything under results/.
function world(
  script: (n: number, fs: ReturnType<typeof memFs>, clock: ReturnType<typeof fakeClock>) => void,
) {
  const fs = memFs([`${HJ}/inbox`]);
  const clock = fakeClock();
  let n = 0;
  const isDir = fs.isDir;
  fs.isDir = (p) => {
    if (p === rdir) script(++n, fs, clock);
    return isDir(p);
  };
  const read = fs.read;
  fs.read = (p) => {
    if (p.startsWith(rdir)) script(++n, fs, clock);
    return read(p);
  };
  return { fs, clock, d: { fs, clock, dir: HJ, log: () => {} } };
}

describe('runSimJob', () => {
  it('returns a pass once the Mac picks the job up and writes its result', async () => {
    const { fs, d } = world((n, f) => {
      if (n === 3) f.dirs.add(rdir);
      if (n === 6) f.files.set(`${rdir}/result.json`, res({ buildsSeen: ['aaaaaaa'] }));
    });
    const r = await runSimJob(d, job);
    expect(r.buildsSeen).toEqual(['aaaaaaa']);
    expect(fs.files.has(`${HJ}/inbox/${job.id}.json`)).toBe(true); // the hook doesn't play the Mac's move
  });

  it('withdraws an unclaimed job after the pickup window: MAC_UNREACHABLE, nothing left queued', async () => {
    const { fs, clock, d } = world(() => {});
    const t0 = clock.t;
    const err = await runSimJob(d, job).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IosUnavailable);
    expect((err as IosUnavailable).reason).toBe('MAC_UNREACHABLE');
    expect(clock.t - t0).toBeGreaterThanOrEqual(PICKUP_MS);
    expect(clock.t - t0).toBeLessThan(PICKUP_MS + 5_000);
    expect(fs.files.has(`${HJ}/inbox/${job.id}.json`)).toBe(false);
    expect(fs.files.has(`${HJ}/staging/${job.id}.withdrawn.json`)).toBe(true);
  });

  it('keeps waiting when the Mac took the job just as the window closed', async () => {
    const { d } = world((n, f, c) => {
      if (
        c.t - Date.parse('2026-10-13T20:00:00Z') >= PICKUP_MS &&
        f.files.has(`${HJ}/inbox/${job.id}.json`)
      )
        f.files.delete(`${HJ}/inbox/${job.id}.json`); // taken: withdraw finds nothing
      if (n > 60 && !f.files.has(`${rdir}/result.json`))
        f.files.set(`${rdir}/result.json`, res({}));
    });
    await expect(runSimJob(d, job)).resolves.toMatchObject({ status: 'pass' });
  });

  it('a stalled heartbeat is MAC_STALLED, judged on the container clock', async () => {
    const { clock, d } = world((n, f) => {
      if (n === 1) f.dirs.add(rdir);
    });
    const t0 = clock.t;
    const err = await runSimJob(d, job).catch((e: unknown) => e);
    expect((err as IosUnavailable).reason).toBe('MAC_STALLED');
    expect(clock.t - t0).toBeGreaterThan(Math.min(HEARTBEAT_MS, job.params.timeoutSec * 1000));
  });

  it('a moving heartbeat keeps the wait alive past the heartbeat window, up to the job deadline', async () => {
    const long = { ...job, params: { ...params, timeoutSec: 600 } };
    let beats = 0;
    const { clock, d } = world((n, f, c) => {
      if (n === 1) f.dirs.add(rdir);
      f.mtimes.set(`${rdir}/progress.json`, ++beats); // a new mtime every poll
      if (c.t - Date.parse('2026-10-13T20:00:00Z') > HEARTBEAT_MS + 60_000)
        f.files.set(`${rdir}/result.json`, res({}));
    });
    const t0 = clock.t;
    await expect(runSimJob(d, long)).resolves.toMatchObject({ status: 'pass' });
    expect(clock.t - t0).toBeGreaterThan(HEARTBEAT_MS);
  });

  it('maps fail to IosAssert with the failing op, error/expired to IosUnavailable, rejected to a harness bug', async () => {
    const run = (r: Partial<SimResult>) =>
      runSimJob(
        world((n, f) => {
          if (n === 1) f.dirs.add(rdir);
          if (n === 2) f.files.set(`${rdir}/result.json`, res(r));
        }).d,
        job,
      ).catch((e: unknown) => e);
    const fail = await run({
      status: 'fail',
      reason: 'ASSERT',
      detail: 'BELOW_KEYBOARD',
      steps: [
        { i: 0, op: 'launch', status: 'pass', ms: 1 },
        { i: 1, op: 'expect', status: 'fail', ms: 1, note: 'bar bottom 831 vs keyboard top 493' },
      ],
    });
    expect(fail).toBeInstanceOf(IosAssert);
    expect((fail as Error).message).toBe(
      'ASSERT/BELOW_KEYBOARD at op 1 expect: bar bottom 831 vs keyboard top 493',
    );
    const err = await run({
      status: 'error',
      reason: 'SIM_UNAVAILABLE',
      detail: 'KEYBOARD_SETUP',
      shots: ['shots/01-fail.png'],
    });
    expect((err as IosUnavailable).reason).toBe('SIM_UNAVAILABLE/KEYBOARD_SETUP');
    expect((err as Error).message).toContain('KEYBOARD_SETUP');
    expect((err as IosUnavailable).result?.shots).toEqual(['shots/01-fail.png']); // ios.ts keeps them
    expect(((await run({ status: 'expired', reason: 'EXPIRED' })) as IosUnavailable).reason).toBe(
      'MAC_UNREACHABLE',
    );
    const rej = await run({ status: 'rejected', reason: 'BAD_OP' });
    expect(rej).not.toBeInstanceOf(IosUnavailable);
    expect((rej as Error).message).toMatch(/harness bug/);
    // runner.sh's fallback when run_sim itself died: a runner bug fails, never reads as an unavailable Mac
    const crash = await run({ status: 'error', reason: 'API_FAILED' });
    expect(crash).not.toBeInstanceOf(IosUnavailable);
    expect((crash as Error).message).toMatch(/runner crashed in the sim job/);
  });

  it('no mailroom at all is MAC_UNREACHABLE, not a crash', async () => {
    const err = await runSimJob(
      { fs: memFs(), clock: fakeClock(), dir: HJ, log: () => {} },
      job,
    ).catch((e: unknown) => e);
    expect((err as IosUnavailable).reason).toBe('MAC_UNREACHABLE');
  });
});

describe('validateSimParams', () => {
  it('passes a canonical plan and refuses the runner-side reasons in order', () => {
    expect(validateSimParams(params)).toBeNull();
    expect(validateSimParams({ ...params, steps: Array(81).fill({ op: 'wait', s: 1 }) })).toBe(
      'TOO_MANY_OPS',
    );
    expect(
      validateSimParams({
        ...params,
        steps: [{ op: 'tap', label: 'Mark done', near: { x: 1, y: 1 } }],
      }),
    ).toBe('DENIED_TAP');
    const tap = (label: string) =>
      validateSimParams({ ...params, steps: [{ op: 'tap', label, near: { x: 1, y: 1 } }] });
    expect(tap('Start timer')).toBe('DENIED_TAP'); // an entry and a space
    expect(tap('Focus')).toBe('DENIED_TAP');
    expect(tap('send')).toBe('DENIED_TAP');
    expect(tap('Saved')).toBeNull();
    expect(tap('Done')).toBeNull();
    // keys `in` names an earlier find/tap, like expect's `as`
    const find = { op: 'find', label: 'Capture log', near: { x: 1, y: 1 }, as: 'bar' };
    const keys = (inName: unknown, before = true) =>
      validateSimParams({
        ...params,
        steps: before
          ? [find, { op: 'keys', text: 'ab', in: inName }]
          : [{ op: 'keys', text: 'ab', in: inName }, find],
      });
    expect(keys('bar')).toBeNull();
    expect(keys('nope')).toBe('BAD_OP');
    expect(keys('bar', false)).toBe('BAD_OP');
    expect(keys('Bar')).toBe('BAD_OP');
    expect(keys(1)).toBe('BAD_OP');
    // erase `in` too; a bare erase stays valid
    const erase = (inName: unknown, before = true) =>
      validateSimParams({
        ...params,
        steps: before
          ? [find, { op: 'erase', n: 2, in: inName }]
          : [{ op: 'erase', n: 2, in: inName }, find],
      });
    expect(erase('bar')).toBeNull();
    expect(erase('nope')).toBe('BAD_OP');
    expect(erase('bar', false)).toBe('BAD_OP');
    expect(erase(1)).toBe('BAD_OP');
    expect(validateSimParams({ ...params, steps: [{ op: 'erase', n: 2 }] })).toBeNull();
    // tap `closes` is true or absent, and only on a tap
    const closes = (op: string, v: unknown) =>
      validateSimParams({
        ...params,
        steps: [{ op, label: 'Cancel', near: { x: 1, y: 1 }, as: 'c', closes: v }],
      });
    expect(closes('tap', true)).toBeNull();
    expect(closes('tap', false)).toBe('BAD_OP');
    expect(closes('tap', 'yes')).toBe('BAD_OP');
    expect(closes('find', true)).toBe('BAD_OP');
    // the first bad op decides: a malformed op before a denied tap is BAD_OP
    expect(
      validateSimParams({
        ...params,
        steps: [
          { op: 'keys', text: 'A' },
          { op: 'tap', label: 'Save', near: { x: 1, y: 1 } },
        ],
      }),
    ).toBe('BAD_OP');
  });
});
