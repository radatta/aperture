import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, takeLock } from './run';
import { SCENARIOS, selectScenarios } from './scenarios/index';

describe('parseArgs', () => {
  it('defaults to smoke with a deploy wait', () => {
    expect(parseArgs([])).toEqual({ tier: 'smoke', scenarios: [], deployWait: true });
  });
  it('reads every flag', () => {
    const sha = 'c'.repeat(40);
    expect(
      parseArgs(['--', '--tier', 'delta', '--scenario', 'a,b', '--sha', sha, '--no-deploy-wait']),
    ).toEqual({
      tier: 'delta',
      scenarios: ['a', 'b'],
      sha,
      deployWait: false,
    });
  });
  it('refuses bad input', () => {
    expect(() => parseArgs(['--tier', 'all'])).toThrow(/smoke\|delta\|full/);
    expect(() => parseArgs(['--sha', 'abc1234'])).toThrow(/40-hex/);
    expect(() => parseArgs(['--prod'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--tier'])).toThrow(/needs a value/);
  });
});

describe('selectScenarios', () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  it('smoke runs only smoke; full runs everything', () => {
    expect(ids(selectScenarios('smoke', []))).toEqual(['smoke']);
    expect(ids(selectScenarios('full', []))).toEqual(ids(SCENARIOS));
  });
  it('delta runs smoke plus the named ones, and needs a name', () => {
    expect(ids(selectScenarios('delta', ['capture-task']))).toEqual(['smoke', 'capture-task']);
    expect(() => selectScenarios('delta', [])).toThrow(/needs --scenario/);
  });
  it('refuses a selection that runs nothing', () => {
    expect(() => selectScenarios('smoke', ['capture-task'])).toThrow(/no scenario in tier smoke/);
  });
  it('refuses an unknown scenario', () => {
    expect(() => selectScenarios('full', ['nope'])).toThrow(/unknown scenario nope/);
  });
});

describe('takeLock', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'lock-'));
  it('is exclusive while held, and free after release', () => {
    const path = join(dir(), 'run.lock');
    const release = takeLock(path);
    expect(() => takeLock(path)).toThrow(/another dev check \(pid \d+\) holds .*run\.lock/);
    release();
    takeLock(path)();
  });
  it("treats a live process it can't signal (EPERM) as alive", () => {
    const path = join(dir(), 'run.lock');
    writeFileSync(path, '1'); // init: alive, owned by root
    expect(() => takeLock(path)).toThrow(/\(pid 1\) holds/);
  });
  it('takes over an empty or garbage lock file', () => {
    for (const junk of ['', 'abc', '0']) {
      const path = join(dir(), 'run.lock');
      writeFileSync(path, junk);
      takeLock(path)();
    }
  });
  it('takes over a stale lock whose process is gone', () => {
    const path = join(dir(), 'run.lock');
    writeFileSync(path, '4194304'); // above pid_max: never a live process
    takeLock(path)();
  });
});
