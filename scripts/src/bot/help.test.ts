import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.ts';
import { cliGuard, commands, usageFor } from './help.ts';
import type { Spec } from './help.ts';

const USAGE = `pnpm tool <command>   (-h / --help on any command)
  go [--fast]        do it
                     — a continuation line
  lock status        read
  lock wait [--any]  block`;
const TABLE: Record<string, Spec> = {
  go: { flags: ['fast'] },
  'lock status': { flags: [] },
  'lock wait': { flags: ['any'] },
};
const guard = (...argv: string[]) => cliGuard(argv, USAGE, TABLE, parseArgs);

describe('usageFor', () => {
  it("prints a command's lines with their continuations, under the head", () => {
    expect(usageFor(USAGE, 'go')).toBe(
      'pnpm tool go\n  go [--fast]        do it\n                     — a continuation line',
    );
    expect(usageFor(USAGE, 'lock')?.split('\n')).toHaveLength(3);
    expect(usageFor(USAGE, 'nope')).toBeNull();
  });

  it('lists the commands a usage names, once each', () => {
    expect(commands(USAGE)).toEqual(['go', 'lock']);
  });
});

describe('cliGuard: help', () => {
  it.each([
    [['go', '--help']],
    [['go', '-h']],
    [['go', '--help=yes']],
    [['--help', 'go']], // parseArgs alone would take `go` as --help's value
    [['-h', 'go', '--fast']],
    [['help', 'go']],
    [['go', '--unknown', '-h']], // help wins over a refusal
  ])('%j → the command’s usage, exit 0', (argv) => {
    expect(guard(...argv)).toEqual({ code: 0, out: usageFor(USAGE, 'go') });
  });

  it('a subcommand gets its whole command’s lines', () => {
    expect(guard('lock', 'wait', '-h')).toEqual({ code: 0, out: usageFor(USAGE, 'lock') });
  });

  it('bare help → the full usage, exit 0; help for an unknown command → exit 2', () => {
    expect(guard('help')).toEqual({ code: 0, out: USAGE });
    expect(guard('--help')).toEqual({ code: 0, out: USAGE });
    expect(guard('frob', '--help')).toEqual({ code: 2, out: `unknown command "frob"\n${USAGE}` });
  });

  it('a flag value of -h is help too (fails safe: help runs nothing)', () => {
    expect(guard('go', '--fast', '-h')?.code).toBe(0);
  });
});

describe('cliGuard: refusals', () => {
  it.each([
    [['go', '--dry-run'], 'go: unknown flag --dry-run'],
    [['go', '-n'], 'go: unknown option -n'],
    [['go', 'now'], 'go: unexpected argument now'],
    [['lock'], 'unknown lock subcommand ""'],
    [['lock', 'frob'], 'unknown lock subcommand "frob"'],
    [['lock', 'status', '--any'], 'lock status: unknown flag --any'],
  ])('%j → exit 2: %s', (argv, why) => {
    const v = guard(...argv);
    expect(v?.code).toBe(2);
    expect(v?.out.split('\n')[0]).toBe(why);
  });

  it('lets known commands with known flags through, and leaves unknown commands to main', () => {
    expect(guard('go', '--fast')).toBeNull();
    expect(guard('lock', 'wait', '--any')).toBeNull();
    expect(guard()).toBeNull();
    expect(guard('frob', '--x')).toBeNull();
  });

  it('a null spec parses its own arguments', () => {
    expect(cliGuard(['own', '--anything', 'x'], USAGE, { own: null }, parseArgs)).toBeNull();
  });

  it('allows the positionals a spec counts, no more', () => {
    const t = { two: { flags: [], args: 2 } };
    expect(cliGuard(['two', 'a', 'b'], USAGE, t, parseArgs)).toBeNull();
    expect(cliGuard(['two', 'a', 'b', 'c'], USAGE, t, parseArgs)?.code).toBe(2);
  });
});
