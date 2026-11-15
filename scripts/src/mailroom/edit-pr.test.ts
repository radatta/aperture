import { describe, expect, it } from 'vitest';
import { fakeClock, fakeRun } from '../bot/fakes.ts';
import { editPr } from './edit-pr.ts';
import { sha256 } from './job.ts';
import { memFs } from './fakes.ts';
import { EXIT } from './open-pr.ts';
import type { Deps } from './open-pr.ts';
import type { Result } from './submit.ts';

const HJ = '/workspace/.hostjobs';
const ROOT = '/workspace/.claude/worktrees/mac-mailroom';
const SHA = 'a'.repeat(40);
const BODY = 'The body after round 2.\n';
const PR = {
  number: 90,
  url: 'https://github.com/radatta/aperture/pull/90',
  headSha: SHA,
  author: 'radatta',
};

type Sent = { id: string; job: string; params: Record<string, string> };
function setup(
  opts: {
    mac?: (job: Sent) => Partial<Result> | null;
    readBack?: { body: string; title: string } | 'offline';
    body?: string;
  } = {},
) {
  const fs = memFs([`${HJ}/inbox`]);
  fs.files.set(`${ROOT}/localNotes/pr-mac-mailroom.md`, opts.body ?? BODY);
  const { run, calls } = fakeRun([
    ['git symbolic-ref', 'mac-mailroom'],
    ['git rev-parse HEAD', SHA],
    ['git ls-remote', `${SHA}\trefs/heads/mac-mailroom`],
    ['git diff', ''],
    [
      'gh pr view',
      () => {
        if (opts.readBack === 'offline') throw new Error('gh: offline');
        return JSON.stringify(opts.readBack ?? { body: BODY, title: 'Old title' });
      },
    ],
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
    fs.files.set(
      `${HJ}/results/${job.id}/result.json`,
      JSON.stringify({
        v: 1,
        id: job.id,
        job: 'edit-pr',
        runnerVersion: 'v1',
        durationMs: 900,
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
  return { d, fs, calls, logs, sent };
}

const edited = (job: Sent) =>
  ({
    status: 'edited',
    reason: null,
    pr: PR,
    bodySha256: job.params.bodySha256,
  }) as Partial<Result>;

describe('editPr', () => {
  it('sends the worktree body without a title, and confirms it by reading the PR back', async () => {
    const { d, logs, sent, calls } = setup({ mac: edited });
    expect(await editPr(d)).toBe(EXIT.ok);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.job).toBe('edit-pr');
    expect(sent[0]?.id).toMatch(/^\d{8}T\d{6}Z-edit-mac-mailroom-[0-9a-f]{4}$/); // never the slow lane's …Z-ios-…
    expect(Object.keys(sent[0]?.params ?? {}).sort()).toEqual([
      'body',
      'bodySha256',
      'branch',
      'sha',
    ]);
    expect(sent[0]?.params.bodySha256).toBe(sha256(BODY));
    expect(
      calls.some((c) => c.cmd === 'gh' && c.args.join(' ') === 'pr view 90 --json body,title'),
    ).toBe(true);
    expect(logs.at(-1)).toBe(`edited ${PR.url} (author radatta)`);
  });

  it('sends a title when given, and checks it reads back', async () => {
    const { d, sent } = setup({ mac: edited, readBack: { body: BODY, title: 'New title here' } });
    expect(await editPr(d, 'New title here')).toBe(EXIT.ok);
    expect(sent[0]?.params.title).toBe('New title here');
  });

  it('fails loudly when the PR reads back with another body or title', async () => {
    const a = setup({ mac: edited, readBack: { body: 'something else', title: 'Old title' } });
    expect(await editPr(a.d)).toBe(EXIT.failed);
    expect(a.logs.at(-1)).toMatch(/reads back different/);
    const b = setup({ mac: edited, readBack: { body: BODY, title: 'Old title' } });
    expect(await editPr(b.d, 'New title here')).toBe(EXIT.failed);
  });

  it('fails loudly when GitHub stored another body than the one sent', async () => {
    const { d, logs } = setup({
      mac: () => ({ status: 'edited', pr: PR, bodySha256: 'f'.repeat(64) }),
    });
    expect(await editPr(d)).toBe(EXIT.failed);
    expect(logs.at(-1)).toMatch(/GitHub holds a different body/);
  });

  it('fails loudly when the edited PR is on another commit', async () => {
    const { d, logs } = setup({
      mac: (j) => ({ ...edited(j), pr: { ...PR, headSha: 'b'.repeat(40) } }),
    });
    expect(await editPr(d)).toBe(EXIT.failed);
    expect(logs.at(-1)).toMatch(/not aaaaaaa/);
  });

  it("still succeeds when the container's gh can't read the PR back, and says so", async () => {
    const { d, logs } = setup({ mac: edited, readBack: 'offline' });
    expect(await editPr(d)).toBe(EXIT.ok);
    expect(logs.at(-1)).toMatch(/couldn't re-read it from here/);
  });

  it('turns the Mac refusals into what to do', async () => {
    for (const [reason, hint] of [
      ['NO_PR', /open one first: pnpm mailroom open-pr/],
      ['MANY_PRS', /more than one open PR/],
      ['WRONG_BASE', /another base than main/],
      ['HEAD_MISMATCH', /pnpm bot push/],
    ] as const) {
      const { d, logs } = setup({ mac: () => ({ status: 'rejected', reason }) });
      expect(await editPr(d)).toBe(EXIT.failed);
      expect(logs.join('\n')).toMatch(hint);
    }
  });

  it('refuses a body the Mac would refuse, and submits nothing', async () => {
    const { d, logs, sent } = setup({ mac: edited, body: 'thanks @octocat' });
    expect(await editPr(d)).toBe(EXIT.failed);
    expect(logs.join('\n')).toMatch(/MENTION/);
    expect(sent).toHaveLength(0);
  });

  it("hands over the user's gh pr edit line when the Mac never answers", async () => {
    const { d, logs } = setup({ mac: () => null });
    expect(await editPr(d, 'New title here')).toBe(EXIT.unreachable);
    expect(logs.join('\n')).toMatch(
      /gh pr edit mac-mailroom --body-file localNotes\/pr-mac-mailroom\.md --title "New title here"$/m,
    );
  });
});
