import { describe, expect, it } from 'vitest';
import { fakeRun } from './fakes.ts';
import { pruneBranches, verdict } from './prune.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const pr = (
  o: Partial<{
    number: number;
    state: string;
    headRefName: string;
    headRefOid: string;
    isCrossRepository: boolean;
  }>,
) => ({
  number: 90,
  state: 'MERGED',
  headRefName: 'done-lane',
  headRefOid: A,
  isCrossRepository: false,
  ...o,
});

describe('prune: which branches go', () => {
  it('deletes only a branch whose one PR merged at exactly its tip', () => {
    expect(verdict('done-lane', A, [pr({})], false)).toMatchObject({ deleted: true });
  });

  it.each([
    [
      'its tip moved past the merged head',
      'done-lane',
      B,
      [pr({})],
      false,
      /local tip bbbbbbb isn't PR 90's head aaaaaaa/,
    ],
    ['its PR is still open', 'done-lane', A, [pr({ state: 'OPEN' })], false, /PR 90 is open/],
    [
      'its PR was closed unmerged',
      'done-lane',
      A,
      [pr({ state: 'CLOSED' })],
      false,
      /PR 90 is closed/,
    ],
    [
      'two PRs share the name',
      'done-lane',
      A,
      [pr({}), pr({ number: 91, state: 'OPEN' })],
      false,
      /2 PRs from it \(90, 91\)/,
    ],
    [
      'the PR is from a fork',
      'done-lane',
      A,
      [pr({ isCrossRepository: true })],
      false,
      /from a fork/,
    ],
    ['no PR at all', 'never-pushed', A, [pr({})], false, /no PR from it/],
    [
      'a worktree has it checked out',
      'done-lane',
      A,
      [pr({})],
      true,
      /checked out, rebasing or bisecting in a worktree/,
    ],
    ['it is main', 'main', A, [pr({ headRefName: 'main' })], false, /deploy branch/],
  ])('keeps it when %s', (_name, branch, tip, prs, checkedOut, why) => {
    const v = verdict(branch, tip, prs, checkedOut);
    expect(v.deleted).toBe(false);
    expect(v.why).toMatch(why);
  });
});

function repo(prs: unknown[], updateRef: () => string = () => '') {
  return fakeRun([
    [
      'git for-each-ref',
      [
        `refs/heads/done-lane ${A}`,
        `refs/heads/moved-lane ${B}`,
        `refs/heads/here ${A}`,
        `refs/heads/main ${A}`,
      ].join('\n'),
    ],
    [
      'git worktree list',
      [
        'worktree /workspace',
        'HEAD ' + A,
        'detached',
        '',
        'worktree /workspace/.claude/worktrees/here',
        'HEAD ' + A,
        'branch refs/heads/here',
      ].join('\n'),
    ],
    ['git rev-parse --path-format=absolute --git-common-dir', '/g'],
    ['gh pr list', JSON.stringify(prs)],
    ['git update-ref', updateRef],
  ]);
}
const PRS = [
  pr({}),
  pr({ number: 91, headRefName: 'moved-lane' }),
  pr({ number: 92, headRefName: 'here' }),
];

describe('pruneBranches', () => {
  it('deletes with a compare-and-delete on the tip it judged, and keeps the rest with the reason', () => {
    const { run, calls } = repo(PRS);
    const logs: string[] = [];
    const out = pruneBranches(
      run,
      false,
      (s) => logs.push(s),
      () => null,
    );
    expect(out.filter((v) => v.deleted).map((v) => v.branch)).toEqual(['done-lane']);
    const deletes = calls.filter((c) => c.cmd === 'git' && c.args[0] === 'update-ref');
    expect(deletes.map((c) => c.args)).toEqual([['update-ref', '-d', 'refs/heads/done-lane', A]]);
    expect(logs).toContain(`deleted done-lane — PR 90 merged at this tip (was aaaaaaa)`);
    expect(logs).toContain('kept here — checked out, rebasing or bisecting in a worktree');
    expect(logs).toContain('kept main — a deploy branch');
    expect(logs.at(-1)).toBe('deleted 1 of 4 local branches');
  });

  it.each(['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START'])(
    'keeps a branch a worktree is in the middle of (%s), though worktree list shows it detached, even with its folder gone',
    (f) => {
      const { run, calls } = repo(PRS);
      const read = (p: string) => (p === `/g/worktrees/x/${f}` ? 'refs/heads/done-lane\n' : null);
      const out = pruneBranches(
        run,
        false,
        () => {},
        read,
        (d) => (d === '/g/worktrees' ? ['x'] : []),
      );
      expect(out.find((v) => v.branch === 'done-lane')).toMatchObject({ deleted: false });
      expect(calls.some((c) => c.args[0] === 'update-ref')).toBe(false);
    },
  );

  it('a dry run deletes nothing', () => {
    const { run, calls } = repo(PRS);
    const logs: string[] = [];
    pruneBranches(
      run,
      true,
      (s) => logs.push(s),
      () => null,
    );
    expect(calls.some((c) => c.args[0] === 'update-ref')).toBe(false);
    expect(logs).toContain('would delete done-lane — PR 90 merged at this tip (was aaaaaaa)');
  });

  it('a delete git refuses (the tip moved meanwhile) is kept, and says so', () => {
    const { run } = repo(PRS, () => {
      throw new Error('cannot lock ref: is at bbbb but expected aaaa');
    });
    const out = pruneBranches(
      run,
      false,
      () => {},
      () => null,
    );
    expect(out.find((v) => v.branch === 'done-lane')).toMatchObject({
      deleted: false,
      why: /delete was refused/,
    });
  });

  it('reads PRs with the read-only gh, never the bot token, and never deletes via branch -D', () => {
    const { run, calls } = repo(PRS);
    pruneBranches(
      run,
      false,
      () => {},
      () => null,
    );
    expect(calls.filter((c) => c.cmd === 'gh').map((c) => c.args.slice(0, 3))).toEqual([
      ['pr', 'list', '--state'],
    ]);
    expect(calls.some((c) => c.args.includes('-D') || c.args.includes('--delete'))).toBe(false);
  });
});
