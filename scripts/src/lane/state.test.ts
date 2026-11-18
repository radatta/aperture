import { describe, expect, it } from 'vitest';
import { boardSession, deps, porcelain, proc, world } from './fakes.ts';
import {
  DEFAULT_CAP,
  laneCap,
  laneTrees,
  liveSessionBranches,
  liveSessions,
  nameProblem,
  parseWorktrees,
} from './state.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('nameProblem', () => {
  it('takes a safe lane name up to 63 characters', () => {
    expect(nameProblem('lane-start', 'dispatch')).toBeNull();
    expect(nameProblem('a'.repeat(63), 'dispatch')).toBeNull();
  });
  it.each([
    'a'.repeat(64),
    'Upper',
    'has/slash',
    '-lead',
    'has space',
    'semi;colon',
    'q?',
    '',
    'main',
    'master',
    'dev',
    'devb',
    'test',
    'dispatch',
  ])('refuses %j', (b) => expect(nameProblem(b, 'dispatch')).toMatch(/not a lane name/));
  it('refuses the configured hub name and a missing one', () => {
    expect(nameProblem('hub-two', 'hub-two')).toMatch(/not a lane name/);
    expect(nameProblem(undefined, 'dispatch')).toMatch(/not a lane name/);
  });
});

describe('worktrees', () => {
  it('keeps lane trees only: on a branch, under .claude/worktrees, not board-matrix scratch', () => {
    const t = parseWorktrees(
      porcelain('/m', ['a', 'board-matrix-1']) +
        'worktree /elsewhere/x\nHEAD 1\nbranch refs/heads/x\n',
    );
    expect(t.map((x) => x.branch)).toEqual([null, 'a', 'board-matrix-1', 'x']);
    expect(laneTrees(t, '/m').map((x) => x.branch)).toEqual(['a']);
  });
});

describe('laneCap', () => {
  it('reads lanes.maxActive, defaulting when absent or broken', () => {
    const w = world();
    const { d } = deps(w, []);
    expect(laneCap(d)).toBe(DEFAULT_CAP);
    writeFileSync(join(w.main, 'scripts/board/limits.json'), '{"lanes":{"maxActive":3}}');
    expect(laneCap(d)).toBe(3);
    writeFileSync(join(w.main, 'scripts/board/limits.json'), '{"lanes":{"maxActive":0}}');
    expect(laneCap(d)).toBe(DEFAULT_CAP);
  });
});

describe('liveSessions', () => {
  it('counts every live registered session, the hub and off-branch ones too; dead, reused, zombie and gone are not', () => {
    const w = world();
    const { d } = deps(w, []);
    proc(w, 1, '777');
    boardSession(w, 1, 'lane-a');
    proc(w, 2, '777');
    boardSession(w, 2, ''); // the hub, detached on main: no branch
    proc(w, 3, '999');
    boardSession(w, 3, 'reused'); // pid reused: its start tick differs
    proc(w, 4, '777', 'Z');
    boardSession(w, 4, 'zombie');
    proc(w, 5, '777');
    boardSession(w, 5, 'gone', '777', 'gone');
    boardSession(w, 6, 'dead'); // no /proc entry
    const s = liveSessions(d);
    expect(s.count).toBe(2);
    expect([...s.branches]).toEqual(['lane-a']);
    expect([...liveSessionBranches(d)]).toEqual(['lane-a']);
  });
});
