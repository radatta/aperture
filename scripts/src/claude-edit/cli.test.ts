import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { usageKeys } from '../bot/help.ts';
import { FLAGS, USAGE, main } from './cli.ts';
import { DIFF_FLAGS, EMPTY_TREE, GIT_PRE, hardenedEnv } from './git.ts';
import type { Git } from './git.ts';
import { Refusal, Stuck } from './rules.ts';
import type { Deps } from './steps.ts';

const never = () => {
  throw new Error('deps built: the guard let it run');
};
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

describe('claude-edit cli', () => {
  it('has a FLAGS entry for every usage command', () =>
    expect(Object.keys(FLAGS).sort()).toEqual(usageKeys(USAGE).sort()));

  it.each([
    [['--help'], 0],
    [['check', '--help'], 0],
    [['check', 'b', '1', '--bogus', 'x'], 2],
    [['stage', 'b', 'extra', '--base', 'x', '--tree', 'y'], 2],
    [['stage', 'b', '--base', 'x'], 2],
    [['stage', 'b', '--base', 'x', '--tree', 'y'], 2],
    [['unstage', 'b', '--base', 'x'], 2],
    [['verify'], 2],
    [['check', 'b', 'zero'], 2],
    [['check', 'b', '1', '--page', '2'], 2],
    [['nope'], 2],
    [[], 2],
  ])('%j exits %i and runs nothing', (argv, code) => {
    quiet();
    expect(main(argv, never)).toBe(code);
  });

  // A git that throws: the CLI maps a Refusal to 1 and Stuck to 3.
  const throwing = (e: Error): (() => Deps) => {
    const main = mkdtempSync(join(tmpdir(), 'ce-cli-'));
    mkdirSync(join(main, '.claude', 'worktrees', 'b'), { recursive: true });
    const fail = () => {
      throw e;
    };
    const git: Git = { exec: fail, out: fail, raw: fail, ok: fail };
    return () => ({
      git,
      main,
      fromMain: true,
      macRoot: 'm',
      now: () => new Date(0),
      log: () => {},
    });
  };
  it.each([
    [new Refusal('no'), 1],
    [new Stuck('help'), 3],
  ])('maps %s to exit %i', (e, code) => {
    quiet();
    const d = throwing(e);
    try {
      expect(main(['check', 'b', '1'], d)).toBe(code);
    } finally {
      rmSync(d().main, { recursive: true, force: true });
    }
  });
  it('runs as the entry point: no command is exit 2', () => {
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    expect(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('the hardened git', () => {
  it('pins attributes, hooks, external diff and the diff shape before every subcommand', () => {
    expect(GIT_PRE[0]).toBe(`--attr-source=${EMPTY_TREE}`);
    for (const kv of [
      'core.attributesFile=/dev/null',
      'core.hooksPath=/dev/null',
      'core.fsmonitor=false',
      'diff.external=',
      'diff.noprefix=false',
      'core.autocrlf=false',
    ])
      expect(GIT_PRE[GIT_PRE.indexOf(kv) - 1]).toBe('-c');
    for (const f of ['--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--binary'])
      expect(DIFF_FLAGS).toContain(f);
  });
});

describe('hardenedEnv', () => {
  it('keeps PATH and drops every inherited GIT_*, HOME and XDG_*', () => {
    const env = hardenedEnv({
      PATH: '/bin',
      HOME: '/h',
      XDG_CONFIG_HOME: '/x',
      GIT_DIR: '/g',
      GIT_INDEX_FILE: '/i',
      GIT_EXTERNAL_DIFF: '/e',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_GLOBAL: '/evil',
    });
    expect(env).toEqual({
      PATH: '/bin',
      LC_ALL: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    });
  });
});
