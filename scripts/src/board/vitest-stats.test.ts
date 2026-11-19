import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import setup, { pkgOf, summarize, type FileLike } from './vitest-stats.ts';

const file = (tests: FileLike[], o: Partial<FileLike> = {}): FileLike => ({
  type: 'suite',
  tasks: tests,
  collectDuration: 20,
  setupDuration: 5,
  environmentLoad: 3,
  prepareDuration: 2,
  result: { state: 'pass', duration: 100 },
  ...o,
});
const test = (state: string, mode = 'run'): FileLike => ({ type: 'test', mode, result: { state } });

describe('vitest-stats', () => {
  it('sums what the default reporter sums, counting tests through nested suites', () => {
    const files = [
      file([test('pass'), { type: 'suite', tasks: [test('fail'), test('skip', 'skip')] }]),
      file([test('pass'), test('pass', 'todo')], { collectDuration: 30, result: { duration: 50 } }),
    ];
    expect(summarize('app', files, 1234.6, 5000.4)).toEqual({
      pkg: 'app',
      files: 2,
      tests: 5,
      failed: 1,
      skipped: 2,
      wallMs: 5000,
      ms: { transform: 1235, setup: 10, import: 50, tests: 150, environment: 6, prepare: 4 },
    });
  });

  it('a missing duration counts 0; an internal transformTime that moved is null, never a guess', () => {
    const s = summarize('x', [{ type: 'suite', tasks: [test('pass')] }], undefined, 1);
    expect(s.ms).toEqual({
      transform: null,
      setup: 0,
      import: 0,
      tests: 0,
      environment: 0,
      prepare: 0,
    });
    expect(summarize('x', [], 'nope', 1)).toMatchObject({
      files: 0,
      tests: 0,
      ms: { transform: null },
    });
  });

  it('names the package from the config root', () => {
    expect(pkgOf('/w/app')).toBe('app');
    expect(pkgOf('/w/packages/shared/')).toBe('packages/shared');
    expect(pkgOf('/repo/.claude/worktrees/x/scripts')).toBe('scripts');
  });

  const saved = process.env.HEAVY_DETAIL_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.HEAVY_DETAIL_DIR;
    else process.env.HEAVY_DETAIL_DIR = saved;
  });

  it('the teardown writes one line per process (rewritten, not appended), and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vstats-'));
    process.env.HEAVY_DETAIL_DIR = dir;
    const project = {
      config: { root: '/w/lambdas' },
      vitest: { state: { getFiles: () => [file([test('pass')])], transformTime: 7 } },
    };
    const teardown = setup(project);
    const age = performance.now(); // the process's age: wallMs counts from its start, not from setup()
    teardown();
    teardown(); // app's two projects each run it
    expect(readdirSync(dir)).toEqual([`vitest-${process.pid}.json`]);
    const lines = readFileSync(join(dir, `vitest-${process.pid}.json`), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      pkg: 'lambdas',
      files: 1,
      tests: 1,
      ms: { transform: 7 },
    });
    expect(JSON.parse(lines[0]!).wallMs).toBeGreaterThanOrEqual(Math.floor(age)); // wallMs is rounded
    // a broken state or an unwritable dir: nothing thrown, the run's exit code stays vitest's
    const broken = {
      vitest: {
        state: {
          getFiles: () => {
            throw new Error('moved');
          },
        },
      },
    };
    expect(() => setup(broken)()).not.toThrow();
    process.env.HEAVY_DETAIL_DIR = join(dir, 'gone', 'deeper');
    expect(() => setup(project)()).not.toThrow();
    delete process.env.HEAVY_DETAIL_DIR;
    expect(() => setup(project)()).not.toThrow();
  });
});
