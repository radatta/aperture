import { describe, expect, it } from 'vitest';
import {
  parseMarker,
  pickDeployRun,
  waitForDeploy,
  type DeployDeps,
  type DeployRun,
} from './deploy';

const SHA = 'a'.repeat(40);
const run = (over: Partial<DeployRun>): DeployRun => ({
  databaseId: 1,
  headSha: 'f'.repeat(40),
  displayTitle: 'some commit',
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/x/runs/1',
  createdAt: '2026-10-13T10:00:00Z',
  ...over,
});
// A dispatched run for `sha` (deploy-dev.yml names it in the title; headSha is the ref's).
const forSha = (over: Partial<DeployRun> = {}) =>
  run({ displayTitle: `deploy-dev ${SHA} k1`, ...over });
const shell = (sha: string) =>
  `<html><head><meta name="aperture-build" content="${sha}" /></head></html>`;

describe('pickDeployRun', () => {
  it('matches by run name, newest first', () => {
    const runs = [
      forSha({ databaseId: 1 }),
      forSha({ databaseId: 2, createdAt: '2026-10-13T11:00:00Z' }),
    ];
    expect(pickDeployRun(runs, SHA)?.databaseId).toBe(2);
  });
  it('ignores a run whose headSha is the SHA but whose title is not a dispatch (an old `dev` push)', () => {
    expect(pickDeployRun([run({ headSha: SHA })], SHA)).toBeUndefined();
  });
  it('matches a dispatched run by its run name, whatever its headSha', () => {
    const r = run({ displayTitle: `deploy-dev ${SHA} k1`, databaseId: 9 });
    expect(pickDeployRun([r], SHA)?.databaseId).toBe(9);
    expect(
      pickDeployRun([run({ displayTitle: `deploy-dev ${'b'.repeat(40)} k1` })], SHA),
    ).toBeUndefined();
  });
});

describe('parseMarker', () => {
  it('reads the meta, or undefined', () => {
    expect(parseMarker(shell(SHA))).toBe(SHA);
    expect(parseMarker(shell('local'))).toBe('local');
    expect(parseMarker('<html></html>')).toBeUndefined();
  });
});

function deps(runs: DeployRun[][], shells: string[]): DeployDeps & { t: number } {
  const d = {
    t: 0,
    listRuns: async () => runs[Math.min(runs.length - 1, (d.calls += 1) - 1)]!,
    fetchShell: async () => shells.shift() ?? shell('stale'),
    sleep: async (ms: number) => void (d.t += ms),
    now: () => d.t,
    log: () => undefined,
    calls: 0,
  };
  return d;
}

describe('waitForDeploy', () => {
  it('waits for the run, then for the edge to serve the SHA', async () => {
    const d = deps(
      [[forSha({ status: 'in_progress', conclusion: '' })], [forSha()]],
      [shell('old'), shell(SHA)],
    );
    expect((await waitForDeploy(SHA, d)).displayTitle).toBe(`deploy-dev ${SHA} k1`);
  });
  it('rides out a transient gh failure, but not five in a row', async () => {
    const d = deps([[forSha()]], [shell(SHA)]);
    let calls = 0;
    const flaky = d.listRuns;
    d.listRuns = async () => (++calls === 1 ? Promise.reject(new Error('gh: network')) : flaky());
    expect((await waitForDeploy(SHA, d)).displayTitle).toBe(`deploy-dev ${SHA} k1`);
    let failures = 0;
    d.listRuns = async () => (failures++, Promise.reject(new Error('gh: auth')));
    await expect(waitForDeploy(SHA, d)).rejects.toThrow(/gh: auth/);
    expect(failures).toBe(5);
  });
  it('DEPLOY_FAILED when the run failed', async () => {
    await expect(
      waitForDeploy(SHA, deps([[forSha({ conclusion: 'failure' })]], [])),
    ).rejects.toThrow(/DEPLOY_FAILED/);
  });
  it('DEPLOY_NOT_FOUND when no run appears', async () => {
    await expect(waitForDeploy(SHA, deps([[run({})]], []))).rejects.toThrow(
      /DEPLOY_NOT_FOUND.*latest dispatch: some commit.*pnpm bot deploy-dev/,
    );
  });
  it('DEPLOY_TIMEOUT when the edge never serves the SHA', async () => {
    await expect(waitForDeploy(SHA, deps([[forSha()]], []))).rejects.toThrow(
      /DEPLOY_TIMEOUT.*serves build stale/,
    );
  });
  it('DEPLOY_TIMEOUT names an unreachable edge rather than "serves build none"', async () => {
    const d = deps([[forSha()]], []);
    d.fetchShell = async () => Promise.reject(new Error('ECONNRESET'));
    await expect(waitForDeploy(SHA, d)).rejects.toThrow(/DEPLOY_TIMEOUT.*unreachable: ECONNRESET/);
  });
  it('DEPLOY_TIMEOUT when the run never completes', async () => {
    const d = deps([[forSha({ status: 'in_progress', conclusion: '' })]], []);
    await expect(
      waitForDeploy(SHA, d, { runMs: 60_000, edgeMs: 1, pollMs: 15_000 }),
    ).rejects.toThrow(/DEPLOY_TIMEOUT.*in_progress/);
  });
});
