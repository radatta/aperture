// End to end on temp repos: a main checkout with a lane worktree at .claude/worktrees/<branch>, driven through the
// hardened runner exactly as the hub runs it. History is seeded with commit-tree; the hub's commit is `git commit`.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIFF_FLAGS, GIT_PRE, makeExec, makeGit } from './git.ts';
import type { Git, GitExec, GitOpts, GitResult } from './git.ts';
import { Refusal, Stuck, renderFile } from './rules.ts';
import {
  check,
  close,
  ledgerPath,
  readSmall,
  record,
  showingPath,
  stage,
  unstage,
  verify,
} from './steps.ts';
import type { Deps } from './steps.ts';

const ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const sh = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, env: ENV, input, encoding: 'utf8' }).trim();
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// A plain `diff -u` patch, as the lane's recipe writes it (exit 1 = a difference).
function udiff(path: string, before: string | null, after: string | null): string {
  const dir = tmp('ce-diff-');
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  if (before !== null) writeFileSync(a, before);
  if (after !== null) writeFileSync(b, after);
  const r = spawnSync('diff', [
    '-u',
    '--label',
    before === null ? '/dev/null' : `a/${path}`,
    '--label',
    after === null ? '/dev/null' : `b/${path}`,
    before === null ? '/dev/null' : a,
    after === null ? '/dev/null' : b,
  ]);
  if (r.status !== 1) throw new Error(`diff exit ${r.status}`);
  return r.stdout.toString();
}

const BR = 'lane-x';
const MSG = 'applied rule edit for lane';
// Ten lines, so a change on line 1 sits outside the context of a hunk at line 9.
const CL0 = '# Rules\n\na\nb\nc\nd\ne\nline one\nline two\nline three\n';
let main: string;
let wt: string;
let logs: string[];

function seed(cwd: string, files: Record<string, string>, parent?: string) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(cwd, p, '..'), { recursive: true });
    writeFileSync(join(cwd, p), body);
  }
  sh(cwd, ['add', '-A']);
  if (files['.claude/hooks/g.sh'] !== undefined)
    sh(cwd, ['update-index', '--chmod=+x', '.claude/hooks/g.sh']);
  const c = sh(cwd, [
    'commit-tree',
    sh(cwd, ['write-tree']),
    '-m',
    'seed',
    ...(parent ? ['-p', parent] : []),
  ]);
  sh(cwd, ['update-ref', 'HEAD', c]);
  return c;
}

function deps(over: Partial<Deps> = {}): Deps {
  return {
    git: makeGit(),
    main,
    fromMain: true,
    macRoot: '<mac-repo>',
    now: () => new Date(0),
    log: (s) => logs.push(s),
    ...over,
  };
}
// A hardened git with one seam: `hook` answers a call itself, or returns undefined to pass it through.
const wrapped = (
  hook: (args: string[], o: GitOpts, real: GitExec) => GitResult | undefined,
): Git => {
  const real = makeExec();
  return makeGit((args, o) => hook(args, o, real) ?? real(args, o));
};
// The hardened git with some pins dropped: the control that shows a pin matters.
const without = (...kvs: string[]): Git => {
  const pre = GIT_PRE.filter(
    (x, i, xs) => !kvs.includes(x) && !(x === '-c' && kvs.includes(xs[i + 1]!)),
  );
  expect(pre.length).toBeLessThan(GIT_PRE.length);
  return makeGit(makeExec(process.env, pre));
};
const writePatch = (n: number, body: string | Buffer) =>
  writeFileSync(join(wt, 'localNotes', `claude-edit-${n}.patch`), body);
const patchFile = (n: number) => join(wt, 'localNotes', `claude-edit-${n}.patch`);
const B = () => sh(wt, ['rev-parse', 'HEAD']);
const shownT = () => [...logs.join('\n').matchAll(/^T ([0-9a-f]{40})/gm)].at(-1)![1]!;
const stageIt = (base: string, tree: string, d = deps()) =>
  stage(d, { branch: BR, base, tree, message: MSG });
const commitHub = () => sh(wt, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', MSG]);
const staged = () => sh(wt, ['diff', '--cached', '--name-only']);
type R = { kind: string; branch: string; commit?: string; file?: string };
const rows = (): R[] =>
  readFileSync(ledgerPath(deps()), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as R);
const checkIt = (n = 1, exec: string[] = [], d = deps()) => check(d, { branch: BR, n, exec });
// Rewrites `commit`'s first parent in main's commit-graph file to none (GRAPH_PARENT_NONE). Format: an 8-byte
// header (byte 6 the chunk count), a table of 12-byte chunk entries (id, 8-byte offset), OIDL (sorted 20-byte ids)
// and CDAT (per commit: tree 20, parent1 4, parent2 4, generation and time 8).
function forgeNoParent(repo: string, commit: string) {
  const f = join(repo, '.git', 'objects', 'info', 'commit-graph');
  const buf = readFileSync(f);
  const chunks = new Map<string, number>();
  for (let i = 0; i < buf[6]!; i++) {
    const at = 8 + i * 12;
    chunks.set(buf.subarray(at, at + 4).toString('latin1'), Number(buf.readBigUInt64BE(at + 4)));
  }
  const oidl = chunks.get('OIDL')!;
  const cdat = chunks.get('CDAT')!;
  const n = (cdat - oidl) / 20;
  const pos = [...Array(n).keys()].find(
    (i) => buf.subarray(oidl + i * 20, oidl + i * 20 + 20).toString('hex') === commit,
  );
  expect(pos).toBeDefined();
  buf.writeUInt32BE(0x70000000, cdat + pos! * 36 + 20);
  chmodSync(f, 0o644);
  writeFileSync(f, buf);
}

// B's tree with docs/d.md changed, built in a scratch index.
function docsTree(base: string, body = 'EVIL\n'): string {
  const idx = join(tmp('ce-idx-'), 'index');
  const g = (args: string[], input?: string) =>
    execFileSync('git', args, {
      cwd: wt,
      env: { ...ENV, GIT_INDEX_FILE: idx },
      input,
      encoding: 'utf8',
    }).trim();
  g(['read-tree', base]);
  g([
    'update-index',
    '--cacheinfo',
    `100644,${g(['hash-object', '-w', '--stdin'], body)},docs/d.md`,
  ]);
  return g(['write-tree']);
}
const forgeShown = (base: string, tree: string, file?: string) =>
  appendFileSync(
    ledgerPath(deps()),
    JSON.stringify({ t: '', kind: 'shown', branch: BR, n: 1, base, tree, file }) + '\n',
  );

beforeEach(() => {
  logs = [];
  main = tmp('ce-main-');
  sh(main, ['init', '-q', '-b', 'main']);
  const root = seed(main, {
    '.gitignore': 'localNotes/\n.claude/worktrees/\n',
    'CLAUDE.md': CL0,
    '.claude/rules/r.md': 'rule a\nrule b\n',
    '.claude/hooks/g.sh': '#!/bin/bash\nexit 0\n',
    'docs/d.md': 'doc\n',
  });
  sh(main, ['update-ref', 'refs/remotes/origin/main', root]);
  mkdirSync(join(main, 'localNotes'));
  wt = join(main, '.claude', 'worktrees', BR);
  sh(main, ['worktree', 'add', '-q', '-b', BR, wt, root]);
  mkdirSync(join(wt, 'localNotes'));
});

const EDIT = () => udiff('CLAUDE.md', CL0, CL0.replace('line two', 'line TWO'));

describe('check → stage → commit → record → verify', () => {
  it('shows T, stages exactly T, the printed line commits it, records and pins it, and verifies the branch', () => {
    writePatch(1, EDIT());
    const base = B();
    expect(checkIt()).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(`B ${base}`);
    expect(out).not.toContain('+line TWO');
    expect(out).toMatch(/^file: <mac-repo>\/localNotes\/claude-edits\/lane-x-[0-9a-f]{8}\.md$/m);
    const f = showingPath(deps(), BR, shownT());
    expect(readFileSync(f, 'utf8')).toContain('\n+line TWO\n');
    expect(rows()[0]!.file).toBe(sha256(readFileSync(f, 'utf8')));
    expect(out).toContain('go names: the branch or');
    expect(out).toContain('files: M CLAUDE.md (+1 -1)');
    const tree = shownT();
    logs = [];
    expect(stageIt(base, tree)).toBe(0);
    expect(sh(wt, ['write-tree'])).toBe(tree);
    const printed = logs.join('\n').split('\n');
    expect(printed[1]).toBe(`cd '${wt}'`);
    expect(printed).toContain(
      `pnpm -C '${main}' claude-edit record ${BR} --base ${base} --tree ${tree}`,
    );
    expect(printed).toContain(
      `pnpm -C '${main}' claude-edit unstage ${BR} --base ${base} --tree ${tree}`,
    );
    const line = printed[2]!;
    expect(line).toContain(`[ "$(git symbolic-ref --short HEAD)" = '${BR}' ]`);
    expect(line).toContain(`[ "$(git rev-parse HEAD)" = ${base} ]`);
    // Run where the hub forgot the cd: every check fails, nothing is committed.
    expect(spawnSync('bash', ['-c', line], { cwd: main, env: ENV }).status).not.toBe(0);
    expect(spawnSync('bash', ['-c', line], { cwd: wt, env: ENV }).status).toBe(0);
    expect(sh(wt, ['rev-parse', 'HEAD^{tree}'])).toBe(tree);
    expect(sh(wt, ['log', '-1', '--format=%s'])).toBe(MSG);
    const head = sh(wt, ['rev-parse', 'HEAD']);
    logs = [];
    expect(record(deps(), { branch: BR, base, tree })).toBe(0);
    expect(logs.join('\n')).toContain(`pinned refs/claude-edits/${BR}/${head}`);
    expect(record(deps(), { branch: BR, base, tree })).toBe(0); // twice: still one applied row, one ref
    expect(rows().map((r) => r.kind)).toEqual(['shown', 'applied']);
    expect(
      sh(main, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/claude-edits']),
    ).toBe(`${head} refs/claude-edits/${BR}/${head}`);
    sh(main, ['update-ref', `refs/remotes/origin/${BR}`, head]);
    logs = [];
    expect(verify(deps(), { branch: BR })).toBe(0);
    const v = logs.join('\n');
    expect(v).toContain(
      `${head.slice(0, 8)} claude-edit-1, approved T ${tree.slice(0, 8)} (1970-01-01), as committed: M CLAUDE.md`,
    );
    expect(v).toContain(
      `--match-head-commit ${head}; changes agent rules: CLAUDE.md, approved ${tree.slice(0, 8)} (1970-01-01)`,
    );
  });

  it('the printed commit line refuses an extra add, a moved HEAD and a lookalike clone; repo hooks never run', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    logs = [];
    stageIt(base, tree);
    const line = logs.join('\n').split('\n')[2]!;
    const run = (cwd: string) => spawnSync('bash', ['-c', line], { cwd, env: ENV }).status;
    // Something staged after stage: the index is not T.
    writeFileSync(join(wt, 'docs/d.md'), 'extra\n');
    sh(wt, ['add', 'docs/d.md']);
    expect(run(wt)).not.toBe(0);
    expect(B()).toBe(base);
    sh(wt, ['reset', '-q', '--', 'docs/d.md']);
    sh(wt, ['checkout', '--', 'docs/d.md']);
    // HEAD moved to another commit of the same tree.
    const twin = sh(wt, ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'twin']);
    sh(wt, ['update-ref', 'HEAD', twin]);
    expect(run(wt)).not.toBe(0);
    expect(B()).toBe(twin);
    sh(wt, ['update-ref', 'HEAD', base]);
    // A clone with the same branch, HEAD and index is not the lane's worktree.
    const clone = tmp('ce-clone-');
    sh(clone, ['clone', '-q', '--shared', main, '.']);
    sh(clone, ['switch', '-q', '-c', BR, base]);
    sh(clone, ['read-tree', tree]);
    expect(sh(clone, ['write-tree'])).toBe(tree);
    expect(run(clone)).not.toBe(0);
    expect(sh(clone, ['rev-parse', 'HEAD'])).toBe(base);
    // A failing repo pre-commit hook: the line commits anyway.
    const hook = join(main, '.git', 'hooks', 'pre-commit');
    mkdirSync(join(hook, '..'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    // The control: a plain commit of the staged T is stopped by that hook.
    expect(spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: wt, env: ENV }).status).not.toBe(0);
    expect(B()).toBe(base);
    expect(run(wt)).toBe(0);
    expect(sh(wt, ['rev-parse', 'HEAD^{tree}'])).toBe(tree);
  });

  it('a second tree on the branch asks for T8 only, a re-showing of the first one too; a re-check adds no row', () => {
    writePatch(1, EDIT());
    checkIt();
    checkIt();
    expect(rows()).toHaveLength(1);
    writePatch(2, udiff('CLAUDE.md', CL0, CL0.replace('line two', 'line 2')));
    logs = [];
    checkIt(2);
    expect(logs.join('\n')).toMatch(/showing 2 on this branch/);
    expect(logs.join('\n')).toMatch(/go names: `[0-9a-f]{8}`$/m);
    logs = [];
    checkIt(1);
    expect(logs.join('\n')).toMatch(/showing 1 on this branch/);
    expect(logs.join('\n')).toMatch(/go names: `[0-9a-f]{8}`$/m);
  });

  it('a patch rewritten after the showing changes nothing: stage applies the objects shown', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    writePatch(1, udiff('.claude/rules/r.md', 'rule a\nrule b\n', 'rule a\nrule EVIL\n'));
    stageIt(base, tree);
    expect(sh(wt, ['write-tree'])).toBe(tree);
    expect(readFileSync(join(wt, '.claude/rules/r.md'), 'utf8')).toBe('rule a\nrule b\n');
  });

  it('a new executable named with --exec arrives 100755, on disk too', () => {
    writePatch(1, udiff('.claude/hooks/n.sh', null, '#!/bin/bash\necho hi\n'));
    const base = B();
    expect(() => checkIt()).not.toThrow();
    logs = [];
    checkIt(1, ['.claude/hooks/n.sh']);
    expect(logs.join('\n')).toContain('guard new (executable): .claude/hooks/n.sh');
    const tree = shownT();
    stageIt(base, tree);
    expect(statSync(join(wt, '.claude/hooks/n.sh')).mode & 0o111).not.toBe(0);
  });

  it('unstage backs a never-committed T out to B; stage works again after it', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    stageIt(base, tree);
    expect(unstage(deps(), { branch: BR, base, tree })).toBe(0);
    expect(staged()).toBe('');
    expect(readFileSync(join(wt, 'CLAUDE.md'), 'utf8')).toBe(CL0);
    expect(() => unstage(deps(), { branch: BR, base, tree })).toThrow(/not T/);
    expect(stageIt(base, tree)).toBe(0);
  });
});

describe('the showing file stage takes', () => {
  function shown() {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    return { base, tree, f: showingPath(deps(), BR, tree) };
  }
  it('refuses one edited inside the fence; nothing is staged', () => {
    const { base, tree, f } = shown();
    writeFileSync(f, readFileSync(f, 'utf8').replace('+line TWO', '+line too'));
    expect(() => stageIt(base, tree)).toThrow(/changed since check/);
    expect(staged()).toBe('');
  });
  it('refuses one whose real fence is commented out under a lookalike', () => {
    const { base, tree, f } = shown();
    const md = readFileSync(f, 'utf8');
    writeFileSync(f, `~~~diff\n+harmless\n~~~\n<!--\n${md}\n-->\n`);
    expect(() => stageIt(base, tree)).toThrow(/changed since check/);
  });
  it('refuses lines after the hunk that apply to the same T, even with a forged ledger row', () => {
    const { base, tree, f } = shown();
    const md = readFileSync(f, 'utf8').replace('+line TWO\n', '+line TWO\n-ALLOW EVERYTHING\n');
    writeFileSync(f, md);
    forgeShown(base, tree, sha256(md));
    expect(() => stageIt(base, tree)).toThrow(/not B\.\.T/);
    expect(staged()).toBe('');
  });
  it('refuses a missing one, a symlinked one, and a message that breaks the commit rule', () => {
    const { base, tree, f } = shown();
    expect(() => stage(deps(), { branch: BR, base, tree, message: 'Bad' })).toThrow(/--message/);
    const copy = join(tmp('ce-copy-'), 'x.md');
    writeFileSync(copy, readFileSync(f));
    rmSync(f);
    expect(() => stageIt(base, tree)).toThrow(/no showing file/);
    symlinkSync(copy, f);
    expect(() => stageIt(base, tree)).toThrow(/not a regular file/);
  });
  it('re-judges B..T itself: a consistent forged row and file for a tree outside the paths refuses', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const bad = docsTree(base);
    const text = makeGit()
      .raw(['diff-tree', '-p', '-r', ...DIFF_FLAGS, '-U3', base, bad, '--'], { cwd: wt })
      .toString('utf8');
    const md = renderFile({
      branch: BR,
      n: 1,
      showing: 2,
      trees: 2,
      base,
      tree: bad,
      files: [],
      flags: [],
      untracked: [],
      text,
    });
    writeFileSync(showingPath(deps(), BR, bad), md);
    forgeShown(base, bad, sha256(md));
    expect(() => stageIt(base, bad)).toThrow(/outside CLAUDE.md/);
    expect(staged()).toBe('');
  });
  it('refuses a forged row for T = B: the patch changes nothing', () => {
    const base = B();
    forgeShown(base, sh(wt, ['rev-parse', `${base}^{tree}`]));
    expect(() => stageIt(base, sh(wt, ['rev-parse', `${base}^{tree}`]))).toThrow(/changes nothing/);
  });
});

describe('stage after the apply', () => {
  // The apply succeeds, then the next write-tree on the lane's index lies (or a lock makes it fail).
  function lying(reverse: 'ok' | 'fails' | 'noop') {
    let applied = false;
    return wrapped((args, o, real) => {
      const rev = args[0] === 'apply' && args.includes('--index') && args.includes('-R');
      if (rev && reverse === 'fails') return { status: 1, stdout: Buffer.alloc(0), stderr: 'no' };
      if (rev && reverse === 'noop') return { status: 0, stdout: Buffer.alloc(0), stderr: '' };
      if (args[0] === 'apply' && args.includes('--index') && !args.includes('-R')) {
        applied = true;
        return real(args, o);
      }
      if (args[0] === 'write-tree' && applied && !o.index) {
        applied = false;
        return { status: 128, stdout: Buffer.alloc(0), stderr: 'index.lock exists' };
      }
      return undefined;
    });
  }
  const shown = () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    return { base, tree: shownT() };
  };
  it('backs out a T it can not confirm and refuses; nothing stays staged', () => {
    const { base, tree } = shown();
    expect(() => stageIt(base, tree, deps({ git: lying('ok') }))).toThrow(/backed out/);
    expect(staged()).toBe('');
    expect(readFileSync(join(wt, 'CLAUDE.md'), 'utf8')).toBe(CL0);
  });
  it('is stuck when the back-out fails, or reports success but leaves T', () => {
    const { base, tree } = shown();
    expect(() => stageIt(base, tree, deps({ git: lying('fails') }))).toThrow(Stuck);
    sh(wt, ['read-tree', base]);
    sh(wt, ['checkout', '--', 'CLAUDE.md']);
    expect(() => stageIt(base, tree, deps({ git: lying('noop') }))).toThrow(Stuck);
  });
  // The apply itself fails: `side` is what it left behind.
  const failing = (side?: () => void) =>
    wrapped((args) => {
      if (args[0] !== 'apply' || !args.includes('--index') || args.includes('-R')) return undefined;
      side?.();
      return { status: 1, stdout: Buffer.alloc(0), stderr: 'boom' };
    });
  it('refuses with git’s words when the apply fails and changed nothing', () => {
    const { base, tree } = shown();
    expect(() => stageIt(base, tree, deps({ git: failing() }))).toThrow(
      /\(boom\): nothing changed/,
    );
  });
  it('is stuck when a failed apply left a file changed or a new file under .claude/', () => {
    const { base, tree } = shown();
    const dirty = () => writeFileSync(join(wt, 'CLAUDE.md'), 'half\n');
    expect(() => stageIt(base, tree, deps({ git: failing(dirty) }))).toThrow(/left files changed/);
    sh(wt, ['checkout', '--', 'CLAUDE.md']);
    const dropped = () => writeFileSync(join(wt, '.claude', 'left.md'), 'x\n');
    expect(() => stageIt(base, tree, deps({ git: failing(dropped) }))).toThrow(
      /left files changed/,
    );
    rmSync(join(wt, '.claude', 'left.md'));
    mkdirSync(join(wt, '.claude', 'worktrees'), { recursive: true });
    const ignored = () => writeFileSync(join(wt, '.claude', 'worktrees', 'new'), 'x\n');
    expect(() => stageIt(base, tree, deps({ git: failing(ignored) }))).toThrow(Stuck);
  });
  it('is stuck, not refused, when git can not run after a failed apply changed files', () => {
    const { base, tree } = shown();
    let tried = false;
    const git = wrapped((args, o, real) => {
      if (args[0] === 'apply' && args.includes('--index') && !args.includes('-R')) {
        tried = true;
        writeFileSync(join(wt, 'CLAUDE.md'), 'half\n');
        return { status: 1, stdout: Buffer.alloc(0), stderr: 'boom' };
      }
      if (tried && args[0] === 'write-tree') throw new Refusal('git write-tree: spawnSync EAGAIN');
      return real(args, o);
    });
    expect(() => stageIt(base, tree, deps({ git }))).toThrow(/could not read .* index/);
  });
  it('counts untracked and ignored files already there as unchanged', () => {
    const { base, tree } = shown();
    writeFileSync(join(wt, '.claude', 'mine.md'), 'x\n');
    mkdirSync(join(wt, '.claude', 'worktrees'), { recursive: true });
    writeFileSync(join(wt, '.claude', 'worktrees', 'old'), 'x\n');
    expect(() => stageIt(base, tree, deps({ git: failing() }))).toThrow(/nothing changed/);
  });
});

describe('check refuses', () => {
  const refuses = (re: RegExp) => expect(() => checkIt()).toThrow(re);

  it('a path outside the agent rules, and a case variant of one inside', () => {
    writePatch(1, udiff('docs/d.md', 'doc\n', 'DOC\n'));
    refuses(/outside CLAUDE.md/);
    writePatch(1, udiff('claude.md', null, 'x\n'));
    refuses(/outside CLAUDE.md/);
  });
  it('upper case in a directory under .claude/, and a .gitattributes', () => {
    writePatch(1, udiff('.claude/Agents/x.md', null, 'x\n'));
    refuses(/upper case in a directory name/);
    writePatch(1, udiff('.claude/.gitattributes', null, '* -diff\n'));
    refuses(/gitattributes/);
  });
  it('two paths that differ only in case, in the patch or already in B', () => {
    writePatch(1, udiff('.claude/rules/R.md', null, 'x\n'));
    refuses(/differ only in case/);
    seed(wt, { '.Claude/a.md': 'x\n', '.claude/a.md': 'y\n' }, B());
    writePatch(1, EDIT());
    refuses(/\.Claude\/a\.md and \.claude\/a\.md differ only in case/);
  });
  it('an exec bit dropped on a guard', () => {
    writePatch(
      1,
      'diff --git a/.claude/hooks/g.sh b/.claude/hooks/g.sh\nold mode 100755\nnew mode 100644\n',
    );
    refuses(/mode 100755 → 100644/);
  });
  it('a symlink', () => {
    writePatch(
      1,
      'diff --git a/.claude/l b/.claude/l\nnew file mode 120000\n--- /dev/null\n+++ b/.claude/l\n@@ -0,0 +1 @@\n+../docs/d.md\n\\ No newline at end of file\n',
    );
    refuses(/120000/);
  });
  it('a binary file', () => {
    writeFileSync(join(wt, '.claude/b.bin'), Buffer.from([0, 1, 2, 0, 255]));
    sh(wt, ['add', '.claude/b.bin']);
    const patch = sh(wt, ['diff', '--cached', '--binary']) + '\n';
    sh(wt, ['rm', '-q', '--cached', '.claude/b.bin']);
    rmSync(join(wt, '.claude/b.bin'));
    writePatch(1, patch);
    refuses(/binary/);
  });
  it.each([
    ['zero-width space', '​'],
    ['variation selector', '️'],
  ])('hidden characters on an added line: %s', (_, c) => {
    writePatch(1, udiff('CLAUDE.md', CL0, CL0.replace('line two', `line${c} two`)));
    refuses(/hidden characters on added lines/);
  });
  it('a diff that is not UTF-8', () => {
    writePatch(
      1,
      Buffer.from(
        udiff('.claude/rules/r.md', 'rule a\nrule b\n', 'rule a\nrule X\n').replace(
          'rule X',
          'rule ÿ',
        ),
        'latin1',
      ),
    );
    refuses(/UTF-8/);
  });
  it('a CLAUDE.md of 200 lines, with or without a final newline; deleting a long one is fine', () => {
    writePatch(1, udiff('CLAUDE.md', CL0, CL0 + 'x\n'.repeat(190)));
    refuses(/200 lines/);
    writePatch(1, udiff('CLAUDE.md', CL0, CL0 + 'x\n'.repeat(189) + 'x'));
    refuses(/200 lines/);
    const long = CL0 + 'x\n'.repeat(200);
    seed(wt, { 'CLAUDE.md': long }, B());
    writePatch(1, udiff('CLAUDE.md', long, null));
    expect(checkIt()).toBe(0);
  });
  it('a patch file that is a symlink or over 1 MiB; exactly 1 MiB is fine', () => {
    writeFileSync(join(wt, 'localNotes', 'real.patch'), EDIT());
    symlinkSync(join(wt, 'localNotes', 'real.patch'), patchFile(1));
    refuses(/not a regular file/);
    rmSync(patchFile(1));
    writePatch(1, Buffer.alloc((1 << 20) + 1, 0x61));
    refuses(/over 1048576 bytes/);
    const edit = EDIT();
    writePatch(1, 'x'.repeat((1 << 20) - edit.length - 1) + '\n' + edit);
    expect(statSync(patchFile(1)).size).toBe(1 << 20);
    expect(checkIt()).toBe(0);
  });
  it('a ledger that is not a regular file', () => {
    writePatch(1, EDIT());
    mkdirSync(ledgerPath(deps()));
    refuses(/not a regular file/);
  });
  it('an untracked name the showing could not print; a safe one, any case, is listed', () => {
    writePatch(1, EDIT());
    mkdirSync(join(wt, '.CLAUDE'), { recursive: true });
    writeFileSync(join(wt, '.CLAUDE', 'u.md'), 'x\n');
    checkIt();
    expect(logs.join('\n')).toContain('untracked under .claude/: .CLAUDE/u.md');
    writeFileSync(join(wt, '.claude', 'x\n````diff\n<!--'), '');
    refuses(/untracked names/);
  });
  it('staged work in the worktree, and unstaged changes under .claude/', () => {
    writePatch(1, EDIT());
    writeFileSync(join(wt, 'docs/d.md'), 'staged\n');
    sh(wt, ['add', 'docs/d.md']);
    refuses(/staged changes/);
    sh(wt, ['reset', '-q']);
    sh(wt, ['checkout', '--', 'docs/d.md']);
    writeFileSync(join(wt, '.claude/rules/r.md'), 'dirty\n');
    refuses(/unstaged changes/);
  });
  it('a worktree on another branch, a plain directory, a separate repo', () => {
    writePatch(1, EDIT());
    sh(wt, ['switch', '-q', '-c', 'other']);
    refuses(/not on lane-x/);
    const d = deps();
    expect(() => check(d, { branch: 'nope', n: 1, exec: [] })).toThrow(/not its own worktree/);
    mkdirSync(join(main, '.claude', 'worktrees', 'plain'));
    expect(() => check(d, { branch: 'plain', n: 1, exec: [] })).toThrow(/not its own worktree/);
    const clone = tmp('ce-clone-');
    sh(clone, ['init', '-q', '-b', 'sep']);
    seed(clone, { 'x.md': 'x\n' });
    symlinkSync(clone, join(main, '.claude', 'worktrees', 'sep'));
    expect(() => check(d, { branch: 'sep', n: 1, exec: [] })).toThrow(/not a worktree of/);
  });
  it.each(['../x', 'main', 'dev', 'master', 'HEAD', 'feature/x', '-x', '..', '.hidden', '_x'])(
    'the branch name %s',
    (b) => expect(() => check(deps(), { branch: b, n: 1, exec: [] })).toThrow(/bad branch/),
  );
  it('a non-empty or symlinked info/attributes; a whitespace-only one is fine', () => {
    writePatch(1, EDIT());
    const at = join(main, '.git', 'info', 'attributes');
    mkdirSync(join(at, '..'), { recursive: true });
    writeFileSync(at, ' \n\t\n');
    expect(checkIt()).toBe(0);
    writeFileSync(at, '* binary\n');
    refuses(/not empty/);
    rmSync(at);
    const elsewhere = join(tmp('ce-at-'), 'a');
    writeFileSync(elsewhere, '');
    symlinkSync(elsewhere, at);
    refuses(/not a regular file/);
  });
  it('a showing whose text git did not derive from the objects (the round trip)', () => {
    writePatch(1, EDIT());
    const git = wrapped((args, o, real) => {
      if (args[0] !== 'diff-tree' || !args.includes('-p')) return undefined;
      const r = real(args, o);
      return { ...r, stdout: Buffer.from(r.stdout.toString().replace('+line TWO', '+line TOO')) };
    });
    expect(() => checkIt(1, [], deps({ git }))).toThrow(/round trip/);
  });
});

describe('check tells', () => {
  it('hidden characters already in B, on a context or a removed line, as a flag', () => {
    const nb = CL0.replace('line one', 'line one');
    seed(wt, { 'CLAUDE.md': nb }, B());
    writePatch(1, udiff('CLAUDE.md', nb, nb.replace('line two', 'line TWO')));
    checkIt();
    expect(logs.join('\n')).toMatch(
      /^flags: hidden characters on lines this patch does not add: line \d+: U\+00A0$/m,
    );
    writePatch(1, udiff('CLAUDE.md', nb, nb.replace('line one', 'line one')));
    logs = [];
    checkIt();
    expect(logs.join('\n')).toMatch(/does not add: line \d+: U\+00A0/);
    writePatch(1, udiff('CLAUDE.md', nb, nb.replace('line two', 'line TWO')));
    expect(() => checkIt()).toThrow(/hidden characters on added lines/);
  });
  it('an added HTML comment opener, and never writes one outside the fence', () => {
    writePatch(1, udiff('CLAUDE.md', CL0, CL0.replace('line two', 'line two <!-- hidden')));
    checkIt();
    expect(logs.join('\n')).toContain('flags: an HTML comment opener on an added line');
    const md = readFileSync(showingPath(deps(), BR, shownT()), 'utf8');
    const fenced = md.slice(md.indexOf('```diff'), md.lastIndexOf('```') + 3);
    expect(md.replace(fenced, '')).not.toContain('<!--');
    const c = CL0.replace('line one', 'line one <!-- old');
    seed(wt, { 'CLAUDE.md': c }, B());
    writePatch(1, udiff('CLAUDE.md', c, c.replace('line two', 'line TWO')));
    logs = [];
    checkIt();
    writePatch(1, udiff('CLAUDE.md', c, c.replace('line one <!-- old', 'line one')));
    checkIt();
    expect(logs.join('\n')).not.toContain('HTML comment');
  });
  it('the showing file replaces a link planted at its name, never writing through it', () => {
    writePatch(1, EDIT());
    checkIt();
    const f = showingPath(deps(), BR, shownT());
    const target = join(tmp('ce-target-'), 't');
    writeFileSync(target, 'keep\n');
    rmSync(f);
    symlinkSync(target, f);
    checkIt();
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
    expect(lstatSync(f).isSymbolicLink()).toBe(false);
  });
  it('cleans its scratch indexes', () => {
    writePatch(1, EDIT());
    const scratch = tmp('ce-scratch-');
    const was = process.env.TMPDIR;
    process.env.TMPDIR = scratch;
    try {
      checkIt();
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
    }
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe('readSmall', () => {
  it('reads up to max bytes, refuses one more, and is null for a missing file', () => {
    const d = tmp('ce-small-');
    writeFileSync(join(d, 'ten'), 'x'.repeat(10));
    writeFileSync(join(d, 'eleven'), 'x'.repeat(11));
    expect(readSmall(join(d, 'ten'), 10)?.length).toBe(10);
    expect(() => readSmall(join(d, 'eleven'), 10)).toThrow(/over 10 bytes/);
    expect(readSmall(join(d, 'none'), 10)).toBeNull();
    expect(() => readSmall(d, 10)).toThrow(/not a regular file/);
  });
  it('refuses a FIFO without blocking (in a child with a timeout, so a regression hangs only it)', () => {
    const d = tmp('ce-fifo-');
    const fifo = join(d, 'f');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const script = join(d, 'read.mjs');
    const steps = fileURLToPath(new URL('./steps.ts', import.meta.url));
    writeFileSync(
      script,
      `import { readSmall } from ${JSON.stringify(steps)};\ntry { readSmall(process.argv[2], 10); process.exit(0); } catch (e) { process.stderr.write(String(e.message)); process.exit(1); }\n`,
    );
    const r = spawnSync(process.execPath, [script, fifo], { timeout: 10_000, encoding: 'utf8' });
    expect(r.signal).toBeNull();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a regular file/);
  });
});

describe('hostile config', () => {
  it("can't change the showing: repo diff.external and textconv, attributes files, inherited GIT_* env", () => {
    writePatch(1, EDIT());
    checkIt();
    const clean = logs.join('\n');
    const f = showingPath(deps(), BR, shownT());
    const before = readFileSync(f, 'utf8');
    const fake = join(main, 'fake.sh');
    writeFileSync(fake, '#!/bin/sh\necho FAKE DIFF\n');
    chmodSync(fake, 0o755);
    const attrs = join(main, 'attrs');
    writeFileSync(attrs, '* diff=fake\n');
    sh(main, ['config', 'diff.external', fake]);
    sh(main, ['config', 'diff.fake.textconv', fake]);
    sh(main, ['config', 'core.attributesFile', attrs]);
    sh(main, ['config', 'diff.noprefix', 'true']);
    sh(main, ['config', 'apply.whitespace', 'fix']);
    sh(main, ['config', 'merge.default', 'union']);
    writeFileSync(join(wt, '.gitattributes'), '* diff=fake binary\n');
    const home = tmp('ce-home-');
    writeFileSync(join(home, '.gitconfig'), `[diff]\n\texternal = ${fake}\n`);
    const env = {
      ...process.env,
      HOME: home,
      GIT_EXTERNAL_DIFF: fake,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'diff.external',
      GIT_CONFIG_VALUE_0: fake,
    };
    // The positive control: under that config and env a plain porcelain diff is the fake.
    writeFileSync(join(wt, 'CLAUDE.md'), CL0.replace('line two', 'line TWO'));
    const plain = spawnSync('git', ['diff', '--', 'CLAUDE.md'], { cwd: wt, env }).stdout.toString();
    sh(wt, ['checkout', '--', 'CLAUDE.md']);
    expect(plain).toContain('FAKE DIFF');
    logs = [];
    checkIt(1, [], deps({ git: makeGit(makeExec(env)) }));
    expect(logs.join('\n')).toBe(clean);
    expect(readFileSync(f, 'utf8')).toBe(before);
  });
  it('--attr-source and core.attributesFile each keep a -diff attribute out of the showing', () => {
    writePatch(1, EDIT());
    writeFileSync(join(wt, '.gitattributes'), '* -diff\n');
    expect(checkIt()).toBe(0);
    expect(() => checkIt(1, [], deps({ git: without(GIT_PRE[0]!) }))).toThrow(/binary/);
    rmSync(join(wt, '.gitattributes'));
    const attrs = join(main, 'attrs');
    writeFileSync(attrs, '* -diff\n');
    sh(main, ['config', 'core.attributesFile', attrs]);
    expect(checkIt()).toBe(0);
    expect(() => checkIt(1, [], deps({ git: without('core.attributesFile=/dev/null') }))).toThrow(
      /binary/,
    );
  });
  it('apply.whitespace keeps a trailing space the patch adds', () => {
    writePatch(1, udiff('CLAUDE.md', CL0, CL0.replace('line two', 'line TWO ')));
    sh(main, ['config', 'apply.whitespace', 'fix']);
    checkIt();
    const pinned = shownT();
    expect(sh(main, ['cat-file', 'blob', `${pinned}:CLAUDE.md`])).toContain('line TWO \n');
    logs = [];
    checkIt(1, [], deps({ git: without('apply.whitespace=nowarn') }));
    expect(shownT()).not.toBe(pinned);
  });
  it('core.hooksPath keeps a repo hook out of record', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    stageIt(base, tree);
    commitHub();
    const pin = `refs/claude-edits/${BR}/${B()}`;
    const marker = join(main, 'hooked');
    const hook = join(main, '.git', 'hooks', 'reference-transaction');
    mkdirSync(join(hook, '..'), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    record(deps({ git: without('core.hooksPath=/dev/null') }), { branch: BR, base, tree });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    sh(main, ['-c', 'core.hooksPath=/dev/null', 'update-ref', '-d', pin]);
    record(deps(), { branch: BR, base, tree });
    expect(existsSync(marker)).toBe(false);
    expect(sh(main, ['rev-parse', pin])).toBe(B());
  });
});

describe('stage, unstage and record refuse', () => {
  it('a B and T never shown, and a moved HEAD', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    expect(() => stageIt(base, 'b'.repeat(40))).toThrow(/never shown/);
    seed(wt, { 'docs/d.md': 'moved\n' }, base);
    expect(() => stageIt(base, tree)).toThrow(/it moved/);
  });
  it('staged work added after the showing', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    writeFileSync(join(wt, 'docs/d.md'), 'later\n');
    sh(wt, ['add', 'docs/d.md']);
    expect(() => stageIt(base, shownT())).toThrow(/staged changes/);
  });
  function stagedT() {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    stageIt(base, tree);
    return { branch: BR, base, tree };
  }
  it('unstage takes full shas, and refuses once the commit is made', () => {
    const a = stagedT();
    expect(() => unstage(deps(), { ...a, base: a.base.slice(0, 8) })).toThrow(/full shas/);
    commitHub();
    expect(() => unstage(deps(), a)).toThrow(/HEAD is not B/);
  });
  it('record refuses before the commit, and is stuck on a commit that is not exactly T on B', () => {
    const a = stagedT();
    expect(() => record(deps(), a)).toThrow(/still B/);
    writeFileSync(join(wt, 'docs/d.md'), 'extra\n');
    sh(wt, ['add', 'docs/d.md']);
    commitHub();
    expect(() => record(deps(), a)).toThrow(Stuck);
  });
  it('record is stuck on T committed twice over, or as a two-parent commit', () => {
    const a = stagedT();
    commitHub();
    sh(wt, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', MSG]);
    expect(() => record(deps(), a)).toThrow(/parents/);
    const side = sh(wt, ['commit-tree', `${a.base}^{tree}`, '-m', 'side']);
    sh(wt, [
      'update-ref',
      'HEAD',
      sh(wt, ['commit-tree', a.tree, '-p', a.base, '-p', side, '-m', MSG]),
    ]);
    expect(() => record(deps(), a)).toThrow(Stuck);
    expect(() => record(deps(), a)).toThrow(/parents/);
  });
  it('record refuses a commit of a tree never shown', () => {
    writePatch(1, EDIT());
    checkIt();
    const base = B();
    seed(wt, { '.claude/rules/r.md': 'by hand\n' }, base);
    const tree = sh(wt, ['rev-parse', 'HEAD^{tree}']);
    expect(() => record(deps(), { branch: BR, base, tree })).toThrow(/never shown/);
  });
  it('record is stuck when the branch moved off, or the pin fails, after the commit', () => {
    const a = stagedT();
    commitHub();
    const noRef = wrapped((args) =>
      args[0] === 'update-ref' ? { status: 1, stdout: Buffer.alloc(0), stderr: 'x' } : undefined,
    );
    expect(() => record(deps({ git: noRef }), a)).toThrow(Stuck);
    expect(() => record(deps({ git: noRef }), a)).toThrow(/not recorded/);
    const quiet = wrapped((args) =>
      args[0] === 'update-ref' ? { status: 0, stdout: Buffer.alloc(0), stderr: '' } : undefined,
    );
    expect(() => record(deps({ git: quiet }), a)).toThrow(/does not point at/);
    writeFileSync(join(main, '.git', 'info', 'attributes'), '* -diff\n');
    expect(() => record(deps(), a)).toThrow(Stuck);
    rmSync(join(main, '.git', 'info', 'attributes'));
    sh(wt, ['switch', '-q', '-c', 'elsewhere']);
    expect(() => record(deps(), a)).toThrow(Stuck);
  });
  it('record names the showing of its own tree when two were shown', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    writePatch(2, udiff('CLAUDE.md', CL0, CL0.replace('line two', 'line 2')));
    checkIt(2);
    stageIt(base, tree);
    commitHub();
    logs = [];
    record(deps(), { branch: BR, base, tree });
    expect(logs.join('\n')).toMatch(/^recorded lane-x claude-edit-1: /);
  });
  it('from a lane copy: check is a PRE-CHECK with no row, the rest refuse', () => {
    writePatch(1, EDIT());
    const lane = deps({ fromMain: false });
    checkIt(1, [], lane);
    expect(logs[0]).toMatch(/^PRE-CHECK/);
    expect(() => readFileSync(ledgerPath(lane))).toThrow();
    const a = { branch: BR, base: B(), tree: 'c'.repeat(40) };
    expect(() => stage(lane, { ...a, message: MSG })).toThrow(/main checkout/);
    expect(() => unstage(lane, a)).toThrow(/main checkout/);
    expect(() => record(lane, a)).toThrow(/main checkout/);
    expect(() => verify(lane, { branch: BR })).toThrow(/main checkout/);
  });
});

describe('verify', () => {
  function applied(patch = EDIT(), n = 1) {
    writePatch(n, patch);
    const base = B();
    checkIt(n);
    const tree = shownT();
    stageIt(base, tree);
    commitHub();
    record(deps(), { branch: BR, base, tree });
    return sh(wt, ['rev-parse', 'HEAD']);
  }
  const push = () =>
    sh(main, ['update-ref', `refs/remotes/origin/${BR}`, sh(wt, ['rev-parse', 'HEAD'])]);
  const ok = () => verify(deps(), { branch: BR });
  const red = () => expect(ok).toThrow(/not an approved commit or a clean replay/);
  const amendTo = (body: string) => {
    writeFileSync(join(wt, 'CLAUDE.md'), body);
    sh(wt, ['add', 'CLAUDE.md']);
    sh(wt, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', MSG]);
    push();
  };
  const originMain = () => sh(main, ['rev-parse', 'refs/remotes/origin/main']);
  // A new main commit on origin/main.
  const newMain = (files: Record<string, string>) => {
    const m = seed(main, files, originMain());
    sh(main, ['update-ref', 'refs/remotes/origin/main', m]);
    return m;
  };
  const moveLane = (sha: string) => {
    sh(wt, ['switch', '-q', '--detach', sha]);
    sh(wt, ['branch', '-f', BR, sha]);
    sh(wt, ['switch', '-q', BR]);
    push();
  };
  // The lane's rebase: the hub's commit cherry-picked onto `onto`.
  const rebase = (hub: string, onto: string) => {
    sh(wt, ['switch', '-q', '--detach', onto]);
    sh(wt, ['cherry-pick', hub]);
    const c = sh(wt, ['rev-parse', 'HEAD']);
    moveLane(c);
    return c;
  };
  const nearHunk = () => newMain({ 'CLAUDE.md': CL0.replace('\ne\n', '\nE\n') }); // 2 lines from line two

  it('passes a clean rebase whose main change sits inside the hunk context', () => {
    const hub = applied();
    const tree = sh(wt, ['rev-parse', `${hub}^{tree}`]);
    const m = nearHunk();
    const c = rebase(hub, m);
    logs = [];
    expect(ok()).toBe(0);
    const v = logs.join('\n');
    expect(v).toContain(
      `${c.slice(0, 8)} claude-edit-1, approved T ${tree.slice(0, 8)} (1970-01-01), replayed onto ${m.slice(0, 8)}: M CLAUDE.md`,
    );
    expect(v).toContain(
      `--match-head-commit ${c}; changes agent rules: CLAUDE.md, approved ${tree.slice(0, 8)} (1970-01-01)`,
    );
  });
  it('fails on a lane commit to .claude/ with no approval, listing its files', () => {
    applied();
    seed(wt, { '.claude/rules/r.md': 'sneaky\n' }, B());
    push();
    expect(ok).toThrow(/\(M \.claude\/rules\/r\.md\): send n\+1/);
  });
  it("fails on a case-variant path, and on another branch's approval of the same commit", () => {
    const c = seed(wt, { '.CLAUDE/x.md': 'x\n' }, B());
    push();
    red();
    appendFileSync(
      ledgerPath(deps()),
      [
        {
          kind: 'shown',
          branch: 'other',
          n: 1,
          base: `${'1'.repeat(40)}`,
          tree: `${'2'.repeat(40)}`,
        },
        {
          kind: 'applied',
          branch: 'other',
          n: 1,
          base: `${'1'.repeat(40)}`,
          tree: `${'2'.repeat(40)}`,
          commit: c,
        },
      ]
        .map((r) => JSON.stringify({ t: '', ...r }) + '\n')
        .join(''),
    );
    red();
  });
  it('refuses a bad branch name, a branch not fetched, a non-empty info/grafts', () => {
    expect(() => verify(deps(), { branch: 'feature/x' })).toThrow(/bad branch/);
    expect(ok).toThrow(/fetch first/);
    push();
    writeFileSync(join(main, '.git', 'info', 'grafts'), `${B()}\n`);
    expect(ok).toThrow(/grafts is not empty/);
  });
  it('fails on an indentation-only amend', () => {
    applied();
    amendTo(CL0.replace('line two', '  line TWO'));
    red();
  });
  it('fails on the approved line moved to another place', () => {
    applied(udiff('CLAUDE.md', CL0, CL0.replace('a\n', 'a\nALLOW X\n')));
    amendTo(CL0.replace('line three\n', 'line three\nALLOW X\n'));
    red();
  });
  it('fails on the same edit moved to an identical-looking block', () => {
    const blk = 'p\nq\nr\nTARGET\ns\nt\nu\n';
    const two = `# R\n${blk}mid\n${blk}`;
    moveLane(newMain({ 'CLAUDE.md': two }));
    applied(udiff('CLAUDE.md', two, `# R\n${blk.replace('TARGET', 'TARGET ALLOW')}mid\n${blk}`));
    amendTo(`# R\n${blk}mid\n${blk.replace('TARGET', 'TARGET ALLOW')}`);
    red();
  });
  it('fails on a hand-merged conflict', () => {
    applied();
    const m = newMain({ 'CLAUDE.md': CL0.replace('line two', 'line 2') });
    seed(wt, { 'CLAUDE.md': CL0.replace('line two', 'line TWO') }, m);
    push();
    red();
  });
  it('fails on other files mixed into the hub commit, naming both', () => {
    applied();
    writeFileSync(join(wt, 'docs/d.md'), 'mixed\n');
    sh(wt, ['add', 'docs/d.md']);
    amendTo(CL0.replace('line two', 'line TWO'));
    expect(ok).toThrow(/\(M CLAUDE\.md; M docs\/d\.md\)/);
  });
  it('one approval covers one commit: an approved revert then the edit again fails', () => {
    const hub = applied();
    applied(udiff('CLAUDE.md', CL0.replace('line two', 'line TWO'), CL0), 2);
    push();
    expect(ok()).toBe(0);
    sh(wt, ['cherry-pick', hub]);
    push();
    red();
  });
  it('says which approvals it dropped: missing, or not exactly one commit of T on B', () => {
    const hub = applied();
    push();
    const r0 = rows().find((r) => r.kind === 'shown') as unknown as { base: string; tree: string };
    const { base, tree } = r0;
    const side = sh(wt, ['commit-tree', `${base}^{tree}`, '-m', 'side']);
    const other = sh(wt, ['commit-tree', `${docsTree(base)}`, '-p', base, '-m', 'other tree']);
    const forged = {
      missing: 'f'.repeat(40),
      noParent: sh(wt, ['commit-tree', tree, '-m', 'no parent']),
      otherParent: sh(wt, ['commit-tree', tree, '-p', side, '-m', 'other parent']),
      twoParents: sh(wt, ['commit-tree', tree, '-p', base, '-p', side, '-m', 'two parents']),
      otherTree: other,
    };
    appendFileSync(
      ledgerPath(deps()),
      Object.values(forged)
        .map(
          (commit) =>
            JSON.stringify({ t: '', kind: 'applied', branch: BR, n: 9, base, tree, commit }) + '\n',
        )
        .join(''),
    );
    logs = [];
    // Newer than the approval on the branch: each one is red.
    expect(ok).toThrow(
      /ffffffff .* is not on the branch, and no later approval is: re-send the change as n\+1/,
    );
    const v = logs.join('\n');
    expect(v).toContain(
      'approved commit ffffffff (claude-edit-9, T ' + tree.slice(0, 8) + ', undated) is missing',
    );
    for (const c of [forged.noParent, forged.otherParent, forged.twoParents, forged.otherTree])
      expect(v).toContain(
        `approved commit ${c.slice(0, 8)} (claude-edit-9, T ${tree.slice(0, 8)}, undated) is not T on B`,
      );
    expect(v).toContain(`${hub.slice(0, 8)} claude-edit-1`);
    // A later approval on the branch: the dropped ones are told once, not red.
    applied(udiff('CLAUDE.md', CL0.replace('line two', 'line TWO'), CL0), 2);
    push();
    logs = [];
    expect(ok()).toBe(0);
    expect(logs.join('\n')).toContain('ffffffff (claude-edit-9, T');
    expect(logs.join('\n')).not.toMatch(/ffffffff .* is not on the branch/);
  });
  it('the pin keeps the approved commit through gc; without it the rebased commit fails', () => {
    const hub = applied();
    rebase(hub, nearHunk());
    const gc = () => {
      sh(main, ['reflog', 'expire', '--expire=now', '--all']);
      sh(main, ['gc', '-q', '--prune=now']);
    };
    gc();
    expect(ok()).toBe(0);
    sh(main, [
      '-c',
      'core.hooksPath=/dev/null',
      'update-ref',
      '-d',
      `refs/claude-edits/${BR}/${hub}`,
    ]);
    gc();
    expect(
      spawnSync('git', ['cat-file', '-e', `${hub}^{commit}`], { cwd: main, env: ENV }).status,
    ).not.toBe(0);
    logs = [];
    red();
    expect(logs.join('\n')).toContain('is missing');
  });
  it('a replace ref can not hide an unapproved commit', () => {
    const hub = applied();
    const x = seed(wt, { '.claude/rules/r.md': 'sneaky\n' }, hub);
    push();
    sh(main, [
      'replace',
      x,
      sh(main, ['commit-tree', `${hub}^{tree}`, '-p', hub, '-m', 'innocent']),
    ]);
    // The control: under the replace ref a plain rev-list doesn't see the commit.
    expect(sh(main, ['rev-list', `${originMain()}..${x}`, '--', '.claude'])).toBe('');
    expect(ok).toThrow(new RegExp(`${x} is not an approved commit`));
  });
  it('merge.default=union can not turn a conflict into a clean replay', () => {
    const hub = applied();
    const base = sh(wt, ['rev-parse', `${hub}^`]);
    const m = newMain({ 'CLAUDE.md': CL0.replace('line two', 'line 2') });
    // The control: git's union merge of the conflict is clean, and that is the lane's commit.
    const u = sh(main, [
      '-c',
      'merge.default=union',
      'merge-tree',
      '--write-tree',
      `--merge-base=${base}`,
      m,
      hub,
    ]);
    moveLane(sh(wt, ['commit-tree', u.split('\n')[0]!, '-p', m, '-m', MSG]));
    sh(main, ['config', 'merge.default', 'union']);
    red();
    expect(verify(deps({ git: without('merge.default=text') }), { branch: BR })).toBe(0);
  });
  it('a rename on main does not carry the edit to the new name', () => {
    const hub = applied(udiff('.claude/rules/r.md', 'rule a\nrule b\n', 'rule a\nrule B\n'));
    const base = sh(wt, ['rev-parse', `${hub}^`]);
    sh(main, ['mv', '.claude/rules/r.md', '.claude/rules/s.md']);
    const m = newMain({});
    const c = rebase(hub, m);
    expect(readFileSync(join(wt, '.claude/rules/s.md'), 'utf8')).toBe('rule a\nrule B\n');
    // The control: git's default merge (renames on) gives exactly the lane's commit.
    const plain = sh(main, ['merge-tree', '--write-tree', `--merge-base=${base}`, m, hub]).split(
      '\n',
    )[0];
    expect(plain).toBe(sh(main, ['rev-parse', `${c}^{tree}`]));
    red();
  });
  it('a merge-tree that prints junk is no match; one that errors refuses', () => {
    const hub = applied();
    rebase(hub, nearHunk());
    const mt = (status: number, out: string) =>
      deps({
        git: wrapped((args) =>
          args[0] === 'merge-tree'
            ? { status, stdout: Buffer.from(out), stderr: 'bad' }
            : undefined,
        ),
      });
    expect(() => verify(mt(0, 'garbage\n'), { branch: BR })).toThrow(/not an approved commit/);
    expect(() => verify(mt(2, ''), { branch: BR })).toThrow(/merge-tree failed: bad/);
  });
  it('counts a commit to the root .gitattributes, any case, and never approves it', () => {
    applied();
    seed(wt, { '.gitattributes': '.claude/** text eol=crlf\n' }, B());
    push();
    expect(ok).toThrow(
      /changes the root \.gitattributes, which sets how the agent files check out \(A \.gitattributes\)/,
    );
    seed(wt, { '.GitAttributes': '* -text\n' }, B());
    push();
    expect(ok).toThrow(/A \.GitAttributes/);
  });
  it('an approval missing from the branch: red when it is the newest, told when a later one is on it', () => {
    const root = B();
    const hub = applied();
    moveLane(root); // the lane dropped the hub's commit
    logs = [];
    expect(ok).toThrow(
      new RegExp(
        `approved commit ${hub.slice(0, 8)} \\(claude-edit-1, T [0-9a-f]{8}, 1970-01-01\\) is not on the branch, and no later approval is`,
      ),
    );
    applied(udiff('CLAUDE.md', CL0, CL0.replace('line one', 'line ONE')), 2);
    push();
    logs = [];
    expect(ok()).toBe(0);
    expect(logs.join('\n')).toContain(`approved commit ${hub.slice(0, 8)} (claude-edit-1`);
    expect(logs.join('\n')).toMatch(/is not on the branch: a later approval is/);
  });
  it('close: approvals stop counting, pins go, and a branch name used again starts with nothing shown', () => {
    const hub = applied();
    push();
    expect(ok()).toBe(0);
    logs = [];
    expect(close(deps(), { branch: BR })).toBe(0);
    const t8 = sh(main, ['rev-parse', `${hub}^{tree}`]).slice(0, 8);
    expect(logs.join('\n')).toBe(
      `  retired claude-edit-1, T ${t8}, commit ${hub.slice(0, 8)} (1970-01-01)\nclosed ${BR}: its approvals no longer count; 1 pin(s) deleted`,
    );
    expect(sh(main, ['for-each-ref', `refs/claude-edits/${BR}/`])).toBe('');
    red();
    expect(close(deps(), { branch: BR })).toBe(0); // twice: nothing left to delete
    writePatch(
      3,
      udiff('CLAUDE.md', CL0.replace('line two', 'line TWO'), CL0.replace('line two', 'line 2')),
    );
    logs = [];
    checkIt(3);
    expect(logs.join('\n')).toMatch(/showing 1 on this branch/);
    expect(logs.join('\n')).toContain('go names: the branch or');
    expect(() => close(deps({ fromMain: false }), { branch: BR })).toThrow(/main checkout/);
    expect(() => close(deps(), { branch: 'a/b' })).toThrow(/bad branch/);
  });
  it('close: a torn last ledger line is Stuck with the pins kept; a link at the ledger refuses', () => {
    const hub = applied();
    const at = ledgerPath(deps());
    writeFileSync(at, readFileSync(at, 'utf8') + '{"torn":');
    expect(() => close(deps(), { branch: BR })).toThrow(Stuck);
    expect(sh(main, ['for-each-ref', `refs/claude-edits/${BR}/`])).toContain(hub);
    const target = join(tmp('ce-ledger-'), 'l');
    writeFileSync(target, '');
    rmSync(at);
    symlinkSync(target, at);
    expect(() => close(deps(), { branch: BR })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('');
  });
  it('refuses a configured merge driver, a shallow repo', () => {
    applied();
    push();
    sh(main, ['config', 'merge.text.driver', 'true']);
    expect(ok).toThrow(/a merge driver is configured: merge\.text\.driver true/);
    sh(main, ['config', '--unset', 'merge.text.driver']);
    expect(ok()).toBe(0);
    writeFileSync(join(main, '.git', 'shallow'), `${originMain()}\n`);
    expect(ok).toThrow(/shallow clone/);
  });
  it('a commit-graph that says other parents changes nothing', () => {
    const hub = applied();
    const c = rebase(hub, nearHunk());
    sh(main, ['commit-graph', 'write', '--reachable']);
    forgeNoParent(main, c);
    // The control: with the graph read, git sees no parent for the rebased commit and verify goes red.
    expect(sh(main, ['rev-list', '--parents', '-n', '1', c])).toBe(c);
    expect(() => verify(deps({ git: without('core.commitGraph=false') }), { branch: BR })).toThrow(
      /not an approved commit/,
    );
    expect(ok()).toBe(0);
  });
  it('one approval covers one commit through a rebase too', () => {
    const hub = applied();
    applied(udiff('CLAUDE.md', CL0.replace('line two', 'line TWO'), CL0), 2);
    sh(wt, ['cherry-pick', hub]);
    const top = B();
    sh(wt, ['switch', '-q', '--detach', nearHunk()]);
    sh(wt, ['cherry-pick', `${sh(main, ['rev-parse', `${hub}^`])}..${top}`]);
    moveLane(B());
    red();
  });
  it('a root commit in range is listed, not a crash; names the showing could not print are quoted; the head is whole', () => {
    const lone = sh(wt, ['commit-tree', sh(wt, ['rev-parse', `${B()}^{tree}`]), '-m', 'orphan']);
    moveLane(lone);
    logs = [];
    expect(ok).toThrow(
      /is not an approved commit or a clean replay of one \(A \.claude\/hooks\/g\.sh; .*A CLAUDE\.md/,
    );
    expect(logs.join('\n')).toContain(`head ${lone},`);
    moveLane(seed(wt, { '.claude/a b.md': 'x\n' }, originMain()));
    expect(ok).toThrow(/A "\.claude\/a b\.md"/);
  });
  it('refuses merge commits', () => {
    const hub = applied();
    const side = seed(wt, { 'docs/d.md': 'side\n' }, originMain());
    const m = sh(wt, ['commit-tree', `${hub}^{tree}`, '-p', hub, '-p', side, '-m', 'merge']);
    sh(main, ['update-ref', `refs/remotes/origin/${BR}`, m]);
    expect(ok).toThrow(/merge commits/);
  });
});
