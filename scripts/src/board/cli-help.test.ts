// `--help` / `-h` and unknown arguments stop before anything runs (bot/help.ts): no stdin read (decide-heavy would
// block on a terminal), no file read or write.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { commands, usageFor, usageKeys } from '../bot/help.ts';
import { FLAGS, USAGE, main } from './cli.ts';
import { LANE_USAGE } from './tower/lanes.ts';

const noStdin = vi.fn((): string => {
  throw new Error('read stdin');
});

describe('board cli … --help', () => {
  it.each(
    commands(USAGE)
      .filter((c) => c !== 'lane')
      .flatMap((c) => ['--help', '-h'].map((h) => [c, h])),
  )('%s %s → its usage, nothing read', (c, h) => {
    expect(main([c, h], noStdin)).toBe(usageFor(USAGE, c));
    expect(noStdin).not.toHaveBeenCalled();
  });

  it('overlap --help with real arguments writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-help-'));
    expect(main(['overlap', dir, dir, '--help'], noStdin)).toBe(usageFor(USAGE, 'overlap'));
    expect(existsSync(join(dir, 'overlap.json'))).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('lane keeps its own usage for -h and --help; help lane gets the board line', () => {
    expect(main(['lane', '-h'], noStdin)).toBe(LANE_USAGE);
    expect(main(['lane', '--help'], noStdin)).toBe(LANE_USAGE);
    expect(main(['help', 'lane'], noStdin)).toBe(usageFor(USAGE, 'lane'));
    expect(main(['help'], noStdin)).toBe(USAGE);
  });
});

describe('board cli … refuses what it does not know', () => {
  it.each([
    [['decide-heavy', '--dry-run']],
    [['report', '/x', '--jsn']],
    [['staleness', 'a', 'b', 'c']],
    [['overlap', '-n', 'a']],
    [['report', '/x', '--json=1']],
    [['budget', '/x', '--jsn']],
    [['budget-report', '/x', '1', 'extra']],
  ])('%j → throws (exit 2), nothing read', (argv) => {
    expect(() => main(argv, noStdin)).toThrow(/unknown|unexpected|takes no value|needs a value/);
    expect(noStdin).not.toHaveBeenCalled();
  });

  it('lets real invocations through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-help-'));
    expect(JSON.parse(main(['barriers', dir, '7', '--json'], noStdin))).toBeTruthy();
    rmSync(dir, { recursive: true });
    expect(() => main(['decide-heavy'], noStdin)).toThrow('read stdin');
  });

  it('the flag table covers every command USAGE names, and no other', () => {
    expect(Object.keys(FLAGS).sort()).toEqual(usageKeys(USAGE).sort());
  });
});

describe('board cli decide-heavy with the log-only budget', () => {
  it('prints the same decision with or without a budget input, and logs one event beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-budget-'));
    const limits = JSON.parse(
      readFileSync(new URL('../../board/limits.json', import.meta.url), 'utf8'),
    );
    const input = {
      limits,
      liveLimits: { pidsMax: 4096, highBytes: 18 * 1073741824 },
      live: { pids: 300, anonBytes: 2 * 1073741824 },
      slots: [
        {
          pid: 9,
          class: 'test',
          label: 'x',
          startedAt: '2026-11-18T00:00:00Z',
          wrapperPid: 9,
          cmd: null,
        },
      ],
      req: { class: 'test', loadTest: false },
    };
    const plain = main(['decide-heavy'], () => JSON.stringify(input));
    const logged = main(['decide-heavy'], () =>
      JSON.stringify({
        ...input,
        budget: { board: dir, owner: 1, label: 'gate:wide', cmd: 'pnpm gate:fast' },
      }),
    );
    expect(logged).toBe(plain);
    const day = new Date().toISOString().slice(0, 10);
    const ev = readFileSync(join(dir, 'history', `events-${day}.jsonl`), 'utf8')
      .trim()
      .split('\n');
    expect(ev.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({
        kind: 'budget',
        scope: 'job',
        label: 'gate:wide',
        cmd: 'pnpm gate:fast',
        kWhy: 'unknown', // no mac-stats.json: k 1.3, so 0.5 + 3 + 3 > 5
        would: 'wait',
      }),
    ]);
    // a board dir it can't write (under a regular file: ENOTDIR) is swallowed: the same decision comes back
    const file = join(dir, 'a-file');
    writeFileSync(file, '');
    const blocked = main(['decide-heavy'], () =>
      JSON.stringify({ ...input, budget: { board: join(file, 'board'), owner: 1 } }),
    );
    expect(blocked).toBe(plain);
    rmSync(dir, { recursive: true });
  });
});
