import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, shasFor, takeLock } from './run';
import { SCENARIOS, selectFeature, selectScenarios } from './scenarios/index';

describe('shasFor', () => {
  const H = 'a'.repeat(40);
  it('tests HEAD, or --sha; -dirty marks only the scenarios, never the build under test', () => {
    expect(shasFor(H, false)).toEqual({ sha: H, scenarioSha: H });
    expect(shasFor(H, true)).toEqual({ sha: H, scenarioSha: `${H}-dirty` });
    expect(shasFor(H, true, 'b'.repeat(40))).toEqual({
      sha: 'b'.repeat(40),
      scenarioSha: `${H}-dirty`,
    });
  });
});

describe('parseArgs', () => {
  it('defaults to smoke with a deploy wait', () => {
    expect(parseArgs([])).toEqual({ tier: 'smoke', scenarios: [], feature: [], deployWait: true });
  });
  it('reads every flag', () => {
    const sha = 'c'.repeat(40);
    expect(
      parseArgs([
        '--',
        '--tier',
        'delta',
        '--scenario',
        'a,b',
        '--feature',
        'a',
        '--sha',
        sha,
        '--no-deploy-wait',
      ]),
    ).toEqual({
      tier: 'delta',
      scenarios: ['a', 'b'],
      feature: ['a'],
      sha,
      deployWait: false,
    });
  });
  it('refuses bad input', () => {
    expect(() => parseArgs(['--tier', 'every'])).toThrow(/smoke\|delta\|full\|all/);
    expect(() => parseArgs(['--sha', 'abc1234'])).toThrow(/40-hex/);
    expect(() => parseArgs(['--prod'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--tier'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--feature'])).toThrow(/needs a value/);
  });
  it('delta defaults --feature to the --scenario ids, smoke excluded; other tiers don’t', () => {
    expect(parseArgs(['--tier', 'delta', '--scenario', 'smoke,a,b']).feature).toEqual(['a', 'b']);
    expect(parseArgs(['--tier', 'full', '--scenario', 'a']).feature).toEqual([]);
    expect(parseArgs(['--scenario', 'a', '--tier', 'delta']).feature).toEqual(['a']); // any order
    expect(parseArgs(['--feature', 'a,a', '--scenario', 'b,b']).feature).toEqual(['a']); // deduped
  });
});

describe('selectFeature', () => {
  const full = selectScenarios('full', []);
  it('returns the ids when each is a known, row-bearing scenario in the run', () => {
    expect(selectFeature(['capture-task'], full)).toEqual(['capture-task']);
    expect(selectFeature([], full)).toEqual([]);
  });
  it('refuses an unknown id, smoke, and a scenario not in the run', () => {
    expect(() => selectFeature(['nope'], full)).toThrow(/unknown scenario nope/);
    expect(() => selectFeature(['smoke'], full)).toThrow(/declares no rows/);
    expect(() => selectFeature(['capture-task'], selectScenarios('smoke', []))).toThrow(
      /not in this run \(smoke\)/,
    );
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
