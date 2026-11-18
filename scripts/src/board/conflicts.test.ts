import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as cli, treeOf } from './cli.ts';
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
    // 600 ms a merge against a 500 ms budget: one new merge a run, and no landed walk once it's spent
    const first = check({ heads, main, now: NOW, budgetMs: 500 }, slow, emptyCache(), clock);
    expect(first.pending).toBe(2); // a vs main ran but a's walk waits; b vs main didn't run
    expect(first.conflicts).toEqual([]);
    t = 0;
    const second = check({ heads, main, now: NOW, budgetMs: 500 }, slow, first.cache, clock);
    expect(second.pending).toBe(1); // a walked (live); b vs main ran, its walk and a vs b wait
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

  it('a lane with no commit for STALE_DAYS is stale: out of the lists, never pending, and no pair merges', () => {
    const g = fake(
      { [k('a', 'm')]: { tree: T('1'), files: ['x.ts'] }, [k('b', 'm')]: { tree: T('2') } },
      { [`${sha('0')}..${sha('m')}`]: '' },
    );
    const old = { ...head('a', 'a'), at: NOW - 8 * 86400_000 };
    const c = check({ heads: [old, head('b', 'b')], main, now: NOW }, g.run, emptyCache());
    expect(c).toMatchObject({ stale: ['a'], conflicts: [], landed: [] });
    expect(g.calls.filter((x) => x.includes(sha('a')) && x.includes(sha('b')))).toEqual([]);
  });

  it('a stale lane spends only what the live lanes and their pair left', () => {
    let t = 0;
    const g = fake(
      {
        [k('a', 'm')]: { tree: T('1') },
        [k('b', 'm')]: { tree: T('2') },
        [k('a', 'b')]: { tree: T('3'), files: ['x.ts'] },
        [k('s', 'm')]: { tree: main.tree },
      },
      { [`${sha('0')}..${sha('m')}`]: '' },
    );
    const slow: GitRun = (args, ms) => {
      if (args[0] === 'merge-tree') t += 300;
      return g.run(args, ms);
    };
    const old = { ...head('s', 's'), at: NOW - 30 * 86400_000 };
    const heads = [old, head('a', 'a'), head('b', 'b')]; // the stale lane first on disk
    const c = check({ heads, main, now: NOW, budgetMs: 800 }, slow, emptyCache(), () => t);
    expect(c.conflicts).toEqual([{ a: 'a', b: 'b', files: ['x.ts'] }]); // the live pair merged
    expect(c).toMatchObject({ stale: ['s'], landed: [], pending: 0 }); // no budget left for s: stale, not pending
  });

  it('a stale lane that squash-landed reads landed, so the cleanup hint is kept', () => {
    const g = fake({ [k('a', 'm')]: { tree: main.tree } });
    const old = { ...head('a', 'a'), at: NOW - 30 * 86400_000 };
    const c = check({ heads: [old], main, now: NOW }, g.run, emptyCache());
    expect(c).toMatchObject({ stale: [], landed: ['a'], pending: 0 });
  });

  it('walks main unfiltered for a lane with more files than an argv should carry', () => {
    const many = Array.from({ length: 501 }, (_, i) => `f${i}.ts`);
    const g = fake({ [k('a', 'm')]: { tree: T('1') } });
    check({ heads: [head('a', 'a', many)], main, now: NOW }, g.run, emptyCache());
    expect(g.calls.find((x) => x[0] === 'log')).not.toContain('--');
    const few = fake({ [k('a', 'm')]: { tree: T('1') } });
    check({ heads: [head('a', 'a', ['x.ts'])], main, now: NOW }, few.run, emptyCache());
    expect(few.calls.find((x) => x[0] === 'log')!.slice(-2)).toEqual(['--', 'x.ts']);
  });

  it('a lane is pending, not live, its walk has more main commits than a run tries', () => {
    const many = Array.from({ length: 201 }, (_, i) => `${sha(`c${i}`)} ${T(`c${i}`)}`).join('\n');
    const merges: Record<string, { tree: string; files?: string[] }> = {
      [k('a', 'm')]: { tree: T('1') },
    };
    for (let i = 0; i < 201; i++)
      merges[[sha('a'), sha(`c${i}`)].sort().join(' ')] = { tree: T(`x${i}`) };
    const g = fake(merges, { [`${sha('0')}..${sha('m')}`]: many });
    const c = check({ heads: [head('a', 'a')], main, now: NOW }, g.run, emptyCache());
    expect(c.pending).toBe(1);
    expect(c.cache.landed[sha('a')]).toEqual({ through: sha('c199') }); // the 200th, oldest first
  });

  it('parseCache starts over on a torn or foreign file', () => {
    expect(parseCache(null)).toEqual(emptyCache());
    expect(parseCache('{"v":1,"pa')).toEqual(emptyCache());
    expect(parseCache('{"v":2,"pairs":{},"landed":{}}')).toEqual(emptyCache());
  });
});

// The caller's GIT_DIR, GIT_INDEX_FILE… would point git away from the temp repo.
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

// The real git: a temp repo with a lane that conflicts with main, one that merges cleanly, one squash-merged, and
// one squash-merged that main then edited over (found by walking main's history).
describe('check against git', () => {
  it('tells a conflict, a clean lane and two squash-landed lanes apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflicts-'));
    try {
      realGit(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function realGit(dir: string) {
  const g = (...a: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...a], {
      encoding: 'utf8',
      env: {
        ...cleanEnv(),
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
  g('switch', '-qc', 'later');
  write('d.txt', 'd\nLATER\n');
  const later = commit('later');
  g('switch', '-q', 'trunk');
  write('c.txt', 'c\n'); // the squash of `done`
  commit('squash done');
  write('d.txt', 'd\nLATER\n'); // the squash of `later`…
  commit('squash later');
  write('d.txt', 'd\nMAIN\n'); // …that main then edits over
  write('a.txt', 'one\nMAIN\nthree\n');
  const m = commit('main edit');
  const run: GitRun = (args, ms) => {
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: ms,
      env: cleanEnv(),
    });
    return { code: r.status, stdout: r.stdout };
  };
  const at = Date.now();
  const heads: Head[] = [
    { branch: 'hot', sha: hot, base, files: ['a.txt'], at },
    { branch: 'cool', sha: cool, base, files: ['b.txt'], at },
    { branch: 'done', sha: done, base, files: ['c.txt'], at },
    { branch: 'later', sha: later, base, files: ['d.txt'], at },
  ];
  const c = check(
    { heads, main: { sha: m, tree: g('rev-parse', `${m}^{tree}`) }, now: at },
    run,
    emptyCache(),
  );
  expect(c.conflicts).toEqual([{ a: 'hot', b: 'main', files: ['a.txt'] }]);
  expect(c.landed).toEqual(['done', 'later']);
  expect(c.clean).toEqual([['cool', 'hot']]);
  expect(c.pending).toBe(0);
}

// cli.ts overlap end to end: the worktrees it finds, the scratch object store (removed, and the shared one left as it
// was), the cache it writes, and an old scratch store a killed run left behind swept.
describe('cli.ts overlap against git', () => {
  it('writes the conflict and the cache, and adds nothing to the shared object store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conflicts-cli-'));
    const saved = { ...process.env };
    try {
      const env = {
        ...cleanEnv(),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      };
      const g = (cwd: string, ...a: string[]) =>
        execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...a], {
          encoding: 'utf8',
          env,
        }).trim();
      const repo = join(dir, 'repo');
      const board = join(dir, 'board');
      const scratch = join(dir, 'tmp');
      for (const d of [repo, board, scratch]) mkdirSync(d);
      const commit = (cwd: string, f: string, s: string) => {
        writeFileSync(join(cwd, f), s);
        g(cwd, 'add', '-A');
        g(cwd, 'commit', '-qm', f);
      };
      g(repo, 'init', '-q', '-b', 'trunk');
      commit(repo, 'a.txt', 'one\ntwo\n');
      g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      g(repo, 'worktree', 'add', '-q', '-b', 'hot', join(dir, 'hot'));
      commit(join(dir, 'hot'), 'a.txt', 'one\nHOT\n');
      commit(repo, 'a.txt', 'one\nMAIN\n');
      g(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      const killed = join(scratch, 'aperture-conflicts-old');
      mkdirSync(killed);
      utimesSync(killed, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
      const objects = () => g(repo, 'count-objects', '-v');
      const before = objects();

      // cli.ts's git reads process.env: no caller's GIT_DIR or GIT_INDEX_FILE may point it elsewhere
      for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
      process.env.TMPDIR = scratch;
      expect(cli(['overlap', repo, board], () => '')).toBe('0 overlapping pair(s), 1 conflict(s)');

      const o = JSON.parse(readFileSync(join(board, 'overlap.json'), 'utf8'));
      expect(o.conflicts).toEqual([{ a: 'hot', b: 'main', files: ['a.txt'] }]);
      const cache = JSON.parse(readFileSync(join(board, 'conflicts-cache.json'), 'utf8'));
      expect(Object.keys(cache.pairs)).toHaveLength(1);
      expect(objects()).toBe(before);
      expect(readdirSync(scratch)).toEqual([]); // this run's store removed, the killed run's swept
      expect(readdirSync(board).sort()).toEqual(['conflicts-cache.json', 'overlap.json']);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('treeOf', () => {
  it('counts every file uncommitted when git couldn’t read the working tree or the commits', () => {
    expect(treeOf('a', 'x.ts\n', 'y.ts\n', '')).toEqual({
      branch: 'a',
      files: ['x.ts', 'y.ts'],
      uncommitted: ['y.ts'],
    });
    for (const [c, d, u] of [
      ['x.ts\n', null, ''],
      ['x.ts\n', '', null],
      [null, 'y.ts\n', ''],
    ] as const) {
      const t = treeOf('a', c, d, u);
      expect(t.uncommitted).toEqual(t.files);
    }
  });
});
