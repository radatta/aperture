import { describe, expect, it, vi } from 'vitest';
import { usageKeys } from '../bot/help.ts';
import { FLAGS, USAGE, main } from './cli.ts';
import { hardenedEnv } from './git.ts';

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
    [['check', 'b', 'zero'], 2],
    [['check', 'b', '1', '--page', '2'], 2],
    [['nope'], 2],
    [[], 2],
  ])('%j exits %i and runs nothing', (argv, code) => {
    quiet();
    expect(main(argv, never)).toBe(code);
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
