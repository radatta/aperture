import { describe, expect, it } from 'vitest';
import { fakeClock, fakeRun } from '../bot/fakes.ts';
import { sha256 } from './job.ts';
import { memFs } from './fakes.ts';
import { IDS } from '../identifiers.ts';
import {
  EXIT,
  INSTALL_LINE,
  MAC_NOTE,
  MAC_ROOT,
  RENEW_LINE,
  WAIT_MS,
  macPath,
  openPr,
  probe,
} from './open-pr.ts';
import type { Deps } from './open-pr.ts';
import type { Result } from './submit.ts';

const HJ = '/workspace/.hostjobs';
const ROOT = '/workspace/.claude/worktrees/mac-mailroom';
const SHA = 'a'.repeat(40);
const BODY = 'The body.\n';
const PR = {
  number: 90,
  url: 'https://github.com/radatta/aperture/pull/90',
  headSha: SHA,
  author: 'radatta',
};

function setup(
  opts: {
    pushed?: boolean;
    body?: string | null;
    existing?: string;
    offline?: boolean;
    mac?: (job: { id: string; params: { bodySha256: string } }) => Partial<Result> | 'late' | null;
    inbox?: boolean;
  } = {},
) {
  const fs = memFs(opts.inbox === false ? [] : [`${HJ}/inbox`]);
  if (opts.body !== null) fs.files.set(`${ROOT}/localNotes/pr-mac-mailroom.md`, opts.body ?? BODY);
  const { run, calls } = fakeRun([
    ['git symbolic-ref', 'mac-mailroom'],
    ['git rev-parse HEAD', SHA],
    ['git ls-remote', opts.pushed === false ? '' : `${SHA}\trefs/heads/mac-mailroom`],
    [
      'gh pr list',
      () => {
        if (opts.offline) throw new Error('gh pr list failed: offline');
        return opts.existing ?? '';
      },
    ],
  ]);
  const clock = fakeClock();
  const logs: string[] = [];
  // The Mac: on the rename into inbox/, answer (or, for 'late', take the job and answer after the deadline).
  fs.onRename = (_from, to) => {
    if (!to.startsWith(`${HJ}/inbox/`) || !opts.mac) return;
    const job = JSON.parse(fs.files.get(to) ?? '{}') as {
      id: string;
      params: { bodySha256: string };
    };
    const answer = opts.mac(job);
    if (answer === null) return;
    const write = (r: Partial<Result>) =>
      fs.files.set(
        `${HJ}/results/${job.id}/result.json`,
        JSON.stringify({
          v: 1,
          id: job.id,
          job: 'open-pr',
          runnerVersion: 'v1',
          durationMs: 900,
          startedAt: 'T',
          ...r,
        }),
      );
    if (answer === 'late') {
      fs.files.delete(to);
      const sleep = clock.sleep;
      clock.sleep = async (ms) => {
        await sleep(ms);
        if (clock.now() - start > WAIT_MS + 5_000)
          // after the first wait gave up
          write({ status: 'opened', pr: PR, bodySha256: job.params.bodySha256 });
      };
      return;
    }
    write(answer);
  };
  const start = clock.now();
  const d: Deps = {
    run,
    fs,
    clock,
    dir: HJ,
    root: ROOT,
    repoVersion: () => 'v1',
    log: (s) => logs.push(s),
  };
  return { d, fs, calls, logs };
}

const opened = (job: { params: { bodySha256: string } }) =>
  ({
    status: 'opened',
    reason: null,
    pr: PR,
    bodySha256: job.params.bodySha256,
  }) as Partial<Result>;

describe('openPr: the iPhone-checks banner', () => {
  const report = (fs: ReturnType<typeof memFs>, run: string, r: object) =>
    fs.files.set(`${ROOT}/localNotes/devcheck/${run}/report.json`, JSON.stringify(r));
  const NOT_RUN = { reason: 'MAC_UNREACHABLE', rows: 14 };
  const sent = async (prep: (fs: ReturnType<typeof memFs>) => void, body?: string) => {
    let job: { params: { body: string; bodySha256: string } } | undefined;
    const { d, fs } = setup({
      body,
      mac: (j) => {
        job = j as unknown as typeof job;
        return opened(j);
      },
    });
    prep(fs);
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.ok);
    return job?.params ?? { body: '', bodySha256: '' };
  };

  it('puts "iPhone checks did not run" first when the head commit’s newest devcheck had them unavailable', async () => {
    const p = await sent((fs) => {
      report(fs, '2026-11-04T10-00-00-full', { expectedSha: SHA, ios: { unavailable: null } }); // older, ran
      report(fs, '2026-11-04T11-00-00-full', { expectedSha: SHA, ios: { unavailable: NOT_RUN } });
    });
    expect(p.body.split('\n')[0]).toBe(
      '> ⚠ **iPhone checks did not run** (MAC_UNREACHABLE, Mac asleep?): 14 iOS rows untested. Rerun the devcheck with the Mac awake before merging a UI change.',
    );
    expect(p.body.endsWith(BODY)).toBe(true);
    expect(p.bodySha256).toBe(sha256(p.body)); // hashed after the banner, so the Mac's body check still holds
    expect(p.body).not.toContain('️'); // the emoji form would be BAD_TEXT
  });

  it('adds nothing when the newest run at the head ran its iPhone checks, even if an older one did not', async () => {
    const p = await sent((fs) => {
      report(fs, '2026-11-04T10-00-00-full', { expectedSha: SHA, ios: { unavailable: NOT_RUN } });
      report(fs, '2026-11-04T11-00-00-full', { expectedSha: SHA, ios: { unavailable: null } });
    });
    expect(p.body).toBe(BODY);
  });

  it('ignores runs at another commit, unreadable reports, and no devcheck at all', async () => {
    expect((await sent(() => {})).body).toBe(BODY);
    const p = await sent((fs) => {
      report(fs, '2026-11-04T12-00-00-full', {
        expectedSha: 'b'.repeat(40),
        ios: { unavailable: NOT_RUN },
      });
      fs.files.set(`${ROOT}/localNotes/devcheck/2026-11-04T13-00-00-full/report.json`, '{not json');
    });
    expect(p.body).toBe(BODY);
  });

  it('never adds it twice', async () => {
    const already = `> ⚠ **iPhone checks did not run** (MAC_UNREACHABLE, Mac asleep?): 14 iOS rows untested.\n\n${BODY}`;
    const p = await sent(
      (fs) =>
        report(fs, '2026-11-04T11-00-00-full', { expectedSha: SHA, ios: { unavailable: NOT_RUN } }),
      already,
    );
    expect(p.body).toBe(already);
  });

  it('a reason off the code alphabet is replaced, never pasted into the PR', async () => {
    const p = await sent((fs) =>
      report(fs, '2026-11-04T11-00-00-full', {
        expectedSha: SHA,
        ios: { unavailable: { reason: 'x @octocat', rows: 1 } },
      }),
    );
    expect(p.body.split('\n')[0]).toContain(
      '(SIM_UNAVAILABLE): 1 iOS row untested. Rerun the devcheck once the sim is fixed',
    );
  });
});

describe('openPr', () => {
  it('opens through the Mac and reports the URL', async () => {
    const { d, logs } = setup({ mac: opened });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.ok);
    expect(logs.at(-1)).toBe(`opened ${PR.url} (author radatta)`);
  });

  it('sends the worktree PR body, hashed', async () => {
    let seen = '';
    const { d } = setup({
      mac: (job) => {
        seen = job.params.bodySha256;
        return opened(job);
      },
    });
    await openPr(d, 'Mac mailroom opens PRs');
    expect(seen).toBe(sha256(BODY));
  });

  it('refuses an unpushed branch before writing a job', async () => {
    const { d, fs } = setup({ pushed: false, mac: opened });
    await expect(openPr(d, 'Mac mailroom opens PRs')).rejects.toThrow(/pnpm bot push/);
    expect([...fs.files.keys()].some((k) => k.includes('/inbox/'))).toBe(false);
  });

  it('refuses a missing PR body file', async () => {
    const { d } = setup({ body: null });
    await expect(openPr(d, 'Mac mailroom opens PRs')).rejects.toThrow(
      /pr-mac-mailroom\.md is missing/,
    );
  });

  it('refuses a body the Mac would refuse, with a fix-it hint, and submits nothing', async () => {
    const { d, fs, logs } = setup({ body: 'thanks @octocat', mac: opened });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.failed);
    expect(logs.join('\n')).toMatch(/MENTION — an @mention outside backticks/);
    expect(fs.files.size).toBe(1);
  });

  it('refuses a title the hand-off line could not quote', async () => {
    const { d, logs } = setup({ mac: opened });
    expect(await openPr(d, 'Fix "it" now')).toBe(EXIT.failed);
    expect(logs[0]).toMatch(/BAD_PARAM/);
  });

  it('short-circuits an already-open PR without a job', async () => {
    const { d, fs, logs } = setup({ existing: PR.url, mac: opened });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.ok);
    expect(logs).toEqual([`exists ${PR.url}`]);
    expect(fs.files.size).toBe(1);
  });

  it('still submits when the container cannot reach GitHub', async () => {
    const { d, calls } = setup({ offline: true, mac: opened });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.ok);
    expect(calls.some((c) => c.cmd === 'gh')).toBe(true);
  });

  it('fails loudly when the PR opened on a different commit', async () => {
    const { d, logs } = setup({
      mac: (job) => ({ ...opened(job), pr: { ...PR, headSha: 'b'.repeat(40) } }),
    });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.failed);
    expect(logs.at(-1)).toMatch(/push landed mid-job/);
  });

  it('says the PR may still open when the Mac took the job but never answered', async () => {
    const { d, fs, logs } = setup({ mac: () => null });
    fs.onRename = (_from, to) => {
      if (to.includes('/inbox/')) fs.files.delete(to); // the Mac takes it, then goes quiet
    };
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.unreachable);
    expect(logs.join('\n')).toMatch(/may still open the PR[\s\S]*gh pr list --head mac-mailroom/);
  });

  it('counts time spent before submit against the wait budget', async () => {
    const { d, logs } = setup({ mac: () => null });
    const run = d.run;
    d.run = ((cmd: string, args: string[]) => {
      if (cmd === 'gh') void d.clock.sleep(40_000); // a slow container-side check
      return run(cmd, args);
    }) as Deps['run'];
    await openPr(d, 'Mac mailroom opens PRs');
    expect(logs.find((l) => l.startsWith('submitted'))).toMatch(/up to 35 s/);
  });

  it('queues nothing when the pre-submit checks used up the budget', async () => {
    const { d, fs, logs } = setup({ mac: opened });
    const run = d.run;
    d.run = ((cmd: string, args: string[]) => {
      if (cmd === 'gh') void d.clock.sleep(70_000);
      return run(cmd, args);
    }) as Deps['run'];
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.unreachable);
    expect([...fs.files.keys()].some((k) => k.includes('/inbox/'))).toBe(false);
    expect(logs.join('\n')).toMatch(/nothing was queued/);
  });

  it('fails loudly when the Mac sent a different body', async () => {
    const { d, logs } = setup({
      mac: () => ({ status: 'opened', pr: PR, bodySha256: 'f'.repeat(64) }),
    });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.failed);
    expect(logs.at(-1)).toMatch(/different body/);
  });

  it('refuses a personal identifier in the title or body before anything is queued or handed over', async () => {
    const first = IDS.maintainer.name.split(' ')[0]!;
    const home = ['', 'Users', 'someone', 'repo'].join('/');
    for (const [title, body, where] of [
      [`Asked by ${first}`, undefined, 'title:1 name'],
      [
        'Mac mailroom opens PRs',
        `fine\n\ncd ${home} && x`,
        'pr-mac-mailroom.md (with any banner):3 home-path',
      ],
    ] as const) {
      const { d, fs, logs } = setup({ mac: () => ({ status: 'opened', pr: PR }), body });
      expect(await openPr(d, title)).toBe(EXIT.failed);
      expect([...fs.files.keys()].some((k) => k.includes('/inbox/'))).toBe(false);
      const out = logs.join('\n');
      expect(out).toContain('PERSONAL_IDENTIFIER');
      expect(out).toContain(where);
      expect(out).not.toContain('gh pr create');
    }
  });

  it('a large clean body passes the identifier check', async () => {
    const { d } = setup({ body: `${'clean line, no names\n'.repeat(3000)}` });
    expect(await openPr(d, 'Mac mailroom opens PRs')).not.toBe(EXIT.failed);
  });

  it('withdraws an unanswered job and hands over the Mac command', async () => {
    const { d, fs, logs } = setup({ mac: () => null });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.unreachable);
    expect([...fs.files.keys()].some((k) => k.endsWith('.withdrawn.json'))).toBe(true);
    expect(logs.join('\n')).toContain(
      `cd ${MAC_ROOT}/.claude/worktrees/mac-mailroom && gh pr create --title "Mac mailroom opens PRs" --body-file localNotes/pr-mac-mailroom.md${MAC_NOTE}`,
    );
    expect(logs.join('\n')).toMatch(/never installed; no result ever written/);
  });

  it('waits out a job the Mac took late', async () => {
    const { d, logs } = setup({ mac: () => 'late' });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.ok);
    expect(logs.join('\n')).toMatch(/picked the job up late/);
  });

  it('is unreachable, not a crash, when the Mac never installed', async () => {
    const { d, logs } = setup({ inbox: false });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.unreachable);
    expect(logs[0]).toMatch(/inbox is missing/);
  });

  it('prints the renewal line on a token error', async () => {
    const { d, logs } = setup({ mac: () => ({ status: 'error', reason: 'TOKEN_REJECTED' }) });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.failed);
    expect(logs.join('\n')).toContain(RENEW_LINE);
  });

  it('warns on an expiring token and a stale installed runner, and still succeeds', async () => {
    const { d, logs } = setup({
      mac: (job) => ({
        ...opened(job),
        tokenWarning: 'TOKEN_EXPIRING',
        tokenExpiresAt: '2026-11-05T00:00:00Z',
        runnerVersion: 'v0',
      }),
    });
    expect(await openPr(d, 'Mac mailroom opens PRs')).toBe(EXIT.ok);
    expect(logs.join('\n')).toMatch(/TOKEN_EXPIRING[\s\S]*reinstall on the Mac/);
    // The hint fetches install.sh from merged main — never runs the shared folder's copy.
    expect(logs.join('\n')).toContain(INSTALL_LINE);
    expect(logs.join('\n')).not.toMatch(/bash tools\//);
    expect(INSTALL_LINE).toContain("install.sh?ref=main'");
  });
});

describe('probe', () => {
  it('passes on HEAD_MISMATCH with a zero sha and reports the token expiry', async () => {
    let sha = '';
    const { d, logs } = setup({
      mac: (job) => {
        sha = (job as unknown as { params: { sha: string } }).params.sha;
        return {
          status: 'rejected',
          reason: 'HEAD_MISMATCH',
          tokenExpiresAt: '2027-11-01T00:00:00Z',
        };
      },
    });
    expect(await probe(d)).toBe(EXIT.ok);
    expect(sha).toBe('0'.repeat(40));
    expect(logs.at(-1)).toMatch(/probe ok.*2027-11-01/);
  });

  it('fails on HEAD_MISSING with a token-access hint (the branch is pushed)', async () => {
    const { d, logs } = setup({ mac: () => ({ status: 'rejected', reason: 'HEAD_MISSING' }) });
    expect(await probe(d)).toBe(EXIT.failed);
    expect(logs.join('\n')).toMatch(/lacks access to radatta\/aperture/);
  });

  it('refuses an unpushed branch', async () => {
    const { d } = setup({
      pushed: false,
      mac: () => ({ status: 'rejected', reason: 'HEAD_MISMATCH' }),
    });
    await expect(probe(d)).rejects.toThrow(/pnpm bot push/);
  });

  it('fails on anything else', async () => {
    const { d } = setup({ mac: () => ({ status: 'error', reason: 'TOKEN_MISSING' }) });
    expect(await probe(d)).toBe(EXIT.failed);
  });
});

it('maps container paths to the Mac', () => {
  expect(macPath('/workspace/.claude/worktrees/x')).toBe(`${MAC_ROOT}/.claude/worktrees/x`);
  expect(macPath('/workspacex')).toBe('/workspacex');
});
