// `--help` / `-h` and unknown arguments stop before anything runs (bot/help.ts). Every side-effect boundary main
// can reach — git/shell, the host-jobs dir, each command's job — throws REACHED, so a passing case touched none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REACHED = 'reached a side effect';
const reached = () => {
  throw new Error(REACHED);
};
vi.mock('../bot/sh.ts', () => ({ run: vi.fn(reached) }));
vi.mock('./submit.ts', async (orig) => ({
  ...(await orig<typeof import('./submit.ts')>()),
  hostjobsDir: vi.fn(reached),
}));
vi.mock('./open-pr.ts', async (orig) => ({
  ...(await orig<typeof import('./open-pr.ts')>()),
  openPr: vi.fn(reached),
  probe: vi.fn(reached),
}));
vi.mock('./sim.ts', async (orig) => ({
  ...(await orig<typeof import('./sim.ts')>()),
  simCommand: vi.fn(reached),
}));
vi.mock('./clip.ts', async (orig) => ({
  ...(await orig<typeof import('./clip.ts')>()),
  clipProbe: vi.fn(reached),
}));

const { FLAGS, USAGE, main } = await import('./cli.ts');
const { commands, usageFor } = await import('../bot/help.ts');
const fakes = [
  (await import('../bot/sh.ts')).run,
  (await import('./submit.ts')).hostjobsDir,
  (await import('./open-pr.ts')).openPr,
  (await import('./open-pr.ts')).probe,
  (await import('./sim.ts')).simCommand,
  (await import('./clip.ts')).clipProbe,
];

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(s));
  vi.spyOn(console, 'error').mockImplementation((s: string) => void err.push(s));
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());
const untouched = () => {
  for (const f of fakes) expect(f).not.toHaveBeenCalled();
};

describe('pnpm mailroom … --help', () => {
  it.each(commands(USAGE).flatMap((c) => ['--help', '-h'].map((h) => [c, h])))(
    '%s %s → its usage, exit 0, nothing run',
    async (c, h) => {
      expect(await main([c, h])).toBe(0);
      expect(out).toEqual([usageFor(USAGE, c)]);
      untouched();
    },
  );

  it.each([
    [['open-pr', '--title', 'x', '--wait', 'nope', '--help']], // help before the --wait check
    [['--help', 'open-pr']],
    [['help', 'probe']],
  ])('%j → help, nothing run', async (argv) => {
    expect(await main(argv)).toBe(0);
    untouched();
  });
});

describe('pnpm mailroom … refuses what it does not know', () => {
  it.each([
    [['open-pr', '--titel', 'x']],
    [['open-pr', '--title', 'x', '--draft']],
    [['sim-shutdown', '--sign-in']],
    [['probe', 'now']],
    [['clip-probe', '-o', 'x.png']],
  ])('%j → exit 2, nothing run', async (argv) => {
    expect(await main(argv)).toBe(2);
    expect(err[0]).toMatch(/unknown|unexpected/);
    untouched();
  });
});

describe('the guard lets real invocations through', () => {
  it.each([
    [['open-pr', '--title', 'added a thing', '--wait', '60']],
    [['probe', '--wait', '5']],
    [['sim-probe', '--sign-in']],
    [['sim-shutdown']],
    [['clip-probe', '--out', 'x.png', '--wait', '5']],
  ])('%j reaches main', async (argv) => {
    await expect(main(argv)).rejects.toThrow(REACHED);
  });
});

describe('the flag table', () => {
  it('covers every command USAGE names, and names no command USAGE lacks', () => {
    const keys = Object.keys(FLAGS).map((k) => k.split(' ')[0]);
    expect([...new Set(keys)].sort()).toEqual(commands(USAGE).sort());
  });
});
