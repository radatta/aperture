import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deps, world } from './fakes.ts';
import { USAGE, main } from './cli.ts';

const never = () => {
  throw new Error('deps must not be built');
};

describe('lane cli', () => {
  it('usage, unknown commands and stray arguments exit 2 without touching anything', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main([], never)).toBe(2);
    expect(await main(['nuke'], never)).toBe(2);
    expect(await main(['start', 'a', 'b'], never)).toBe(2);
    expect(await main(['start', 'a', '--force'], never)).toBe(2);
    expect(await main(['end', 'a', '--kickoff', 'x'], never)).toBe(2);
    expect(await main(['status', 'x'], never)).toBe(2);
    expect(await main(['start', 'a', '--kickoff'], () => deps(world(), []).d)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toMatch(/unknown command "nuke"/);
    err.mockRestore();
  });

  it('--help prints the usage and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--help'], never)).toBe(0);
    expect(log.mock.calls[0]?.[0]).toBe(USAGE);
    log.mockRestore();
  });

  it('status lists active lanes against the cap', async () => {
    const w = world();
    const t = deps(w, [['git worktree list', `worktree ${w.main}\nHEAD 1\ndetached\n`]]);
    expect(await main(['status'], () => t.d)).toBe(0);
    expect(t.out()).toBe('0 of 5 lanes active');
  });

  it('start.ts and end.ts reach processes and the disk only through the seam', () => {
    for (const f of ['start.ts', 'end.ts', 'state.ts', 'mac-line.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/from 'node:(child_process|fs)'/);
    }
  });
});
