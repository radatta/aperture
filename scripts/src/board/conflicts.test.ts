import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, emptyCache, mergeTree, parseCache, type GitRun, type Head } from './conflicts.ts';

const hex = (s: string) => createHash('sha1').update(s).digest('hex');
const sha = (c: string) => hex(`commit ${c}`);
const T = (c: string) => hex(`tree ${c}`);
const NOW = Date.parse('2026-11-17T20:00:00Z');
const head = (branch: string, c: string, files = ['x.ts']): Head => ({
  branch,
  sha: sha(c),
  base: sha('0'),
  files,
  at: NOW - 3600_000,
});

// A scripted git: merge-tree answers from `merges` (keyed by the two shas, sorted), `log` from `logs`.
function fake(
  merges: Record<string, { tree: string; files?: string[] } | 'error'>,
  logs: Record<string, string> = {},
) {
  const calls: string[][] = [];
  const run: GitRun = (args) => {
    calls.push(args);
    if (args[0] === 'merge-tree') {
      const [a, b] = args.slice(-2) as [string, string];
      const m = merges[[a, b].sort().join(' ')];
      if (!m) throw new Error(`unscripted merge ${a} ${b}`);
      if (m === 'error') return { code: 128, stdout: '' };
      const files = m.files ?? [];
      return {
        code: files.length ? 1 : 0,
        stdout: [m.tree, ...files].map((x) => `${x}\0`).join(''),
      };
    }
    if (args[0] === 'log')
      return { code: 0, stdout: logs[args.find((a) => a.includes('..'))!] ?? '' };
    throw new Error(`unscripted git ${args.join(' ')}`);
  };
  return { run, calls, merges: () => calls.filter((c) => c[0] === 'merge-tree').length };
}

const k = (x: string, y: string) => [sha(x), sha(y)].sort().join(' ');
const main = { sha: sha('m'), tree: T('m') };

describe('mergeTree', () => {
  const out = (code: number | null, stdout: string) => () => ({ code, stdout });
  it('reads the tree and the conflicted paths, deduped and sorted', () => {
    expect(mergeTree(out(1, `${T('a')}\0b.ts\0a.ts\0a.ts\0`), 'x', 'y')).toEqual({
      tree: T('a'),
      files: ['a.ts', 'b.ts'],
    });
    expect(mergeTree(out(0, `${T('a')}\0`), 'x', 'y')).toEqual({ tree: T('a'), files: [] });
  });
  it('is null for a bad ref (exit 1, empty stdout), a timeout, another exit, or exit and output disagreeing', () => {
    expect(mergeTree(out(1, ''), 'x', 'y')).toBeNull();
    expect(mergeTree(out(null, ''), 'x', 'y')).toBeNull();
    expect(mergeTree(out(128, `${T('a')}\0`), 'x', 'y')).toBeNull();
    expect(mergeTree(out(0, `${T('a')}\0a.ts\0`), 'x', 'y')).toBeNull();
    expect(mergeTree(out(1, `${T('a')}\0`), 'x', 'y')).toBeNull();
  });
});

describe('check', () => {
  it('names conflicts against main and between lanes, a pair minus what either lane already conflicts on with main', () => {
    const g = fake(
      {
        [k('a', 'm')]: { tree: T('1'), files: ['shared.ts'] },
        [k('b', 'm')]: { tree: T('2') },
        [k('c', 'm')]: { tree: T('3') },
        [k('a', 'b')]: { tree: T('4'), files: ['shared.ts', 'both.ts'] },
        [k('a', 'c')]: { tree: T('5'), files: ['shared.ts'] }, // only the main conflict again: said once, vs main
        [k('b', 'c')]: { tree: T('6') },
      },
      { [`${sha('0')}..${sha('m')}`]: '' },
    );
    const c = check(
      { heads: [head('a', 'a'), head('b', 'b'), head('c', 'c')], main, now: NOW },
      g.run,
      emptyCache(),
    );
    expect(c.conflicts).toEqual([
      { a: 'a', b: 'main', files: ['shared.ts'] },
      { a: 'a', b: 'b', files: ['both.ts'] },
    ]);
    expect(c.clean).toEqual([['b', 'c']]);
    expect(c.pending).toBe(0);
    expect(Object.keys(c.cache.pairs)).toHaveLength(6);
  });

  it('merges nothing on a warm cache, and only the moved lane’s pairs after one commit', () => {
    const merges = {
      [k('a', 'm')]: { tree: T('1') },
      [k('b', 'm')]: { tree: T('2') },
      [k('a', 'b')]: { tree: T('3') },
    } as const;
    const logs = { [`${sha('0')}..${sha('m')}`]: '' };
    const cold = fake(merges, logs);
    const first = check(
      { heads: [head('a', 'a'), head('b', 'b')], main, now: NOW },
      cold.run,
      emptyCache(),
    );
    expect(cold.merges()).toBe(3);

    const warm = fake(merges, logs);
    check({ heads: [head('a', 'a'), head('b', 'b')], main, now: NOW }, warm.run, first.cache);
    expect(warm.merges()).toBe(0);

    const moved = fake(
      { ...merges, [k('n', 'm')]: { tree: T('4') }, [k('a', 'n')]: { tree: T('5') } },
      logs,
    );
    const after = check(
      { heads: [head('a', 'a'), head('b', 'n')], main, now: NOW },
      moved.run,
      first.cache,
    );
    expect(moved.merges()).toBe(2);
    // b's old head drops out of the cache; a's main merge stays
    expect(Object.keys(after.cache.pairs).sort()).toEqual(
      [k('a', 'm'), k('a', 'n'), k('n', 'm')].sort(),
    );
  });

  it('stops at the budget, counts what is left as pending, and the next run picks it up', () => {
    let t = 0;
    const clock = () => t;
    const g = fake(
      {
        [k('a', 'm')]: { tree: T('1') },
        [k('b', 'm')]: { tree: T('2') },
        [k('a', 'b')]: { tree: T('3'), files: ['x.ts'] },
      },
      { [`${sha('0')}..${sha('m')}`]: '' },
    );
    const slow: GitRun = (args, ms) => {
      if (args[0] === 'merge-tree') t += 600;
      return g.run(args, ms);
    };
    const heads = [head('a', 'a'), head('b', 'b')];
    // 600 ms a merge against a 500 ms budget: one new merge a run
    const first = check({ heads, main, now: NOW, budgetMs: 500 }, slow, emptyCache(), clock);
    expect(first.pending).toBe(1); // b vs main didn't run, so b's pair wasn't tried
    expect(first.conflicts).toEqual([]);
    t = 0;
    const second = check({ heads, main, now: NOW, budgetMs: 500 }, slow, first.cache, clock);
    expect(second.pending).toBe(1); // b vs main ran; a vs b waits
    t = 0;
    const third = check({ heads, main, now: NOW, budgetMs: 500 }, slow, second.cache, clock);
    expect(third.pending).toBe(0);
    expect(third.conflicts).toEqual([{ a: 'a', b: 'b', files: ['x.ts'] }]);
  });

  it('never caches an error: the lane is pending and the merge runs again next time', () => {
    const g = fake({ [k('a', 'm')]: 'error' });
    const c = check({ heads: [head('a', 'a')], main, now: NOW }, g.run, emptyCache());
    expect(c.pending).toBe(1);
    expect(c.cache.pairs).toEqual({});
  });

  it('a squash-landed lane drops out: merging it into main changes nothing', () => {
    const g = fake(
      {
        [k('a', 'm')]: { tree: main.tree },
        [k('b', 'm')]: { tree: T('2') },
        [k('a', 'b')]: { tree: T('3'), files: ['x.ts'] },
      },
      { [`${sha('0')}..${sha('m')}`]: '' },
    );
    const c = check(
      { heads: [head('a', 'a'), head('b', 'b')], main, now: NOW },
      g.run,
      emptyCache(),
    );
    expect(c.landed).toEqual(['a']);
    expect(c.conflicts).toEqual([]);
    expect(c.cache.landed[sha('a')]).toEqual({ at: main.sha });
  });

  it('finds the squash commit when main changed the same lines since, and remembers it', () => {
    const sq = sha('s');
    const g = fake(
      {
        [k('a', 'm')]: { tree: T('1'), files: ['x.ts'] }, // main moved on over the squash's lines
        [[sha('a'), sha('p')].sort().join(' ')]: { tree: T('9') }, // an older main commit: not it
        [[sha('a'), sq].sort().join(' ')]: { tree: T('s') }, // the squash: the merge is its tree exactly
      },
      {
        [`${sha('0')}..${sha('m')}`]: `${sha('p')} ${T('p')}\n${sq} ${T('s')}\n${sha('m')} ${main.tree}\n`,
      },
    );
    const c = check({ heads: [head('a', 'a')], main, now: NOW }, g.run, emptyCache());
    expect(c.landed).toEqual(['a']);
    expect(c.conflicts).toEqual([]);
    expect(c.cache.landed[sha('a')]).toEqual({ at: sq });
    const again = fake({});
    expect(check({ heads: [head('a', 'a')], main, now: NOW }, again.run, c.cache).landed).toEqual([
      'a',
    ]);
    expect(again.calls).toEqual([]);
  });

  it('a live lane is checked through main once; a new main commit checks only the commits since', () => {
    const g = fake({ [k('a', 'm')]: { tree: T('1') } }, { [`${sha('0')}..${sha('m')}`]: '' });
    const c = check({ heads: [head('a', 'a')], main, now: NOW }, g.run, emptyCache());
    expect(c.cache.landed[sha('a')]).toEqual({ through: main.sha });
    const main2 = { sha: sha('n'), tree: T('n') };
    const g2 = fake({ [k('a', 'n')]: { tree: T('2') } }, { [`${sha('m')}..${sha('n')}`]: '' });
    const c2 = check({ heads: [head('a', 'a')], main: main2, now: NOW }, g2.run, c.cache);
    expect(g2.calls.find((x) => x[0] === 'log')).toContain(`${sha('m')}..${sha('n')}`);
    expect(c2.cache.landed[sha('a')]).toEqual({ through: main2.sha });
  });

  it('a lane with no commit for STALE_DAYS is stale: no merges, out of the lists', () => {
    const g = fake({});
    const old = { ...head('a', 'a'), at: NOW - 8 * 86400_000 };
    const c = check({ heads: [old], main, now: NOW }, g.run, emptyCache());
    expect(c).toMatchObject({ stale: ['a'], conflicts: [], landed: [], pending: 0 });
    expect(g.calls).toEqual([]);
  });

  it('parseCache starts over on a torn or foreign file', () => {
    expect(parseCache(null)).toEqual(emptyCache());
    expect(parseCache('{"v":1,"pa')).toEqual(emptyCache());
    expect(parseCache('{"v":2,"pairs":{},"landed":{}}')).toEqual(emptyCache());
  });
});

// The real git: a temp repo with a lane that conflicts with main, one that merges cleanly, and one squash-merged.
describe('check against git', () => {
  it('tells a conflict, a clean lane and a squash-landed lane apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflicts-'));
    const g = (...a: string[]) =>
      execFileSync('git', ['-C', dir, ...a], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      }).trim();
    const write = (f: string, s: string) => writeFileSync(join(dir, f), s);
    const commit = (m: string) => (g('add', '-A'), g('commit', '-qm', m), g('rev-parse', 'HEAD'));
    g('init', '-q', '-b', 'trunk');
    write('a.txt', 'one\ntwo\nthree\n');
    write('b.txt', 'b\n');
    const base = commit('base');
    g('switch', '-qc', 'hot');
    write('a.txt', 'one\nHOT\nthree\n');
    const hot = commit('hot');
    g('switch', '-q', 'trunk');
    g('switch', '-qc', 'cool');
    write('b.txt', 'b\ncool\n');
    const cool = commit('cool');
    g('switch', '-q', 'trunk');
    g('switch', '-qc', 'done');
    write('c.txt', 'c\n');
    const done = commit('done');
    g('switch', '-q', 'trunk');
    write('c.txt', 'c\n'); // the squash of `done`
    commit('squash done');
    write('a.txt', 'one\nMAIN\nthree\n');
    const m = commit('main edit');
    const run: GitRun = (args, ms) => {
      const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: ms });
      return { code: r.status, stdout: r.stdout };
    };
    const at = Date.now();
    const heads: Head[] = [
      { branch: 'hot', sha: hot, base, files: ['a.txt'], at },
      { branch: 'cool', sha: cool, base, files: ['b.txt'], at },
      { branch: 'done', sha: done, base, files: ['c.txt'], at },
    ];
    const c = check(
      { heads, main: { sha: m, tree: g('rev-parse', `${m}^{tree}`) }, now: at },
      run,
      emptyCache(),
    );
    expect(c.conflicts).toEqual([{ a: 'hot', b: 'main', files: ['a.txt'] }]);
    expect(c.landed).toEqual(['done']);
    expect(c.clean).toEqual([['cool', 'hot']]);
    expect(c.pending).toBe(0);
  });
});
