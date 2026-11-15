// `--help` / `-h` and unknown arguments stop before anything runs (bot/help.ts). Every side-effect boundary main
// can reach — git/shell, the bot config, token minting, the network — throws REACHED, so a passing case touched none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REACHED = 'reached a side effect';
const reached = () => {
  throw new Error(REACHED);
};
vi.mock('./sh.ts', () => ({ run: vi.fn(reached) }));
vi.mock('./config.ts', async (orig) => ({
  ...(await orig<typeof import('./config.ts')>()),
  loadConfig: vi.fn(reached),
}));
vi.mock('./token.ts', async (orig) => ({
  ...(await orig<typeof import('./token.ts')>()),
  mintToken: vi.fn(reached),
}));

const { FLAGS, USAGE, main } = await import('./cli.ts');
const { commands, usageFor, usageKeys } = await import('./help.ts');
const { run } = await import('./sh.ts');
const { loadConfig } = await import('./config.ts');
const { mintToken } = await import('./token.ts');

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(s));
  vi.spyOn(console, 'error').mockImplementation((s: string) => void err.push(s));
  vi.stubGlobal('fetch', vi.fn(reached));
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const untouched = () => {
  for (const f of [run, loadConfig, mintToken, fetch]) expect(f).not.toHaveBeenCalled();
};

// Every command and subcommand the table knows, plus every command USAGE names.
const invocations = [...new Set([...Object.keys(FLAGS), ...commands(USAGE)])];

describe('pnpm bot … --help', () => {
  it.each(invocations.flatMap((c) => ['--help', '-h'].map((h) => [c, h])))(
    '%s %s → its usage, exit 0, nothing run',
    async (c, h) => {
      expect(await main([...c.split(' '), h])).toBe(0);
      expect(out).toEqual([usageFor(USAGE, c.split(' ')[0]!)]);
      untouched();
    },
  );

  it.each([
    [['--help', 'deploy-dev']],
    [['deploy-dev', '--help=1']],
    [['help', 'deploy-dev']],
    [['logs', '--filter', '-h']],
  ])('%j → help, nothing run', async (argv) => {
    expect(await main(argv)).toBe(0);
    untouched();
  });

  it('help alone prints the full usage', async () => {
    expect(await main(['help'])).toBe(0);
    expect(out).toEqual([USAGE]);
  });
});

describe('pnpm bot … refuses what it does not know', () => {
  it.each([
    [['deploy-dev', '--dry-run']],
    [['deploy-dev', '-n']],
    [['deploy-dev', 'devb']],
    [['push', '--after-rebse']],
    [['lock']],
    [['lock', 'frob']],
    [['lock', 'release', '--slot', 'devb']],
    [['logs', '--group', 'bff']],
    [['push', '--after-rebase', 'main']], // a bare flag swallowing a word would run a lease-less push
    [['lock', 'acquire', '--slot']],
    [['lock', 'wait', '--max']],
  ])('%j → exit 2, nothing run', async (argv) => {
    expect(await main(argv)).toBe(2);
    expect(err[0]).toMatch(/unknown|unexpected|takes no value|needs a value/);
    untouched();
  });
});

describe('the guard lets real invocations through', () => {
  it.each([
    [['push']],
    [['push', '--after-rebase']],
    [['deploy-dev']],
    [['lock', 'status']],
    [['lock', 'acquire', '--slot', 'dev']],
    [['lock', 'wait', '--any', '--max', '30']],
    [['lock', 'renew']],
    [['logs', '--since', '30m', '--groups', 'bff,mcp', '--filter', 'ERROR', '--query', 'q']],
    [['logs', '--start', '2026-11-14T00:00:00Z', '--end', '2026-11-14T01:00:00Z']],
  ])('%j reaches main', async (argv) => {
    await expect(main(argv)).rejects.toThrow(REACHED);
  });
});

describe('the flag table', () => {
  it('covers every command USAGE names, and names no command USAGE lacks', () => {
    expect(Object.keys(FLAGS).sort()).toEqual(usageKeys(USAGE).sort());
  });
});
