import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Answer, Call, World } from './fakes.ts';
import {
  boardSession,
  deps,
  fail,
  laneFile,
  macStats,
  pace,
  porcelain,
  proc,
  world,
} from './fakes.ts';
import { lastStartText } from './pace.ts';
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
  overPace: null,
  waitMin: null,
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
      '--over-pace without a reason',
      { overPace: 'true' },
      [],
      /--over-pace wants a reason/,
      2,
      () => {},
    ],
    [
      '--wait with --over-pace',
      { overPace: 'busy box, hub knows', waitMin: 5 },
      [],
      /--wait and --over-pace together: pick one/,
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
      `tmux send-keys -t %9 -l -- claude -n ${B} --autocompact 500000 '${KICKOFF_PROMPT}'`,
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
      `claude -n ${B} --autocompact 500000`,
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
    expect(claudeLine('x', false, 250000)).toBe('claude -n x --autocompact 250000');
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

  it('a failed or timed-out ls-remote refuses with 1, nothing changed', async () => {
    const w = world();
    const t = deps(w, script(w, [['git ls-remote', fail('git ls-remote timed out after 30 s')]]));
    expect(await start(t.d, args())).toBe(1);
    expect(t.out()).toMatch(
      /git ls-remote failed \(nothing changed\): git ls-remote timed out after 30 s/,
    );
    expect(mutated(t.calls)).toEqual([]);
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
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

// F120: advice, never a refusal (docs/ops/HUB.md → lanes on battery)
describe('lane start: the Mac on battery', () => {
  it('notes the ≤ 3 lanes advice with 3 lanes active on battery under 30%, and still starts', async () => {
    const w = world();
    claudeSession(w);
    for (const [i, b] of ['one', 'two', 'three'].entries()) {
      proc(w, 9000 + i, '777');
      boardSession(w, 9000 + i, b);
    }
    const t = deps(w, script(w, [], ['one', 'two', 'three']));
    writeFileSync(
      join(w.board, 'mac-stats.json'),
      macStats(t.clock.now(), { source: 'battery', batteryPct: 25, state: 'discharging' }),
    );
    expect(await start(t.d, args())).toBe(0);
    expect(t.out()).toMatch(
      /note: the Mac is on battery or Low Power Mode, 3 lanes active already: suggest ≤ 3 lanes/,
    );
  });

  it('no note on AC with 3 lanes, or on Low Power Mode with fewer', async () => {
    for (const [lanes, power] of [
      [['one', 'two', 'three'], { batteryPct: 10 }],
      [['one'], { lowPowerMode: true }],
    ] as const) {
      const w = world();
      claudeSession(w);
      for (const [i, b] of lanes.entries()) {
        proc(w, 9000 + i, '777');
        boardSession(w, 9000 + i, b);
      }
      const t = deps(w, script(w, [], [...lanes]));
      writeFileSync(join(w.board, 'mac-stats.json'), macStats(t.clock.now(), power));
      expect(await start(t.d, args())).toBe(0);
      expect(t.out()).not.toMatch(/note: the Mac/);
    }
  });
});

describe('lane start: the pace gate', () => {
  const T0 = Date.parse('2026-10-13T20:00:00Z'); // fakeClock's start
  const paceAt = (w: World, over: object = {}, now = T0) =>
    writeFileSync(join(w.board, 'pace.json'), pace(now, over));
  const HOT_CONTROL = '{"state":"hot","since":1,"held":[]}';
  const stamp = (w: World, b: string, now: number) =>
    writeFileSync(join(w.board, 'lane-last-start.json'), lastStartText(b, now));

  it('a calm fresh pace starts and stamps the last start', async () => {
    const w = world();
    claudeSession(w);
    const t = deps(w, script(w));
    expect(await start(t.d, args())).toBe(0);
    expect(JSON.parse(readFileSync(join(w.board, 'lane-last-start.json'), 'utf8'))).toEqual({
      v: 1,
      at: T0 / 1000,
      branch: B,
    });
    expect(t.out()).not.toMatch(/pace/);
  });

  it.each([
    ['state hot', { state: 'hot' }, /the container is hot \(pace.json state "hot"\)/],
    [
      'cores at 7.5',
      { avg: { anonMiB: 8000, cores: 7.5, psiCpu: 1 } },
      /cores avg 7.5, wants under 7.5/,
    ],
    [
      'CPU PSI at 40',
      { avg: { anonMiB: 8000, cores: 1, psiCpu: 40 } },
      /CPU PSI avg 40, wants under 40/,
    ],
    [
      'anon at 9000',
      { avg: { anonMiB: 9000, cores: 1, psiCpu: 1 } },
      /anon avg 9000 MiB, wants under 9000/,
    ],
    ['memory PSI full over 1', { psiMemFull: 2.5 }, /memory PSI full 2.5, wants at most 1/],
    ['a warming watcher', { samples: 1 }, /the watcher has 1 of 3 samples/],
    ['a hot pace-control', {}, /the hub marked the box hot \(pace-control.json\)/, HOT_CONTROL],
    ['a half-written pace-control', {}, /pace-control.json is unreadable/, '{"sta'],
    ['a stale pace file', { heartbeat: T0 / 1000 - 181 }, /pace.json is 181 s old \(over 180\)/],
  ] as [string, object, RegExp, string?][])(
    'refuses on %s with 75 before the lock, nothing changed',
    async (_, over, msg, control) => {
      const w = world();
      paceAt(w, over);
      if (control !== undefined) writeFileSync(join(w.board, 'pace-control.json'), control);
      const t = deps(w, script(w));
      expect(await start(t.d, args())).toBe(75);
      expect(t.out()).toMatch(msg);
      expect(t.out()).toMatch(/Retry later, pass --wait, or --over-pace "<reason>"\.$/);
      expect(t.lock.events).toEqual([]);
      expect(t.calls.map((c) => c.line)).toEqual([
        'tmux display -p -t %1 #{session_id} #{pid} #{start_time}',
      ]);
      expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
      expect(existsSync(join(w.board, 'lane-last-start.json'))).toBe(false);
    },
  );

  it('a high load5 alone is not judged: it counts I/O waits here', async () => {
    const w = world();
    claudeSession(w);
    paceAt(w, { load5: 25 });
    const t = deps(w, script(w));
    expect(await start(t.d, args())).toBe(0);
  });

  it('refuses with no pace file, naming the watcher', async () => {
    const w = world();
    const t = deps(w, script(w));
    rmSync(join(w.board, 'pace.json'));
    expect(await start(t.d, args())).toBe(75);
    expect(t.out()).toMatch(
      /no pace.json in .*board: the watcher is not running, restart .*board\/pace-watch.sh/,
    );
    expect(mutated(t.calls)).toEqual([]);
  });

  it('a second start inside the spacing refuses; at the spacing it passes the gate', async () => {
    const w = world();
    stamp(w, 'other-lane', T0 - 45_000);
    const t = deps(w, script(w));
    expect(await start(t.d, args())).toBe(75);
    expect(t.out()).toMatch(/lane other-lane started 45 s ago, wants 120 s between starts/);

    stamp(w, 'other-lane', T0 - 120_000);
    claudeSession(w);
    const t2 = deps(w, script(w));
    expect(await start(t2.d, args())).toBe(0);
  });

  it('the in-lock re-check refuses a start that raced past the first check', async () => {
    const w = world();
    const t = deps(
      w,
      script(w, [
        [
          'git fetch origin',
          () => {
            stamp(w, 'racer', T0); // another start claimed while this one fetched
            return '';
          },
        ],
      ]),
    );
    expect(await start(t.d, args())).toBe(75);
    expect(t.out()).toMatch(
      /pace: turned busy during the start \(lane racer started 0 s ago, wants 120 s between starts\); nothing changed, rerun/,
    );
    expect(mutated(t.calls)).toEqual([]);
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
  });

  it('--over-pace goes past a missing file and the spacing, records and logs why, and still stamps', async () => {
    const w = world();
    claudeSession(w);
    stamp(w, 'other-lane', T0 - 10_000);
    const t = deps(w, script(w));
    rmSync(join(w.board, 'pace.json'));
    expect(await start(t.d, args({ overPace: 'hub: watcher restarting' }))).toBe(0);
    expect(t.out()).toMatch(
      /over the pace gate \(no pace.json in .*; lane other-lane started 10 s ago.*\): hub: watcher restarting/,
    );
    const rec = JSON.parse(readFileSync(join(w.board, 'lifecycle', `${B}.json`), 'utf8'));
    expect(rec.overPace).toBe('hub: watcher restarting');
    expect(JSON.parse(readFileSync(join(w.board, 'lane-last-start.json'), 'utf8')).branch).toBe(B);
  });

  it('--over-pace on a hot box goes on', async () => {
    const w = world();
    claudeSession(w);
    paceAt(w, { state: 'hot', avg: { anonMiB: 9500, cores: 1, psiCpu: 1 } });
    const t = deps(w, script(w));
    expect(await start(t.d, args({ overPace: 'the maintainer said go' }))).toBe(0);
    expect(t.out()).toMatch(
      /over the pace gate \(the container is hot .*; anon avg 9500 MiB, wants under 9000\)/,
    );
  });

  it('--wait starts once the pace clears, taking the lock only after', async () => {
    const w = world();
    claudeSession(w);
    paceAt(w, { avg: { anonMiB: 8000, cores: 8, psiCpu: 10 } });
    const t = deps(w, script(w));
    let sleeps = 0;
    t.clock.sleep = async (ms) => {
      t.clock.t += ms;
      if (++sleeps === 3)
        paceAt(w, {}, t.clock.t); // the watcher's next calm tick
      else if (sleeps < 3) paceAt(w, { avg: { anonMiB: 8000, cores: 8, psiCpu: 10 } }, t.clock.t);
    };
    expect(await start(t.d, args({ waitMin: 5 }))).toBe(0);
    expect(sleeps).toBe(3);
    expect(t.out().match(/waiting \(up to 5 min\)/g)).toHaveLength(1); // logged once, not per poll
    expect(t.out()).toMatch(/^pace: cores avg 8, wants under 7.5; waiting \(up to 5 min\)$/m);
    expect(t.lock.events[0]).toBe('lock after 1'); // only the tmux display ran before it
  });

  it('--wait gives up with 75 when the pace stays busy, naming the last reason', async () => {
    const w = world();
    paceAt(w, { state: 'hot' });
    const t = deps(w, script(w));
    t.clock.sleep = async (ms) => {
      t.clock.t += ms;
      paceAt(w, { state: 'hot' }, t.clock.t);
    };
    expect(await start(t.d, args({ waitMin: 5 }))).toBe(75);
    expect(t.clock.t - T0).toBe(5 * 60_000);
    expect(t.out()).toMatch(/lane: pace: still busy after 5 min: the container is hot/);
    expect(t.lock.events).toEqual([]);
    expect(mutated(t.calls)).toEqual([]);
  });

  it('--wait keeps waiting on a stale file, and logs again when the reason changes', async () => {
    const w = world();
    paceAt(w, { heartbeat: T0 / 1000 - 600 });
    const t = deps(w, script(w));
    let sleeps = 0;
    t.clock.sleep = async (ms) => {
      t.clock.t += ms;
      if (++sleeps === 4) paceAt(w, { avg: { anonMiB: 8000, cores: 8, psiCpu: 10 } }, t.clock.t); // the watcher came back, still busy
      if (sleeps > 4) paceAt(w, { avg: { anonMiB: 8000, cores: 8, psiCpu: 10 } }, t.clock.t);
    };
    expect(await start(t.d, args({ waitMin: 3 }))).toBe(75);
    expect(sleeps).toBe(6);
    expect(t.out().match(/waiting/g)).toHaveLength(2);
    expect(t.out()).toMatch(/still busy after 3 min: cores avg 8, wants under 7.5$/);
  });

  it('the in-lock re-check also catches the hub marking the box hot mid-start', async () => {
    const w = world();
    const t = deps(
      w,
      script(w, [
        [
          'git fetch origin',
          () => {
            writeFileSync(join(w.board, 'pace-control.json'), HOT_CONTROL);
            return '';
          },
        ],
      ]),
    );
    expect(await start(t.d, args())).toBe(75);
    expect(t.out()).toMatch(
      /pace: turned busy during the start \(the hub marked the box hot \(pace-control.json\)\); nothing changed, rerun with --wait$/,
    );
    expect(mutated(t.calls)).toEqual([]);
  });

  it('a --wait start that loses the in-lock race waits again, then starts', async () => {
    const w = world();
    claudeSession(w);
    let fetches = 0;
    const t = deps(
      w,
      script(w, [
        [
          'git fetch origin',
          () => {
            if (++fetches === 1) stamp(w, 'racer', t.clock.now()); // another start claimed meanwhile
            return '';
          },
        ],
      ]),
    );
    t.clock.sleep = async (ms) => {
      t.clock.t += ms;
      paceAt(w, {}, t.clock.t);
    };
    expect(await start(t.d, args({ waitMin: 5 }))).toBe(0);
    expect(fetches).toBe(2);
    expect(t.out()).toMatch(/pace: another start got in first; waiting again/);
    expect(t.out()).toMatch(/lane racer started 0 s ago, wants 120 s between starts; waiting/);
    expect(t.clock.t - T0).toBe(120_000);
  });

  it('a --wait start that loses the race with no time left exits 75', async () => {
    const w = world();
    const t = deps(
      w,
      script(w, [
        [
          'git fetch origin',
          () => {
            t.clock.t += 60_000; // a slow fetch spends the whole wait
            paceAt(w, {}, t.clock.t);
            stamp(w, 'racer', t.clock.t);
            return '';
          },
        ],
      ]),
    );
    expect(await start(t.d, args({ waitMin: 1 }))).toBe(75);
    expect(t.out()).toMatch(/lane: pace: still busy after 1 min: lane racer started 0 s ago/);
    expect(mutated(t.calls)).toEqual([]);
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(false);
  });

  it('an unwritable start stamp only warns: the start goes on', async () => {
    const w = world();
    claudeSession(w);
    mkdirSync(join(w.board, 'lane-last-start.json')); // a directory where the file goes
    const t = deps(w, script(w));
    expect(await start(t.d, args())).toBe(0);
    expect(t.out()).toMatch(
      /warning: start time not recorded \(the spacing won't see this start\)/,
    );
    expect(existsSync(join(w.board, 'lifecycle', `${B}.json`))).toBe(true);
  });

  it('a rolled-back start still counts for spacing', async () => {
    const w = world();
    const t = deps(w, script(w, [['pnpm install', fail('ENOSPC')]]));
    expect(await start(t.d, args())).toBe(1);
    expect(t.out()).toMatch(/rolled back: nothing left behind/);
    expect(JSON.parse(readFileSync(join(w.board, 'lane-last-start.json'), 'utf8')).branch).toBe(B);
  });
});

describe('lane start: the auto-compact window', () => {
  const sent = async (lanes: object | null) => {
    const w = world();
    claudeSession(w);
    if (lanes) writeFileSync(join(w.main, 'scripts/board/limits.json'), JSON.stringify({ lanes }));
    const t = deps(w, script(w));
    expect(await start(t.d, args())).toBe(0);
    return {
      line: t.calls.find((c) => c.line.includes('send-keys -t %9 -l'))!.args.at(-1),
      out: t.out(),
    };
  };

  it('limits.json sets it, 0 turns it off, absent is 500000', async () => {
    expect((await sent({ autoCompactWindow: 300000 })).line).toBe(
      `claude -n ${B} --autocompact 300000`,
    );
    expect((await sent({ autoCompactWindow: 0 })).line).toBe(`claude -n ${B}`);
    expect((await sent(null)).line).toBe(`claude -n ${B} --autocompact 500000`);
  });

  it.each([[99999], [1000001], [250000.5], ['500k'], ['1; rm x'], [null]])(
    'a bad value %j is noted and defaulted, never typed',
    async (v) => {
      const r = await sent({ autoCompactWindow: v });
      expect(r.line).toBe(`claude -n ${B} --autocompact 500000`);
      expect(r.out).toMatch(
        /note: limits.json lanes.autoCompactWindow .* is not 0 or 100000-1000000 tokens; using 500000/,
      );
    },
  );

  it('the tracked limits.json sets 500000', () => {
    const l = JSON.parse(readFileSync(new URL('../../board/limits.json', import.meta.url), 'utf8'));
    expect(l.lanes.autoCompactWindow).toBe(500000);
  });
});
