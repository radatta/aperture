import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Answer, Call, World } from './fakes.ts';
import { boardSession, deps, fail, laneFile, porcelain, proc, world } from './fakes.ts';
import { KICKOFF_PROMPT, claudeLine, start } from './start.ts';
import type { StartArgs } from './start.ts';

const SHA = 'a'.repeat(40);
const B = 'new-lane';

// Every call of a nominal start, in order; `over` replaces an answer by prefix (it is searched first).
function script(w: World, over: [string, Answer][] = [], trees: string[] = []): [string, Answer][] {
  return [
    ...over,
    ['tmux display -p -t %1', '$0 111 222'],
    ['git status --porcelain', ''],
    ['git symbolic-ref', fail()],
    ['git fetch origin', ''],
    ['git show-ref', fail()],
    ['git ls-remote', ''],
    ['git worktree list --porcelain', porcelain(w.main, trees)],
    ['tmux list-windows', '@1\tdispatch\n@2\tother window'],
    ['git rev-parse origin/main', SHA],
    ['git rev-parse HEAD', SHA],
    [
      'git worktree add',
      () => {
        const wt = join(w.main, '.claude/worktrees', B);
        mkdirSync(wt, { recursive: true });
        writeFileSync(join(wt, '.git'), `gitdir: ../../../.git/worktrees/${B}\n`);
        return '';
      },
    ],
    ['pnpm install', ''],
    ['tmux new-window', '@9\t%9'],
    ['tmux send-keys', ''],
    ['git worktree remove', ''],
    ['git branch -d', ''],
    ['tmux kill-window', ''],
  ];
}

const args = (o: Partial<StartArgs> = {}): StartArgs => ({
  branch: B,
  kickoff: null,
  overCap: null,
  ...o,
});

// Claude's own registry entry for the new session, so the confirm loop ends at once.
function claudeSession(w: World) {
  mkdirSync(join(w.home, '.claude/sessions'), { recursive: true });
  writeFileSync(
    join(w.home, '.claude/sessions/4242.json'),
    JSON.stringify({ pid: 4242, cwd: join(w.main, '.claude/worktrees', B), name: B }),
  );
  writeFileSync(join(w.home, '.claude/sessions/4242.abc.key'), 'never read');
}

const MUTATING =
  /^(git (worktree add|switch|branch)|pnpm install|tmux (new-window|send-keys|kill-window))/;
const mutated = (calls: Call[]) => calls.filter((c) => MUTATING.test(c.line)).map((c) => c.line);

describe('lane start: refusals change nothing', () => {
  const cases: [
    string,
    Partial<StartArgs>,
    [string, Answer][],
    RegExp,
    number,
    (w: World) => void,
  ][] = [
    ['an invalid name', { branch: 'Bad/Name' }, [], /not a lane name/, 2, () => {}],
    ['a reserved name', { branch: 'main' }, [], /not a lane name/, 2, () => {}],
    ['the hub name', { branch: 'dispatch' }, [], /not a lane name/, 2, () => {}],
    ['a missing kickoff', { kickoff: '/nope/kickoff.md' }, [], /--kickoff .*missing/, 2, () => {}],
    [
      '--over-cap without a reason',
      { overCap: 'true' },
      [],
      /--over-cap wants a reason/,
      2,
      () => {},
    ],
    [
      'no tmux',
      {},
      [
        ['tmux display', fail()],
        ['tmux list-sessions', ''],
      ],
      /no tmux session/,
      3,
      () => {},
    ],
    [
      'tracked changes',
      {},
      [['git status --porcelain', ' M app/x.ts\n?? .codex/']],
      /tracked changes:\n\s+M app\/x.ts/,
      3,
      () => {},
    ],
    [
      'a branch checked out in main',
      {},
      [['git symbolic-ref', 'refs/heads/x']],
      /on a branch/,
      3,
      () => {},
    ],
    ['a failed fetch', {}, [['git fetch', fail('no network')]], /git fetch failed/, 1, () => {}],
    ['a local branch', {}, [['git show-ref', '']], /already exists \(local\)/, 3, () => {}],
    [
      'a remote branch',
      {},
      [['git ls-remote', `${SHA}\trefs/heads/${B}`]],
      /already exists \(on origin\)/,
      3,
      () => {},
    ],
    [
      'an existing worktree dir',
      {},
      [],
      /worktrees\/new-lane already exists/,
      3,
      (w) => mkdirSync(join(w.main, '.claude/worktrees', B)),
    ],
    [
      'a lifecycle record',
      {},
      [],
      /lifecycle record/,
      3,
      (w) => {
        mkdirSync(join(w.board, 'lifecycle'), { recursive: true });
        writeFileSync(join(w.board, 'lifecycle', `${B}.json`), '{}');
      },
    ],
    [
      'a same-name window',
      {},
      [['tmux list-windows', `@1\tdispatch\n@5\t${B}`]],
      /window named new-lane exists \(@5\)/,
      3,
      () => {},
    ],
  ];
  for (const [name, a, over, msg, code, setup] of cases)
    it(name, async () => {
      const w = world();
      setup(w);
      const t = deps(w, script(w, over));
      expect(await start(t.d, args(a))).toBe(code);
      expect(t.out()).toMatch(msg);
      expect(mutated(t.calls)).toEqual([]);
      expect(
        existsSync(join(w.board, 'lifecycle', `${B}.json`)) && name !== 'a lifecycle record',
      ).toBe(false);
      expect(t.sync.calls).toBe(0);
    });

  it('notes untracked paths but goes on', async () => {
    const w = world();
    claudeSession(w);
    const t = deps(w, script(w, [['git status --porcelain', '?? .codex/']]));
    expect(await start(t.d, args())).toBe(0);
    expect(t.out()).toMatch(/untracked in the main checkout \(left alone\): 1 path/);
  });

  it('refuses at the cap, naming who is active; --over-cap goes on and records why', async () => {
    const w = world();
    const live = ['a1', 'a2', 'a3', 'a4', 'a5'];
    live.forEach((b, i) => {
      proc(w, 100 + i, '777');
      boardSession(w, 100 + i, b);
    });
    laneFile(w, 'a1', 'dev');
    const trees = [...live, 'stale-one', 'parked-one', 'board-matrix-x'];
    proc(w, 200, '777');
    boardSession(w, 200, 'parked-one');
    laneFile(w, 'parked-one', 'parked');
    const t = deps(w, script(w, [], trees));
    expect(await start(t.d, args())).toBe(75);
    expect(t.out()).toMatch(
      /5 of 5 lanes active: a1 \(dev\), a2 \(no lane file\), a3 .*a5 \(no lane file\)\. End one/,
    );
    expect(t.out()).not.toMatch(/stale-one|parked-one|board-matrix/);
    expect(mutated(t.calls)).toEqual([]);

    claudeSession(w);
    const t2 = deps(w, script(w, [], trees));
    expect(await start(t2.d, args({ overCap: 'hub asked: wave 3 tail' }))).toBe(0);
    const rec = JSON.parse(readFileSync(join(w.board, 'lifecycle', `${B}.json`), 'utf8'));
    expect(rec.overCap).toBe('hub asked: wave 3 tail');
  });

  it('a dead or reused session pid does not count toward the cap', async () => {
    const w = world();
    const live = ['a1', 'a2', 'a3', 'a4', 'a5'];
    live.forEach((b, i) => boardSession(w, 100 + i, b));
    proc(w, 100, '777');
    proc(w, 101, '999'); // reused pid
    proc(w, 102, '777', 'Z'); // zombie
    claudeSession(w);
    const t = deps(w, script(w, [], live));
    expect(await start(t.d, args())).toBe(0);
  });
});

describe('lane start: the nominal run', () => {
  it('runs the steps in order with the exact argv, and writes the record and the lane', async () => {
    const w = world();
    const kick = join(w.root, 'kickoff.md');
    writeFileSync(kick, '[kickoff] new-lane — do the thing\n');
    claudeSession(w);
    laneFile(w, B, 'merged', 99); // a past same-name lane: its PR must not carry over
    const t = deps(w, script(w));
    expect(await start(t.d, args({ kickoff: kick }))).toBe(0);
    const wt = join(w.main, '.claude/worktrees', B);
    expect(mutated(t.calls)).toEqual([
      `git worktree add --no-track -b ${B} .claude/worktrees/${B} ${SHA}`,
      'pnpm install',
      `tmux new-window -d -P -F #{window_id}\t#{pane_id} -t $0: -n ${B} -c ${wt}`,
      `tmux send-keys -t %9 -l -- claude -n ${B} '${KICKOFF_PROMPT}'`,
      'tmux send-keys -t %9 Enter',
    ]);
    const install = t.calls.find((c) => c.line === 'pnpm install')!;
    expect(install.cwd).toBe(wt);
    expect(install.env?.CI).toBe('true');
    expect(t.calls.map((c) => c.line)).toContain(`git ls-remote --heads origin refs/heads/${B}`);
    expect(t.calls.find((c) => c.line.startsWith('git worktree add'))!.cwd).toBe(w.main);
    expect(readFileSync(join(wt, 'localNotes/kickoff.md'), 'utf8')).toBe(
      '[kickoff] new-lane — do the thing\n',
    );
    const rec = JSON.parse(readFileSync(join(w.board, 'lifecycle', `${B}.json`), 'utf8'));
    expect(rec).toMatchObject({
      windowId: '@9',
      paneId: '%9',
      tmuxServerPid: '111',
      tmuxServerStart: '222',
      baseSha: SHA,
    });
    const lane = JSON.parse(readFileSync(join(w.board, 'lanes', `${B}.json`), 'utf8'));
    expect(lane).toMatchObject({
      phase: 'plan',
      step: 'kickoff sent',
      session: B,
      sha: SHA,
      pr: null,
    });
    expect(t.out()).toMatch(/started in window @9 .*session new-lane confirmed/);
  });

  it('switches main to origin/main first when it moved, and sends no prompt without a kickoff', async () => {
    const w = world();
    claudeSession(w);
    const t = deps(
      w,
      script(w, [
        ['git rev-parse HEAD', 'b'.repeat(40)],
        ['git switch', ''],
      ]),
    );
    expect(await start(t.d, args())).toBe(0);
    expect(mutated(t.calls)[0]).toBe(`git switch --detach ${SHA}`);
    expect(t.calls.find((c) => c.line.includes('send-keys -t %9 -l'))!.args.at(-1)).toBe(
      `claude -n ${B}`,
    );
  });

  it('never puts kickoff text on an argv', async () => {
    const w = world();
    const kick = join(w.root, 'k.md');
    const hostile = 'HOSTILE-MARKER $(whoami) `id` \'; rm x; "\n';
    writeFileSync(kick, hostile);
    claudeSession(w);
    const t = deps(w, script(w));
    expect(await start(t.d, args({ kickoff: kick }))).toBe(0);
    expect(t.calls.some((c) => c.line.includes('HOSTILE-MARKER'))).toBe(false);
  });

  it('syncs main once the session is live, after the started line', async () => {
    const w = world();
    const t = deps(w, script(w));
    expect(await start(t.d, args())).toBe(0);
    expect(t.sync.calls).toBe(1);
    expect(t.sync.ran.at(-1)).toBe('tmux send-keys -t %9 Enter');
    expect(t.sync.logged.at(-1)).toMatch(new RegExp(`^lane ${B}: started in window @9`));
    expect(t.out().trimEnd().endsWith('tower: restart not needed (serving aaaaaaa)')).toBe(true);
  });

  it('a sync-main failure only warns: exit 0, nothing rolled back', async () => {
    const w = world();
    const t = deps(w, script(w));
    t.sync.fail = 'tower: restart failed (1 tower file changed since aaaaaaa): did not start';
    expect(await start(t.d, args())).toBe(0);
    expect(t.out()).toMatch(
      /warning: sync-main failed \(retry: pnpm board sync-main\): tower: restart failed/,
    );
    expect(t.out()).not.toMatch(/rolling back/);
    expect(mutated(t.calls).some((l) => /kill-window|worktree remove|branch -d/.test(l))).toBe(
      false,
    );
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(true);
  });

  it('warns, without failing, when the session name never shows', async () => {
    const w = world();
    const t = deps(w, script(w));
    expect(await start(t.d, args())).toBe(0);
    expect(t.out()).toMatch(/session name not confirmed: look at window @9/);
    expect(t.clock.t - Date.parse('2026-10-13T20:00:00Z')).toBeGreaterThanOrEqual(20_000);
  });

  it('the claude line varies only by the validated branch', () => {
    expect(claudeLine('x', false)).toBe('claude -n x');
    expect(claudeLine('x', true)).toBe(`claude -n x '${KICKOFF_PROMPT}'`);
    expect(KICKOFF_PROMPT).not.toMatch(/'/);
    // The workflow doc isn't loaded on its own (CLAUDE.md → _Feature workflow_): every lane opens it first.
    expect(KICKOFF_PROMPT).toMatch(/^Read docs\/ops\/FEATURE-WORKFLOW\.md first/);
  });
});

describe('lane start: rollback', () => {
  // an absolute gitdir: what a pre-2.48 git writes
  const absolute = (w: World): [string, Answer][] => [
    [
      'git worktree add',
      () => {
        const wt = join(w.main, '.claude/worktrees', B);
        mkdirSync(wt, { recursive: true });
        writeFileSync(join(wt, '.git'), `gitdir: ${w.main}/.git/worktrees/${B}\n`);
        return '';
      },
    ],
  ];
  const at: [string, (w: World) => [string, Answer][], string[]][] = [
    ['a wrong gitdir', absolute, ['git worktree remove', 'git branch -d']],
    [
      'a failed install',
      () => [['pnpm install', fail('ERR_PNPM')]],
      ['git worktree remove', 'git branch -d'],
    ],
    [
      'a failed new-window',
      () => [['tmux new-window', fail()]],
      ['git worktree remove', 'git branch -d'],
    ],
    [
      'a failed send-keys',
      () => [['tmux send-keys', fail()]],
      ['tmux kill-window -t @9', 'git worktree remove', 'git branch -d'],
    ],
  ];
  for (const [name, over, undo] of at)
    it(`undoes in reverse after ${name}`, async () => {
      const w = world();
      const t = deps(w, script(w, over(w)));
      expect(await start(t.d, args())).toBe(1);
      const after = t.calls.map((c) => c.line);
      const tail = after.slice(after.findIndex((l) => undo.some((u) => l.startsWith(u))));
      expect(tail.map((l) => undo.find((u) => l.startsWith(u)))).toEqual(undo);
      expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
      expect(t.out()).toMatch(/rolled back: nothing left behind/);
      if (name === 'a failed install') expect(t.out()).toMatch(/ERR_PNPM/);
      expect(t.sync.calls).toBe(0);
    });

  it('names what is left when an undo fails', async () => {
    const w = world();
    const t = deps(
      w,
      script(w, [
        ['pnpm install', fail()],
        ['git worktree remove', fail('locked')],
      ]),
    );
    expect(await start(t.d, args())).toBe(1);
    expect(t.out()).toMatch(
      /left behind: worktree .*new-lane \(git worktree remove failed|left behind: worktree .*\(locked\)/,
    );
  });

  it('a failed worktree add that left its branch at the base takes the branch back', async () => {
    const w = world();
    const t = deps(
      w,
      script(w, [
        ['git worktree add', fail('checkout failed')],
        ['git rev-parse --verify --quiet refs/heads/', SHA],
        ['git worktree prune', ''],
      ]),
    );
    expect(await start(t.d, args())).toBe(1);
    const tail = t.calls.map((c) => c.line).slice(-2);
    expect(tail).toEqual(['git worktree prune', `git branch -d ${B}`]);
    expect(t.out()).toMatch(/rolled back: nothing left behind/);
  });

  it('a failed worktree add whose branch is not at the base leaves that branch alone', async () => {
    const w = world();
    const t = deps(
      w,
      script(w, [
        ['git worktree add', fail()],
        ['git rev-parse --verify --quiet refs/heads/', 'f'.repeat(40)],
      ]),
    );
    expect(await start(t.d, args())).toBe(1);
    expect(t.calls.some((c) => c.line.startsWith('git branch'))).toBe(false);
  });

  it('a failed kickoff copy rolls back', async () => {
    const w = world();
    const kick = join(w.root, 'k.md');
    writeFileSync(kick, 'kickoff\n');
    const t = deps(w, script(w));
    const real = t.d.fs.write;
    t.d.fs = {
      ...t.d.fs,
      write: (p, s) => {
        if (p.endsWith('kickoff.md')) throw new Error('ENOSPC');
        real(p, s);
      },
    };
    expect(await start(t.d, args({ kickoff: kick }))).toBe(1);
    expect(t.out()).toMatch(/could not copy the kickoff: ENOSPC/);
    expect(t.calls.some((c) => c.line.startsWith('tmux new-window'))).toBe(false);
  });

  it('a failed window record write rolls back the window too', async () => {
    const w = world();
    const t = deps(w, script(w));
    const real = t.d.fs.write;
    t.d.fs = {
      ...t.d.fs,
      write: (p, s) => {
        if (p.includes('/lifecycle/') && s.includes('"@9"')) throw new Error('EACCES');
        real(p, s);
      },
    };
    expect(await start(t.d, args())).toBe(1);
    expect(t.out()).toMatch(/could not record the window: EACCES/);
    const undo = t.calls.map((c) => c.line).slice(-3);
    expect(undo).toEqual([
      'tmux kill-window -t @9',
      `git worktree remove .claude/worktrees/${B}`,
      `git branch -d ${B}`,
    ]);
  });

  it('never deletes a branch with the force form', async () => {
    const w = world();
    const t = deps(w, script(w, [['pnpm install', fail()]]));
    await start(t.d, args());
    expect(
      t.calls.filter((c) => c.cmd === 'git' && c.args[0] === 'branch').map((c) => c.args),
    ).toEqual([['branch', '-d', B]]);
  });
});

// F155: one start or sync-main at a time in the main checkout
describe('lane start: the main-checkout lock', () => {
  it('the dirty check through worktree add run inside the lock; sync-main after it is released', async () => {
    const w = world();
    claudeSession(w);
    const t = deps(w, script(w));
    expect(await start(t.d, args())).toBe(0);
    expect(t.lock.events.length).toBe(2);
    const [inAt, outAt] = t.lock.events.map((e) => Number(e.split(' ').at(-1)));
    const inside = t.calls.slice(inAt, outAt).map((c) => c.line);
    expect(inside[0]).toBe('git status --porcelain');
    expect(inside.some((l) => l.startsWith('git fetch origin'))).toBe(true);
    expect(inside.at(-1)).toMatch(/^git worktree add/);
    expect(t.calls.slice(outAt).some((c) => c.line === 'pnpm install')).toBe(true);
    expect(t.sync.calls).toBe(1);
    expect(t.lock.depth).toBe(0); // sync-main ran outside: it takes the lock itself
  });

  it('a busy lock refuses with 75, nothing changed', async () => {
    const w = world();
    const t = deps(w, script(w));
    t.lock.busy = true;
    expect(await start(t.d, args())).toBe(75);
    expect(mutated(t.calls)).toEqual([]);
    expect(t.calls.some((c) => c.line.startsWith('git'))).toBe(false);
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
    expect(t.out()).toMatch(/main checkout busy.*nothing changed; retry/);
    expect(t.sync.calls).toBe(0);
  });

  it('the fetch and ls-remote carry timeouts', async () => {
    const w = world();
    claudeSession(w);
    const timeouts: Record<string, number | undefined> = {};
    const t = deps(w, script(w));
    const run = t.d.run;
    t.d.run = (cmd, a, o) => {
      if (cmd === 'git' && (a[0] === 'fetch' || a[0] === 'ls-remote'))
        timeouts[a[0]] = o?.timeoutMs;
      return run(cmd, a, o);
    };
    expect(await start(t.d, args())).toBe(0);
    expect(timeouts).toEqual({ fetch: 60_000, 'ls-remote': 30_000 });
  });

  it('a timed-out fetch is the failed-fetch refusal', async () => {
    const w = world();
    const t = deps(w, script(w, [['git fetch origin', fail('git fetch timed out after 60 s')]]));
    expect(await start(t.d, args())).toBe(1);
    expect(t.out()).toMatch(/git fetch failed \(nothing changed\): git fetch timed out after 60 s/);
    expect(mutated(t.calls)).toEqual([]);
    expect(t.lock.depth).toBe(0);
  });

  it('a rollback after the lock was released takes it again for its git steps', async () => {
    const w = world();
    const t = deps(w, script(w, [['pnpm install', fail('ERR_PNPM')]]));
    expect(await start(t.d, args())).toBe(1);
    expect(t.lock.events.length).toBe(4);
    const [inAt, outAt] = t.lock.events.slice(2).map((e) => Number(e.split(' ').at(-1)));
    expect(t.calls.slice(inAt, outAt).map((c) => c.line.split(' ').slice(0, 3).join(' '))).toEqual([
      'git worktree remove',
      'git branch -d',
    ]);
  });
});
