import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deps, macStats, pace, porcelain, world } from './fakes.ts';
import { usageKeys } from '../bot/help.ts';
import { FLAGS, USAGE, main } from './cli.ts';

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
    expect(await main(['start', 'a', '--kickoff'], never)).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toMatch(/unknown command "nuke"/);
    err.mockRestore();
  });

  it('help anywhere on the line prints usage and runs nothing (bot/help.ts cliGuard)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const argv of [
      ['start', 'x', '--help'],
      ['end', 'x', '-h'],
      ['help', 'status'],
    ])
      expect(await main(argv, never), argv.join(' ')).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toMatch(/pnpm lanes end/);
    log.mockRestore();
  });

  it('a value flag without a value, or a retired flag, is refused', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['end', 'x', '--force-abandon'], never)).toBe(2);
    // --skip-permissions was dropped: sessions here start in bypass anyway (F136)
    expect(await main(['start', 'x', '--skip-permissions'], never)).toBe(2);
    err.mockRestore();
  });

  it('--wait takes nothing or whole minutes 1 to 30; anything else exits 2 before deps', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const argv of [
      ['start', '--wait', 'new-lane'], // the branch swallowed as the value
      ['start', 'x', '--wait=0'],
      ['start', 'x', '--wait=31'],
      ['start', 'x', '--wait', '2.5'],
    ])
      expect(await main(argv, never), argv.join(' ')).toBe(2);
    expect(err.mock.calls.flat().join('\n')).toMatch(
      /--wait takes whole minutes, 1 to 30: --wait=10/,
    );
    expect(await main(['start', 'x', '--over-pace'], never)).toBe(2);
    err.mockRestore();
  });

  it('--wait bare, =n or n reaches start as minutes', async () => {
    for (const [argv, min] of [
      [['start', 'new-lane', '--wait'], 5],
      [['start', 'new-lane', '--wait=1'], 1],
      [['start', '--wait', '2', 'new-lane'], 2],
    ] as const) {
      const w = world();
      const t = deps(w, [['tmux display', '$0 111 222']]);
      const t0 = t.clock.now();
      writeFileSync(join(w.board, 'pace.json'), pace(t0, { state: 'hot' }));
      t.clock.sleep = async (ms) => {
        t.clock.t += ms;
        writeFileSync(join(w.board, 'pace.json'), pace(t.clock.t, { state: 'hot' })); // the watcher keeps writing
      };
      expect(await main([...argv], () => t.d), argv.join(' ')).toBe(75);
      expect(t.out()).toMatch(
        new RegExp(
          `waiting \\(up to ${min} min\\)[^]*still busy after ${min} min: the container is hot`,
        ),
      );
      expect(t.clock.now() - t0).toBe(min * 60_000);
    }
  });

  it('status shows an over-pace reason from the lifecycle record', async () => {
    const w = world();
    const t = deps(w, [['git worktree list', porcelain(w.main, ['busy-lane'])]]);
    mkdirSync(join(w.board, 'lifecycle'), { recursive: true });
    writeFileSync(
      join(w.board, 'lifecycle', 'busy-lane.json'),
      JSON.stringify({
        v: 1,
        branch: 'busy-lane',
        windowId: '@3',
        overCap: null,
        overPace: 'hub: box idle',
      }),
    );
    expect(await main(['status'], () => t.d)).toBe(0);
    expect(t.out()).toMatch(/^ {2}busy-lane: lifecycle, window @3, over pace: hub: box idle$/m);
  });

  it('every usage command has a flags entry', () => {
    expect(usageKeys(USAGE).sort()).toEqual(Object.keys(FLAGS).sort());
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
    expect(t.out()).toBe(
      '0 of 5 lanes active\nmac: no stats (agent not installed: tower NEEDS YOU)',
    );
  });

  // F120: the hub caps lanes by the Mac's power (docs/ops/HUB.md)
  it('status adds the mac line, with the ≤ 3 lanes advice on Low Power Mode', async () => {
    const w = world();
    const t = deps(w, [['git worktree list', `worktree ${w.main}\nHEAD 1\ndetached\n`]]);
    writeFileSync(join(w.board, 'mac-stats.json'), macStats(t.clock.now(), { lowPowerMode: true }));
    expect(await main(['status'], () => t.d)).toBe(0);
    expect(t.out().split('\n')[1]).toBe(
      'mac: AC 82% charging · Low Power Mode on · no thermal limit — RED: Low Power Mode — suggest ≤ 3 lanes (on battery under 30% or Low Power Mode)',
    );
  });

  it('start.ts and end.ts reach processes and the disk only through the seam', () => {
    for (const f of ['start.ts', 'end.ts', 'state.ts', 'mac-line.ts', 'pace.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/from 'node:(child_process|fs)'/);
    }
  });
});
