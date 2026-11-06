import { describe, expect, it, vi } from 'vitest';
import { fakeClock } from '../bot/fakes.ts';
import { memFs } from '../mailroom/fakes.ts';
import type { SimResult } from '../mailroom/sim.ts';
import { IOS_NOTE, createIos } from './ios';
import { NeedsYou, needsYouReason } from './scenario';

const HJ = '/repo/.hostjobs';
const SHA = 'a'.repeat(40);

// The Mac: answers each job dropped in the inbox with `answer(job)` (null = never picks it up).
function mac(
  answer: (job: { id: string; params: { steps: { op: string }[] } }) => Partial<SimResult> | null,
  repoVersion?: () => string,
) {
  const fs = memFs([`${HJ}/inbox`]);
  const submitted: string[] = [];
  fs.onRename = (_from, to) => {
    if (!to.startsWith(`${HJ}/inbox/`)) return;
    const job = JSON.parse(fs.files.get(to) ?? '{}') as {
      id: string;
      params: { steps: { op: string }[] };
    };
    submitted.push(job.params.steps.map((s) => s.op).join(','));
    const r = answer(job);
    if (!r) return;
    fs.files.delete(to);
    fs.dirs.add(`${HJ}/results/${job.id}`);
    fs.files.set(
      `${HJ}/results/${job.id}/result.json`,
      JSON.stringify({
        v: 1,
        id: job.id,
        job: 'sim',
        status: 'pass',
        reason: null,
        startedAt: '',
        finishedAt: '',
        durationMs: 1,
        runnerVersion: 'rv',
        ...r,
      }),
    );
  };
  const copy = vi.fn();
  const logs: string[] = [];
  const ios = createIos({
    fs,
    clock: fakeClock(),
    dir: HJ,
    expectedSha: SHA,
    outDir: '/run/shots',
    copy,
    log: (s) => void logs.push(s),
    ...(repoVersion ? { repoVersion } : {}),
  });
  return { ios, copy, submitted, logs, client: ios.forScenario('ios-standalone') };
}
const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe('ctx.ios', () => {
  it('a pass returns the result, keeps its screenshots under the run, and records the job', async () => {
    const { client, copy, ios } = mac(() => ({
      shots: ['shots/01-home.png'],
      buildsSeen: ['aaaaaaa'],
      booted: 'warm',
      signedIn: 'already',
    }));
    const r = await client.run('launch', [{ op: 'launch' }, { op: 'shot', name: 'home' }]);
    expect(r.buildsSeen).toEqual(['aaaaaaa']);
    expect(copy).toHaveBeenCalledWith(
      expect.stringMatching(/\/results\/.+\/shots\/01-home\.png$/),
      '/run/shots/ios-ios-standalone-launch-01-home.png',
    );
    expect(ios.shots).toEqual(['ios-ios-standalone-launch-01-home.png']);
    expect(ios.jobs.map((j) => [j.step, j.status, j.signedIn])).toEqual([
      ['launch', 'pass', 'already'],
    ]);
  });

  it('a pass on another build is no pass for this one', async () => {
    const { client } = mac(() => ({ buildsSeen: ['bbbbbbb'] }));
    expect(String(await caught(client.run('launch', [{ op: 'launch' }])))).toMatch(
      /ran build bbbbbbb, expected aaaaaaa/,
    );
  });

  it('an unreachable Mac is needs you, and the run’s later iOS steps say so without waiting again', async () => {
    const { client, submitted, ios } = mac(() => null);
    const first = await caught(client.run('launch', [{ op: 'launch' }]));
    expect(needsYouReason(first)).toBe(`${IOS_NOTE}: MAC_UNREACHABLE`);
    expect((first as NeedsYou).stepOnly).toBe(false);
    const second = await caught(ios.forScenario('other').run('relaunch', [{ op: 'launch' }]));
    expect(needsYouReason(second)).toBe(`${IOS_NOTE}: MAC_UNREACHABLE`);
    expect(submitted).toHaveLength(1);
    expect(ios.unavailable()).toBe('MAC_UNREACHABLE');
  });

  it('no soft keyboard is needs you for that step only: the next plan still goes to the Mac', async () => {
    let n = 0;
    const { client, submitted, ios } = mac(() =>
      ++n === 1 ? { status: 'error', reason: 'SIM_UNAVAILABLE', detail: 'KEYBOARD_SETUP' } : {},
    );
    const kb = await caught(client.run('capture', [{ op: 'launch' }]));
    expect(needsYouReason(kb)).toBe(`${IOS_NOTE}: SIM_UNAVAILABLE/KEYBOARD_SETUP`);
    expect((kb as NeedsYou).stepOnly).toBe(true); // the pipeline runs the scenario's later steps
    await client.run('relaunch', [{ op: 'launch' }]);
    expect(submitted).toHaveLength(2);
    expect(ios.unavailable()).toBeNull();
  });

  it('a failed assertion fails the step, with the sim’s note, and keeps the screenshots', async () => {
    const { client, copy } = mac(() => ({
      status: 'fail',
      reason: 'ASSERT',
      detail: 'BELOW_KEYBOARD',
      shots: ['shots/01-k.png'],
      steps: [
        { i: 0, op: 'expect', status: 'fail', ms: 1, note: 'box bottom 900 vs keyboard top 600' },
      ],
    }));
    const err = await caught(client.run('done-form', [{ op: 'launch' }]));
    expect(needsYouReason(err)).toBeNull();
    expect(String(err)).toContain(
      'iOS: ASSERT/BELOW_KEYBOARD at op 0 expect: box bottom 900 vs keyboard top 600',
    );
    expect(copy).toHaveBeenCalledOnce();
  });

  it('an invalid plan is a harness bug, refused before anything reaches the Mac', async () => {
    const { client, submitted } = mac(() => ({}));
    expect(
      String(
        await caught(client.run('bad', [{ op: 'tap', label: 'Mark done', near: { x: 1, y: 1 } }])),
      ),
    ).toMatch(/invalid: DENIED_TAP/);
    expect(submitted).toEqual([]);
  });

  it('finish sends nothing when the last job already shut the sim down', async () => {
    const { ios, client, submitted } = mac(() => ({ booted: 'off' }));
    await client.run('w', [{ op: 'launch' }, { op: 'shutdown' }]);
    await ios.finish();
    expect(submitted).toEqual(['launch,shutdown']);
  });

  it('an older runner on the Mac logs the reinstall line once', async () => {
    const { client, logs } = mac(
      () => ({ runnerVersion: 'old' }),
      () => 'new',
    );
    await client.run('a', [{ op: 'launch' }]);
    await client.run('b', [{ op: 'launch' }]);
    const lines = logs.filter((l) => l.includes('reinstall'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('install.sh?ref=main');
  });

  it('the runner the repo has logs nothing', async () => {
    const { client, logs } = mac(
      () => ({ runnerVersion: 'same' }),
      () => 'same',
    );
    await client.run('a', [{ op: 'launch' }]);
    expect(logs.filter((l) => l.includes('reinstall'))).toEqual([]);
  });

  it('finish shuts the sim down only after a job ran and the Mac was reachable', async () => {
    const a = mac(() => ({}));
    await a.ios.finish();
    expect(a.submitted).toEqual([]);
    await a.client.run('launch', [{ op: 'launch' }]);
    await a.ios.finish();
    expect(a.submitted).toEqual(['launch', 'shutdown']);
    const b = mac(() => null);
    await caught(b.client.run('launch', [{ op: 'launch' }]));
    await b.ios.finish();
    expect(b.submitted).toEqual(['launch']);
  });

  it('a reachable Mac that left the sim booted (NOT_LAUNCHED) still gets the shutdown', async () => {
    let n = 0;
    const { client, ios, submitted } = mac(() =>
      ++n === 1 ? { status: 'error', reason: 'SIM_UNAVAILABLE', detail: 'NOT_LAUNCHED' } : {},
    );
    await caught(client.run('capture', [{ op: 'blur' }]));
    expect(ios.unavailable()).toBe('SIM_UNAVAILABLE/NOT_LAUNCHED');
    await ios.finish();
    expect(submitted).toEqual(['blur', 'shutdown']);
  });
});
