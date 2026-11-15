// `--help` / `-h` and unknown arguments stop before anything runs (bot/help.ts): no stdin read (decide-heavy would
// block on a terminal), no file read or write.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
