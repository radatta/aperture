import { describe, expect, it } from 'vitest';
import { fakeClock, fakeRun } from '../bot/fakes.ts';
import { memFs } from './fakes.ts';
import { PICKUP_MS, fixturesJob } from './fixtures-job.ts';
import { EXIT } from './open-pr.ts';
import type { Deps } from './open-pr.ts';
import type { Result } from './submit.ts';

const HJ = '/workspace/.hostjobs';
const ROOT = '/workspace/.claude/worktrees/mailroom-v2';
const SHA = 'a'.repeat(40);

type Sent = { id: string; job: string; params: { sha: string } };
function setup(opts: { mac?: (job: Sent) => Partial<Result> | 'take' | null; diff?: string } = {}) {
  const fs = memFs([`${HJ}/inbox`]);
  const { run } = fakeRun([
    ['git symbolic-ref', 'mailroom-v2'],
    ['git rev-parse HEAD', SHA],
    ['git ls-remote', `${SHA}\trefs/heads/mailroom-v2`],
    ['git diff', opts.diff ?? 'tools/mailroom/runner.sh'],
  ]);
  const clock = fakeClock();
  const logs: string[] = [];
  const sent: Sent[] = [];
  fs.onRename = (_from, to) => {
    if (!to.startsWith(`${HJ}/inbox/`) || !opts.mac) return;
    const job = JSON.parse(fs.files.get(to) ?? '{}') as Sent;
    sent.push(job);
    const answer = opts.mac(job);
    if (answer === null) return;
    fs.files.delete(to);
    fs.mkdirp(`${HJ}/results/${job.id}`);
    if (answer === 'take') return;
    fs.files.set(
      `${HJ}/results/${job.id}/result.json`,
      JSON.stringify({
        v: 1,
        id: job.id,
        job: 'fixtures',
        runnerVersion: 'v1',
        durationMs: 90_000,
        startedAt: 'T',
        ...answer,
      }),
    );
  };
  const d: Deps = {
    run,
    fs,
    clock,
    dir: HJ,
    root: ROOT,
    repoVersion: () => 'v1',
    log: (s) => logs.push(s),
  };
  return { d, fs, logs, sent };
}

describe('fixturesJob', () => {
  it('runs the pushed head in the slow lane and reports a pass', async () => {
    const { d, logs, sent } = setup({
      mac: () => ({
        status: 'pass',
        reason: null,
        fixtures: { passed: 499, failed: 0, cases: 499, failing: [] },
      }),
    });
    expect(await fixturesJob(d)).toBe(EXIT.ok);
    expect(sent[0]?.params).toEqual({ sha: SHA });
    expect(sent[0]?.id).toMatch(/^\d{8}T\d{6}Z-fx-aaaaaaaaaaaa-[0-9a-f]{4}$/);
    expect(logs.at(-1)).toMatch(
      /^fixtures pass on the Mac: 499\/499 at aaaaaaa \(log: .*fixtures\.log\)$/,
    );
  });

  it('lists the failing cases and the log on a fail', async () => {
    const { d, logs } = setup({
      mac: () => ({
        status: 'fail',
        reason: 'FIXTURES_FAILED',
        fixtures: {
          passed: 497,
          failed: 2,
          cases: 499,
          failing: ['lanes: x: why', 'clip: y: why'],
          exit: 1,
        },
      }),
    });
    expect(await fixturesJob(d)).toBe(EXIT.failed);
    const out = logs.join('\n');
    expect(out).toContain('fixtures fail: FIXTURES_FAILED — 497 passed, 2 failed, of 499');
    expect(out).toContain('  not ok - lanes: x: why');
    expect(out).toMatch(/log tail: .*fixtures\.log/);
  });

  it('refuses a branch touching install.sh or the plist before submitting, as the Mac would', async () => {
    for (const f of [
      'tools/mailroom/install.sh',
      'tools/mailroom/dev.rahuldatta.aperture.mailroom.plist.tmpl',
    ]) {
      const { d, logs, sent } = setup({ diff: f, mac: () => ({ status: 'pass' }) });
      expect(await fixturesJob(d)).toBe(EXIT.failed);
      expect(logs[0]).toMatch(/TOUCHES_INSTALL/);
      expect(sent).toHaveLength(0);
    }
  });

  it('turns a Mac refusal into what to do', async () => {
    const { d, logs } = setup({ mac: () => ({ status: 'error', reason: 'SANDBOX_MISSING' }) });
    expect(await fixturesJob(d)).toBe(EXIT.failed);
    expect(logs.at(-1)).toMatch(/never runs unsandboxed/);
  });

  it('takes --sha, and refuses one that is not a full commit', async () => {
    const other = 'b'.repeat(40);
    const { d, sent } = setup({
      mac: () => ({ status: 'pass', fixtures: { passed: 1, failed: 0, cases: 1, failing: [] } }),
    });
    expect(await fixturesJob(d, other)).toBe(EXIT.ok);
    expect(sent[0]?.params.sha).toBe(other);
    expect(await fixturesJob(setup().d, 'abc123')).toBe(EXIT.usage);
  });

  it('withdraws a job no lane picked up, and says so', async () => {
    const { d, fs, logs } = setup({ mac: () => null });
    expect(await fixturesJob(d)).toBe(EXIT.unreachable);
    expect([...fs.files.keys()].some((k) => k.endsWith('.withdrawn.json'))).toBe(true);
    expect(logs.at(-1)).toMatch(new RegExp(`no pickup in ${PICKUP_MS / 60_000} min`));
  });

  it('is stalled, not a crash, when the Mac took it and never answered', async () => {
    const { d, logs } = setup({ mac: () => 'take' });
    expect(await fixturesJob(d)).toBe(EXIT.unreachable);
    expect(logs.at(-1)).toMatch(/MAC_STALLED/);
  });
});
