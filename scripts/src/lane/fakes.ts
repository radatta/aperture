// Test doubles for the lane lifecycle: a scripted git/gh/tmux/pnpm runner (argv-prefix answers, unscripted calls
// fail), a manual clock, and a throwaway main checkout + board + home + /proc under one mkdtemp. Disk is real (the
// real LaneFs on the temp tree); no command ever runs.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '../bot/sh.ts';
import { fakeClock } from '../bot/fakes.ts';
import { realFs } from './archive.ts';
import { lanesAt } from './cli.ts';
import type { Deps } from './state.ts';

export type Call = {
  line: string;
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
export type Answer = string | ((c: Call) => string);
export const fail =
  (msg = 'exit 1') =>
  () => {
    throw new Error(msg);
  };

export function fakeRun(answers: [string, Answer][]): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run = ((cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const c = { line: [cmd, ...args].join(' '), cmd, args, cwd: opts?.cwd, env: opts?.env };
    calls.push(c);
    const hit = answers.find(([p]) => c.line.startsWith(p));
    if (!hit) throw new Error(`unscripted: ${c.line}`);
    return typeof hit[1] === 'function' ? hit[1](c) : hit[1];
  }) as Run;
  return { run, calls };
}

export function world() {
  const root = mkdtempSync(join(tmpdir(), 'lane-'));
  const main = join(root, 'main');
  const dirs = {
    main,
    board: join(root, 'board'),
    home: join(root, 'home'),
    proc: join(root, 'proc'),
  };
  for (const d of [
    join(main, 'scripts/board'),
    join(main, '.claude/worktrees'),
    dirs.board,
    dirs.home,
    dirs.proc,
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(main, 'scripts/board/hub.json'), '{ "v": 1, "name": "dispatch" }\n');
  return { root, ...dirs };
}
export type World = ReturnType<typeof world>;

export function deps(w: World, answers: [string, Answer][], over: Partial<Deps['env']> = {}) {
  const { run, calls } = fakeRun(answers);
  const logs: string[] = [];
  const clock = fakeClock();
  const sync = {
    calls: 0,
    fail: null as string | null,
    ran: [] as string[],
    logged: [] as string[],
  };
  const d: Deps = {
    run,
    fs: realFs,
    lanes: lanesAt(w.board),
    clock,
    log: (s) => logs.push(s),
    env: {
      mainRoot: w.main,
      cwdTop: w.main,
      invokedIn: w.main,
      boardDir: w.board,
      home: w.home,
      tmuxPane: '%1',
      macRoot: '/mac/repo',
      macNote: '',
      slug: 'owner/repo',
      procDir: w.proc,
      ...over,
    },
    syncMain: () => {
      sync.calls++;
      sync.ran = calls.map((c) => c.line); // what had run, and been said, when main was synced
      sync.logged = [...logs];
      if (sync.fail !== null) throw new Error(sync.fail);
      return 'main checkout: already at aaaaaaa\ntower: restart not needed (serving aaaaaaa)';
    },
  };
  return { d, calls, logs, clock, sync, out: () => logs.join('\n') };
}

// A /proc/<pid>/stat whose start tick is field 22 (the 20th after the `)`).
export function proc(w: World, pid: number, start: string, state = 'S') {
  mkdirSync(join(w.proc, String(pid)), { recursive: true });
  const after = [state, ...Array.from({ length: 18 }, (_, i) => String(i + 1)), start, '0'].join(
    ' ',
  );
  writeFileSync(join(w.proc, String(pid), 'stat'), `${pid} (claude code) ${after}\n`);
}

export function boardSession(w: World, pid: number, branch: string, start = '777', state = 'idle') {
  mkdirSync(join(w.board, 'sessions'), { recursive: true });
  writeFileSync(
    join(w.board, 'sessions', `${pid}.json`),
    JSON.stringify({ v: 1, pid, pidStart: start, name: branch, branch, state }),
  );
}

export function laneFile(w: World, branch: string, phase: string, pr: number | null = null) {
  mkdirSync(join(w.board, 'lanes'), { recursive: true });
  writeFileSync(
    join(w.board, 'lanes', `${branch}.json`),
    JSON.stringify({ v: 1, branch, phase, updatedAt: '2026-11-14T00:00:00Z', pr }),
  );
}

export const porcelain = (main: string, branches: string[]) =>
  [`worktree ${main}`, 'HEAD abc', 'detached', '']
    .concat(
      ...branches.map((b) => [
        `worktree ${main}/.claude/worktrees/${b}`,
        'HEAD abc',
        `branch refs/heads/${b}`,
        '',
      ]),
    )
    .join('\n');
