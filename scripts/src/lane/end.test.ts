import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Answer, Call, World } from './fakes.ts';
import { deps, fail, laneFile, world } from './fakes.ts';
import { end } from './end.ts';
import type { EndArgs } from './end.ts';

const B = 'old-lane';
const HEAD = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const pr = (o: object = {}) =>
  JSON.stringify({
    number: 42,
    state: 'MERGED',
    mergeCommit: { oid: MERGE },
    headRefOid: HEAD,
    url: 'https://github.com/o/r/pull/42',
    ...o,
  });
const run = (o: object) => ({
  id: 7,
  name: 'Deploy',
  display_title: 'x',
  event: 'push',
  head_branch: 'main',
  head_sha: MERGE,
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-14T01:00:00Z',
  html_url: 'https://github.com/o/r/actions/runs/7',
  ...o,
});
const runs = (...r: object[]) => JSON.stringify({ workflow_runs: r });
// `gh pr list --head <b>` for prune's verdict: by default one merged PR at the local tip (prune takes the branch)
const prs = (...p: object[]) =>
  JSON.stringify(
    p.map((x) => ({
      number: 42,
      state: 'MERGED',
      headRefName: 'old-lane',
      headRefOid: 'c'.repeat(40),
      isCrossRepository: false,
      ...x,
    })),
  );

function lane(
  w: World,
  notes: Record<string, string> = { 'plan.md': 'the plan\n', 'shots/a.png': 'png' },
) {
  const wt = join(w.main, '.claude/worktrees', B);
  for (const [f, s] of Object.entries(notes)) {
    mkdirSync(join(wt, 'localNotes', f, '..'), { recursive: true });
    writeFileSync(join(wt, 'localNotes', f), s);
  }
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(w.board, 'lifecycle'), { recursive: true });
  writeFileSync(
    join(w.board, 'lifecycle', `${B}.json`),
    JSON.stringify({
      v: 1,
      branch: B,
      worktree: wt,
      windowId: '@9',
      paneId: '%9',
      tmuxServerPid: '111',
      tmuxServerStart: '222',
    }),
  );
  laneFile(w, B, 'pr', 42);
  return wt;
}

function script(over: [string, Answer][] = []): [string, Answer][] {
  return [
    ...over,
    ['gh pr view', pr()],
    ['gh pr list --head', prs({})],
    ['git rev-parse --verify --quiet refs/heads/', HEAD],
    ['gh api repos/owner/repo/actions/runs?branch=main', runs(run({}))],
    ['gh api repos/owner/repo/actions/runs?head_sha=', runs()],
    ['git status --porcelain', ''],
    [
      'gh api repos/owner/repo/environments/dev/deployment-branch-policies',
      '{"branch_policies":[{"id":5,"name":"main"}]}',
    ],
    ['tmux display -p -t @9', `111\t222\t@9\t${B}`],
    ['tmux display -p -t %1', '@1'],
    ['git worktree remove', ''],
    ['tmux kill-window', ''],
    ['tmux run-shell', ''],
  ];
}
const args = (o: Partial<EndArgs> = {}): EndArgs => ({ branch: B, abandon: null, ...o });
const effects = (calls: Call[]) =>
  calls
    .filter((c) => /^(git worktree remove|tmux (kill-window|run-shell))/.test(c.line))
    .map((c) => c.line);

describe('lane end: gates', () => {
  const cases: [string, Partial<EndArgs>, [string, Answer][], RegExp, number][] = [
    ['an invalid name', { branch: '-x' }, [], /not a lane name/, 2],
    ['--force-abandon without a reason', { abandon: 'true' }, [], /wants a reason/, 2],
    [
      'an open PR',
      {},
      [['gh pr view', pr({ state: 'OPEN', mergeCommit: null })]],
      /PR 42 is OPEN \(or --force-abandon/,
      3,
    ],
    ['a closed PR', {}, [['gh pr view', pr({ state: 'CLOSED' })]], /closed unmerged/, 3],
    [
      'no PR',
      {},
      [['gh pr view', fail('no pull requests found for branch "old-lane"')]],
      /no PR for old-lane/,
      3,
    ],
    [
      'a local head that is not the merged one',
      {},
      [
        ['git rev-parse --verify --quiet refs/heads/', 'e'.repeat(40)],
        ['git fetch origin pull/42/head', ''],
        ['git merge-base --is-ancestor', fail()],
      ],
      /local old-lane \(eeeeeee\) has commits PR 42's merged head \(ccccccc\) lacks/,
      3,
    ],
    [
      "a PR head fetch that times out (60 s): it can't compare",
      {},
      [
        ['git rev-parse --verify --quiet refs/heads/', 'e'.repeat(40)],
        [
          'git fetch origin pull/42/head',
          (c) => {
            if (c.timeoutMs !== 60_000) throw new Error('no timeout');
            throw new Error('git fetch timed out after 60 s');
          },
        ],
      ],
      /could not fetch PR 42's head to compare/,
      1,
    ],
    [
      'a merge with no deploy run yet, minutes old',
      {},
      [
        ['gh pr view', pr({ mergedAt: '2026-10-13T19:58:00Z' })],
        ['gh api repos/owner/repo/actions/runs?branch', runs()],
      ],
      /not found yet \(merged minutes ago\)/,
      75,
    ],
    [
      'a running deploy',
      {},
      [
        [
          'gh api repos/owner/repo/actions/runs?branch',
          runs(run({ status: 'in_progress', conclusion: null })),
        ],
      ],
      /still running/,
      75,
    ],
    [
      'a failed deploy',
      {},
      [['gh api repos/owner/repo/actions/runs?branch', runs(run({ conclusion: 'failure' }))]],
      /ended failure: https/,
      3,
    ],
    [
      'no deploy found',
      {},
      [['gh api repos/owner/repo/actions/runs?branch', runs()]],
      /not found/,
      3,
    ],
    [
      'a dirty worktree',
      {},
      [['git status --porcelain', '?? stray.txt']],
      /uncommitted files:\n\s+\?\? stray.txt/,
      3,
    ],
  ];
  for (const [name, a, over, msg, code] of cases)
    it(name, () => {
      const w = world();
      lane(w);
      const t = deps(w, script(over));
      expect(end(t.d, args(a))).toBe(code);
      expect(t.out()).toMatch(msg);
      expect(effects(t.calls)).toEqual([]);
      expect(existsSync(join(w.main, 'localNotes/archive', B))).toBe(false);
      expect(t.sync.calls).toBe(0);
    });

  it('refuses while the branch holds a live dev lock', () => {
    const w = world();
    lane(w);
    writeFileSync(
      join(w.board, 'devlock.devb.json'),
      JSON.stringify({ v: 1, holder: { branch: B, sha: HEAD, expiresAt: '2026-10-13T21:00:00Z' } }),
    );
    const t = deps(w, script());
    expect(end(t.d, args())).toBe(3);
    expect(t.out()).toMatch(/holds the devb until .* lock: pnpm bot lock release/);
  });

  it('follows a superseded deploy to the later green one', () => {
    const w = world();
    lane(w);
    const later = run({ id: 8, head_sha: 'f'.repeat(40), created_at: '2026-11-14T02:00:00Z' });
    const t = deps(
      w,
      script([
        [
          'gh api repos/owner/repo/actions/runs?branch',
          runs(run({ conclusion: 'cancelled' }), later),
        ],
      ]),
    );
    expect(end(t.d, args())).toBe(0);
  });

  it('finds an older merge by its sha when the first page lacks it', () => {
    const w = world();
    lane(w);
    const t = deps(
      w,
      script([
        ['gh api repos/owner/repo/actions/runs?branch', runs()],
        ['gh api repos/owner/repo/actions/runs?head_sha=', runs(run({}))],
      ]),
    );
    expect(end(t.d, args())).toBe(0);
  });

  it('an old merge whose own run was cancelled: followed through the runs created since', () => {
    const w = world();
    lane(w);
    const later = run({ id: 8, head_sha: 'f'.repeat(40), created_at: '2026-11-14T02:00:00Z' });
    const t = deps(
      w,
      script([
        [
          'gh api repos/owner/repo/actions/runs?branch=main&event=push&per_page=100&created=',
          runs(later),
        ],
        ['gh api repos/owner/repo/actions/runs?branch', runs()],
        ['gh api repos/owner/repo/actions/runs?head_sha=', runs(run({ conclusion: 'cancelled' }))],
      ]),
    );
    expect(end(t.d, args())).toBe(0);
    expect(t.calls.some((c) => c.line.includes('created=%3E%3D2026-11-14T01%3A00%3A00Z'))).toBe(
      true,
    );
  });

  it('a local head behind the PR head (updated on GitHub) is covered: it goes on', () => {
    const w = world();
    lane(w);
    const t = deps(
      w,
      script([
        ['git rev-parse --verify --quiet refs/heads/', 'e'.repeat(40)],
        ['git fetch origin pull/42/head', ''],
        ['git merge-base --is-ancestor', ''],
      ]),
    );
    expect(end(t.d, args())).toBe(0);
  });

  it('--force-abandon skips only the PR and deploy gates', () => {
    const w = world();
    lane(w);
    const t = deps(
      w,
      script([
        ['gh pr view', fail('must not be asked')],
        ['git status --porcelain', ' M x'],
      ]),
    );
    expect(end(t.d, args({ abandon: 'superseded by another lane' }))).toBe(3);
    expect(
      t.calls.some((c) => c.line.startsWith('gh pr view') || c.line.includes('actions/runs')),
    ).toBe(false);
    expect(t.out()).toMatch(/uncommitted files/);
  });
});

describe('lane end: the nominal run', () => {
  it('archives and checks, removes, closes the window by id, clears, prints', () => {
    const w = world();
    lane(w);
    const t = deps(w, script());
    expect(end(t.d, args())).toBe(0);
    const arch = join(w.main, 'localNotes/archive', B);
    expect(readFileSync(join(arch, 'plan.md'), 'utf8')).toBe('the plan\n');
    expect(readFileSync(join(arch, 'shots/a.png'), 'utf8')).toBe('png');
    expect(readFileSync(join(arch, 'mac-cleanup.txt'), 'utf8')).toMatch(/^# nothing for the Mac: /);
    expect(readFileSync(join(arch, 'lane-end.txt'), 'utf8')).toMatch(
      /PR 42 merged as d{40}; main's deploy green/,
    );
    expect(effects(t.calls)).toEqual([
      `git worktree remove .claude/worktrees/${B}`,
      'tmux kill-window -t @9',
    ]);
    expect(t.calls.map((c) => c.line)).toContain(
      'gh api repos/owner/repo/environments/dev/deployment-branch-policies?per_page=100',
    );
    expect(t.calls.at(-1)!.line).toBe('tmux kill-window -t @9');
    expect(existsSync(join(w.board, 'lanes', `${B}.json`))).toBe(false);
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
    expect(t.out()).toMatch(/nothing for the Mac: /);
    expect(t.out()).toMatch(/goes at the end of the wave: the hub runs pnpm bot prune-branches/);
    expect(t.out()).not.toMatch(/branch -D/);
    expect(t.calls.some((c) => c.line.includes('branch -D'))).toBe(false);
    expect(t.calls.some((c) => c.line.startsWith('tmux list-windows'))).toBe(false);
    expect(t.sync.calls).toBe(1);
  });

  it('syncs main last, after the Mac line and the window close', () => {
    const w = world();
    lane(w);
    const t = deps(w, script());
    expect(end(t.d, args())).toBe(0);
    expect(t.sync.ran).toContain('tmux kill-window -t @9');
    expect(t.sync.ran).toContain(`git worktree remove .claude/worktrees/${B}`);
    const before = t.sync.logged.join('\n');
    expect(before).toMatch(/nothing for the Mac: /);
    expect(before).toMatch(/closed window @9$/);
    expect(t.out().trimEnd().endsWith('tower: restart not needed (serving aaaaaaa)')).toBe(true);
  });

  it('a sync-main failure only warns: exit 0, the lane still ended', () => {
    const w = world();
    lane(w);
    const t = deps(w, script());
    t.sync.fail = 'git fetch failed — nothing moved: network';
    expect(end(t.d, args())).toBe(0);
    expect(t.out()).toMatch(
      /warning: sync-main failed \(retry: pnpm board sync-main\): git fetch failed — nothing moved/,
    );
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
    expect(effects(t.calls).at(-1)).toBe('tmux kill-window -t @9');
  });

  it('a branch already gone: the line keeps the admission removal and drops the delete', () => {
    const w = world();
    lane(w);
    const t = deps(
      w,
      script([
        ['git rev-parse --verify --quiet refs/heads/', fail()],
        ['gh api repos/owner/repo/environments', `{"branch_policies":[{"id":31,"name":"${B}"}]}`],
      ]),
    );
    expect(end(t.d, args())).toBe(0);
    expect(t.out()).toMatch(/DELETE '.*\/31'/);
    expect(t.out()).not.toMatch(/branch -D/);
    expect(t.out()).toMatch(/already gone: no delete in the line/);
  });

  it('a failed window kill still ends the lane: exit 0, and says so', () => {
    const w = world();
    lane(w);
    const t = deps(w, script([['tmux kill-window', fail("can't find window: @9")]]));
    expect(end(t.d, args())).toBe(0);
    expect(t.out()).toMatch(/window not closed \(can't find window: @9\)/);
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
  });

  it("never writes into an older same-name lane's archive, on the run or a rerun", () => {
    const w = world();
    lane(w);
    const old = join(w.main, 'localNotes/archive', B);
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'plan.md'), 'the plan\n'); // identical notes, but another lane's end claimed it
    mkdirSync(join(old, 'shots'));
    writeFileSync(join(old, 'shots/a.png'), 'png');
    writeFileSync(join(old, 'lane-end.txt'), 'the older lane\n');
    const t = deps(w, script([['git worktree remove', fail('locked')]]));
    expect(end(t.d, args())).toBe(1);
    expect(readFileSync(join(old, 'lane-end.txt'), 'utf8')).toBe('the older lane\n');
    expect(existsSync(join(`${old}.1`, 'lane-end.txt'))).toBe(true);
    const t2 = deps(w, script());
    expect(end(t2.d, args())).toBe(0);
    expect(readFileSync(join(old, 'lane-end.txt'), 'utf8')).toBe('the older lane\n');
    expect(existsSync(join(`${old}.2`))).toBe(false);
  });

  it('an abandoned lane keeps the branch delete: prune-branches keeps a branch with no merged PR', () => {
    const w = world();
    lane(w);
    const t = deps(w, script([['gh pr list --head', '[]']]));
    expect(end(t.d, args({ abandon: 'superseded' }))).toBe(0);
    expect(readFileSync(join(w.main, 'localNotes/archive', B, 'mac-cleanup.txt'), 'utf8')).toBe(
      `cd /mac/repo && git branch -D ${B}\n`,
    );
    expect(t.out()).toMatch(/prune-branches would keep it: no PR from it/);
  });

  const kept: [string, [string, Answer][], RegExp][] = [
    [
      'a local tip behind the PR head',
      [
        ['git rev-parse --verify --quiet refs/heads/', 'e'.repeat(40)],
        ['git fetch origin pull/42/head', ''],
        ['git merge-base --is-ancestor', ''],
      ],
      /the local tip eeeeeee isn't PR 42's head/,
    ],
    [
      'a name reused across two merged PRs',
      [['gh pr list --head', prs({ number: 7, headRefOid: 'a'.repeat(40) }, {})]],
      /2 PRs from it \(7, 42\)/,
    ],
    ['an unreadable PR list', [['gh pr list --head', fail()]], /its PRs could not be read/],
  ];
  for (const [name, over, why] of kept)
    it(`a merged lane prune would keep (${name}) gets its delete in the line`, () => {
      const w = world();
      lane(w);
      const t = deps(w, script(over));
      expect(end(t.d, args())).toBe(0);
      expect(readFileSync(join(w.main, 'localNotes/archive', B, 'mac-cleanup.txt'), 'utf8')).toBe(
        `cd /mac/repo && git branch -D ${B}\n`,
      );
      expect(t.out()).toMatch(why);
    });

  it('chains the admission removal for an admitted branch', () => {
    const w = world();
    lane(w);
    const t = deps(
      w,
      script([
        ['gh api repos/owner/repo/environments', `{"branch_policies":[{"id":31,"name":"${B}"}]}`],
      ]),
    );
    expect(end(t.d, args())).toBe(0);
    expect(t.out()).toMatch(
      /cd \/mac\/repo && GH_PAGER=cat gh api -X DELETE 'repos\/owner\/repo\/environments\/dev\/deployment-branch-policies\/31' && .*--jq '\.branch_policies\[\]\.name'\n/,
    );
  });

  it('prints the by-name removal when the admission is unreadable', () => {
    const w = world();
    lane(w);
    const t = deps(w, script([['gh api repos/owner/repo/environments', fail()]]));
    expect(end(t.d, args())).toBe(0);
    expect(t.out()).toMatch(/select\(\.name=="old-lane"\)/);
    expect(t.out()).toMatch(/admission unknown/);
  });

  it('from the lane own window: a delayed close, and the hub reminder', () => {
    const w = world();
    lane(w);
    const t = deps(w, script([['tmux display -p -t %1', '@9']]));
    expect(end(t.d, args())).toBe(0);
    expect(effects(t.calls).at(-1)).toBe('tmux run-shell -b -d 90 -C kill-window -t @9');
    expect(t.out()).toMatch(/closes in 90 s; send \[merged\]/);
    expect(t.sync.calls).toBe(1);
  });

  const noKill: [string, [string, Answer][], RegExp, (w: World) => void][] = [
    [
      'a restarted tmux server',
      [['tmux display -p -t @9', `999\t222\t@9\t${B}`]],
      /tmux server restarted/,
      () => {},
    ],
    [
      'a renamed window',
      [['tmux display -p -t @9', '111\t222\t@9\tsomeone else']],
      /now named someone else/,
      () => {},
    ],
    ['a gone window', [['tmux display -p -t @9', fail()]], /@9 is gone/, () => {}],
    [
      'no record (a legacy lane)',
      [],
      /no window recorded/,
      (w) => writeFileSync(join(w.board, 'lifecycle', `${B}.json`), 'garbage'),
    ],
  ];
  for (const [name, over, why, setup] of noKill)
    it(`never kills on ${name}`, () => {
      const w = world();
      lane(w);
      setup(w);
      const t = deps(w, script(over));
      expect(end(t.d, args())).toBe(0);
      expect(effects(t.calls)).toEqual([`git worktree remove .claude/worktrees/${B}`]);
      expect(t.out()).toMatch(new RegExp(`window not closed \\(.*${why.source}`));
    });

  it('an archive mismatch removes nothing', () => {
    const w = world();
    lane(w);
    const t = deps(w, script());
    t.d.fs = {
      ...t.d.fs,
      archive: () => {
        throw new Error('the copy differs: plan.md');
      },
    };
    expect(end(t.d, args())).toBe(1);
    expect(t.out()).toMatch(/archive failed, nothing removed/);
    expect(effects(t.calls)).toEqual([]);
  });

  it('never overwrites a different archive; an identical one is reused', () => {
    const w = world();
    lane(w);
    const arch = join(w.main, 'localNotes/archive', B);
    mkdirSync(arch, { recursive: true });
    writeFileSync(join(arch, 'other.md'), 'someone else');
    const t = deps(w, script());
    expect(end(t.d, args())).toBe(0);
    expect(readFileSync(join(arch, 'other.md'), 'utf8')).toBe('someone else');
    expect(readFileSync(join(`${arch}.1`, 'plan.md'), 'utf8')).toBe('the plan\n');
  });

  it('an empty localNotes still leaves an archive with the record', () => {
    const w = world();
    lane(w, {});
    const t = deps(w, script());
    expect(end(t.d, args())).toBe(0);
    expect(existsSync(join(w.main, 'localNotes/archive', B, 'mac-cleanup.txt'))).toBe(true);
  });

  it('a failed remove stops before the lane and window; a rerun resumes', () => {
    const w = world();
    lane(w);
    const t = deps(
      w,
      script([['git worktree remove', fail('contains modified or untracked files')]]),
    );
    expect(end(t.d, args())).toBe(1);
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(true);
    expect(t.calls.some((c) => c.line.startsWith('tmux kill-window'))).toBe(false);
    expect(t.sync.calls).toBe(0);

    const t2 = deps(w, script());
    expect(end(t2.d, args())).toBe(0);
    expect(existsSync(join(w.main, 'localNotes/archive', `${B}.1`))).toBe(false); // the identical archive was reused
  });

  it('a rerun after the worktree is gone resumes and prints the same line', () => {
    const w = world();
    lane(w);
    const admitted: [string, Answer] = [
      'gh api repos/owner/repo/environments',
      `{"branch_policies":[{"id":31,"name":"${B}"}]}`,
    ];
    const t = deps(w, script([admitted]));
    expect(end(t.d, args())).toBe(0);
    const line = readFileSync(join(w.main, 'localNotes/archive', B, 'mac-cleanup.txt'), 'utf8');
    const t2 = deps(w, script([admitted]));
    // the fake remove leaves the directory: hide it, as the real remove would have taken it
    const real = t2.d.fs.exists;
    t2.d.fs = { ...t2.d.fs, exists: (p) => !p.endsWith(`.claude/worktrees/${B}`) && real(p) };
    expect(end(t2.d, args())).toBe(0);
    expect(readFileSync(join(w.main, 'localNotes/archive', B, 'mac-cleanup.txt'), 'utf8')).toBe(
      line,
    );
    expect(t2.out()).toContain(`\n  ${line.trim()}`);
    expect(effects(t2.calls)).toEqual([]);
  });

  it('closes the window before the record that names it goes', () => {
    const w = world();
    lane(w);
    const t = deps(w, script());
    const lc = join(w.board, 'lifecycle', `${B}.json`);
    let killedFirst: boolean | null = null;
    const rm = t.d.fs.rm;
    t.d.fs = {
      ...t.d.fs,
      rm: (p) => {
        if (p === lc) killedFirst = t.calls.some((c) => c.line.startsWith('tmux kill-window'));
        rm(p);
      },
    };
    expect(end(t.d, args())).toBe(0);
    expect(killedFirst).toBe(true);
  });

  it('cannot tell its own window (no TMUX_PANE): the close is delayed, never at once', () => {
    const w = world();
    lane(w);
    const t = deps(w, script(), { tmuxPane: null });
    expect(end(t.d, args())).toBe(0);
    expect(effects(t.calls).at(-1)).toBe('tmux run-shell -b -d 90 -C kill-window -t @9');
    expect(t.calls.some((c) => c.line.startsWith('tmux kill-window'))).toBe(false);
  });

  it('refuses a diverged local head even with the worktree gone', () => {
    const w = world();
    lane(w);
    const t = deps(
      w,
      script([
        ['git rev-parse --verify --quiet refs/heads/', 'e'.repeat(40)],
        ['git fetch origin pull/42/head', ''],
        ['git merge-base --is-ancestor', fail()],
      ]),
    );
    const real = t.d.fs.exists;
    t.d.fs = { ...t.d.fs, exists: (p) => !p.endsWith(`.claude/worktrees/${B}`) && real(p) };
    expect(end(t.d, args())).toBe(3);
    expect(t.out()).toMatch(/has commits PR 42's merged head/);
  });

  it('a failed GitHub read is exit 1 (retry), never a refusal', () => {
    for (const over of [
      [['gh pr view', fail('HTTP 502')]],
      [
        ['git rev-parse --verify --quiet refs/heads/', 'e'.repeat(40)],
        ['git fetch origin pull/42/head', fail('network')],
      ],
    ] as [string, Answer][][]) {
      const w = world();
      lane(w);
      const t = deps(w, script(over));
      expect(end(t.d, args())).toBe(1);
      expect(t.out()).not.toMatch(/they would go with the branch/);
    }
  });

  it("refuses when the lane's localNotes holds a file the archive record would overwrite", () => {
    const w = world();
    lane(w, { 'lane-end.txt': 'mine\n' });
    const t = deps(w, script());
    expect(end(t.d, args())).toBe(3);
    expect(t.out()).toMatch(/localNotes\/lane-end.txt would be overwritten/);
    expect(effects(t.calls)).toEqual([]);
    expect(existsSync(join(w.main, 'localNotes/archive', B))).toBe(false);
  });

  it('with no localNotes, a rerun reuses its own archive', () => {
    const w = world();
    lane(w, {});
    const t = deps(w, script([['git worktree remove', fail('locked')]]));
    expect(end(t.d, args())).toBe(1);
    const t2 = deps(w, script());
    expect(end(t2.d, args())).toBe(0);
    expect(existsSync(join(w.main, 'localNotes/archive', `${B}.1`))).toBe(false);
  });
});
