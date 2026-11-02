import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../bot/fakes.ts';
import { makeOpenPrJob } from './job.ts';
import { TOOLS_DIR } from './fixtures.ts';
import { memFs } from './fakes.ts';
import {
  NotInstalled,
  lastSeen,
  repoRunnerVersion,
  submit,
  waitForResult,
  withdraw,
} from './submit.ts';

const HJ = '/repo/.hostjobs';
const job = makeOpenPrJob(
  { branch: 'mac-mailroom', sha: 'a'.repeat(40), title: 'Mac mailroom', body: 'b' },
  Date.parse('2026-11-01T20:45:12Z'),
  '20261101T204512Z-mac-mailroom-ab12',
);
const inbox = `${HJ}/inbox/${job.id}.json`;
const result = `${HJ}/results/${job.id}/result.json`;

describe('submit', () => {
  it('stages the job, then renames it whole into the inbox', () => {
    const fs = memFs([`${HJ}/inbox`]);
    const seen: string[] = [];
    fs.onRename = (a, b) => seen.push(`${a} -> ${b}`);
    submit(fs, HJ, job);
    expect(seen).toEqual([`${HJ}/staging/${job.id}.json -> ${inbox}`]);
    expect(JSON.parse(fs.files.get(inbox) ?? '')).toEqual(job);
  });

  it('refuses when the Mac never made an inbox', () => {
    expect(() => submit(memFs(), HJ, job)).toThrow(NotInstalled);
  });

  it('never overwrites a staged job of the same id', () => {
    const fs = memFs([`${HJ}/inbox`]);
    fs.files.set(`${HJ}/staging/${job.id}.json`, 'other');
    expect(() => submit(fs, HJ, job)).toThrow(/EEXIST/);
  });
});

describe('waitForResult', () => {
  it('resolves once result.json parses, skipping a partial write', async () => {
    const fs = memFs();
    const clock = fakeClock();
    let polls = 0;
    const read = fs.read;
    fs.read = (p) => {
      polls++;
      if (polls === 2) fs.files.set(result, '{"v":1,"id":');
      if (polls === 3) fs.files.set(result, JSON.stringify({ v: 1, id: job.id, status: 'opened' }));
      return read(p);
    };
    const r = await waitForResult(fs, clock, HJ, job.id, 60_000);
    expect(r?.status).toBe('opened');
    expect(polls).toBe(3);
  });

  it('ignores a result for another id', async () => {
    const fs = memFs();
    fs.files.set(result, JSON.stringify({ v: 1, id: 'other', status: 'opened' }));
    expect(await waitForResult(fs, fakeClock(), HJ, job.id, 10_000)).toBeNull();
  });

  it('gives up at the deadline', async () => {
    const clock = fakeClock();
    const start = clock.now();
    expect(await waitForResult(memFs(), clock, HJ, job.id, 180_000)).toBeNull();
    expect(clock.now() - start).toBe(180_000);
  });
});

describe('withdraw', () => {
  it('takes an unclaimed job back out of the inbox', () => {
    const fs = memFs();
    fs.files.set(inbox, '{}');
    expect(withdraw(fs, HJ, job.id)).toBe(true);
    expect(fs.files.has(inbox)).toBe(false);
    expect(fs.files.has(`${HJ}/staging/${job.id}.withdrawn.json`)).toBe(true);
  });

  it('reports a job the Mac already took', () => {
    expect(withdraw(memFs(), HJ, job.id)).toBe(false);
  });
});

describe('lastSeen', () => {
  it('reads the install stamp and the newest result', () => {
    const fs = memFs();
    fs.files.set(
      `${HJ}/installed.json`,
      JSON.stringify({ installedAt: '2026-11-01T20:00:00Z', runnerVersion: 'v1' }),
    );
    fs.files.set(`${HJ}/results/a/result.json`, '{}');
    fs.files.set(`${HJ}/results/b/result.json`, '{}');
    fs.mtimes.set(`${HJ}/results/a/result.json`, 100);
    fs.mtimes.set(`${HJ}/results/b/result.json`, 300);
    expect(lastSeen(fs, HJ)).toEqual({
      installedAt: '2026-11-01T20:00:00Z',
      runnerVersion: 'v1',
      lastResultMs: 300,
    });
  });

  it('says never installed when there is nothing', () => {
    expect(lastSeen(memFs(), HJ)).toEqual({
      installedAt: null,
      runnerVersion: null,
      lastResultMs: null,
    });
  });
});

it('repoRunnerVersion hashes exactly what install.sh hashes', () => {
  const shell = execFileSync(
    'bash',
    ['-c', 'cat runner.sh jobs/*.sh | sha256sum | cut -d" " -f1'],
    {
      cwd: TOOLS_DIR,
      encoding: 'utf8',
    },
  ).trim();
  expect(repoRunnerVersion(`${TOOLS_DIR}../..`)).toBe(shell);
});
