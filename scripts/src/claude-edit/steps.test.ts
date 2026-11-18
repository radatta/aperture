// End to end on temp repos: a main checkout with a lane worktree at .claude/worktrees/<branch>, driven through the
// hardened runner exactly as the hub runs it. History is seeded with commit-tree; the hub's commit is `git commit`.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeExec, makeGit } from './git.ts';
import type { Git, GitExec, GitOpts, GitResult } from './git.ts';
import { Refusal, Stuck } from './rules.ts';
import {
  check,
  ledgerPath,
  patchId,
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
const writePatch = (n: number, body: string | Buffer) =>
  writeFileSync(join(wt, 'localNotes', `claude-edit-${n}.patch`), body);
const patchFile = (n: number) => join(wt, 'localNotes', `claude-edit-${n}.patch`);
const B = () => sh(wt, ['rev-parse', 'HEAD']);
const shownT = () => [...logs.join('\n').matchAll(/^T ([0-9a-f]{40})/gm)].at(-1)![1]!;
const stageIt = (base: string, tree: string, d = deps()) =>
  stage(d, { branch: BR, base, tree, message: MSG });
const commitHub = () => sh(wt, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', MSG]);
const staged = () => sh(wt, ['diff', '--cached', '--name-only']);
type R = { kind: string; branch: string; patchId?: string; file?: string };
const rows = (): R[] =>
  readFileSync(ledgerPath(deps()), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as R);
const checkIt = (n = 1, exec: string[] = [], d = deps()) => check(d, { branch: BR, n, exec });

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
  it('shows T, stages exactly T, the printed line commits it, records it and verifies the branch', () => {
    writePatch(1, EDIT());
    const base = B();
    expect(checkIt()).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(`B ${base}`);
    expect(out).not.toContain('+line TWO');
    expect(out).toMatch(/^file: <mac-repo>\/localNotes\/claude-edits\/lane-x-[0-9a-f]{8}\.md$/m);
    expect(readFileSync(showingPath(deps(), BR, shownT()), 'utf8')).toContain('\n+line TWO\n');
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
    expect(record(deps(), { branch: BR, base, tree })).toBe(0);
    expect(record(deps(), { branch: BR, base, tree })).toBe(0); // twice: still one applied row
    expect(rows().map((r) => r.kind)).toEqual(['shown', 'applied']);
    const head = sh(wt, ['rev-parse', 'HEAD']);
    sh(main, ['update-ref', `refs/remotes/origin/${BR}`, head]);
    logs = [];
    expect(verify(deps(), { branch: BR })).toBe(0);
    expect(logs.join('\n')).toContain(`--match-head-commit ${head}`);
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
    const hash = execFileSync('sha256sum', [f], { encoding: 'utf8' }).split(' ')[0];
    appendFileSync(
      ledgerPath(deps()),
      JSON.stringify({ t: '', kind: 'shown', branch: BR, n: 1, base, tree, file: hash }) + '\n',
    );
    expect(() => stageIt(base, tree)).toThrow(/not B\.\.T/);
    expect(staged()).toBe('');
  });
  it('refuses a missing one, and a message that breaks the commit rule', () => {
    const { base, tree, f } = shown();
    expect(() => stage(deps(), { branch: BR, base, tree, message: 'Bad' })).toThrow(/--message/);
    rmSync(f);
    expect(() => stageIt(base, tree)).toThrow(/no showing file/);
  });
});

describe('stage after the apply', () => {
  // The apply succeeds, then the next write-tree on the lane's index lies (or a lock makes it fail).
  function lying(reverse: 'ok' | 'fails') {
    let applied = false;
    return wrapped((args, o, real) => {
      if (
        args[0] === 'apply' &&
        args.includes('--index') &&
        args.includes('-R') &&
        reverse === 'fails'
      )
        return { status: 1, stdout: Buffer.alloc(0), stderr: 'no' };
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
  it('backs out a T it can not confirm and refuses; nothing stays staged', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    expect(() => stageIt(base, shownT(), deps({ git: lying('ok') }))).toThrow(/backed out/);
    expect(staged()).toBe('');
  });
  it('is stuck when the back-out fails too', () => {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    expect(() => stageIt(base, shownT(), deps({ git: lying('fails') }))).toThrow(Stuck);
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
  it('two paths that differ only in case', () => {
    writePatch(1, udiff('.claude/rules/R.md', null, 'x\n'));
    refuses(/differ only in case/);
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
  ])('hidden characters: %s', (_, c) => {
    writePatch(1, udiff('CLAUDE.md', CL0, CL0.replace('line two', `line${c} two`)));
    refuses(/hidden characters/);
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
  it('a patch file that is a symlink, a FIFO or over 1 MiB', () => {
    writeFileSync(join(wt, 'localNotes', 'real.patch'), EDIT());
    symlinkSync(join(wt, 'localNotes', 'real.patch'), patchFile(1));
    refuses(/not a regular file/);
    rmSync(patchFile(1));
    expect(spawnSync('mkfifo', [patchFile(1)]).status).toBe(0);
    refuses(/not a regular file/);
    rmSync(patchFile(1));
    writePatch(1, Buffer.alloc((1 << 20) + 1, 0x61));
    refuses(/over 1 MiB/);
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
  it('a worktree on another branch, a plain directory, a separate repo, a bad or deploy name', () => {
    writePatch(1, EDIT());
    sh(wt, ['switch', '-q', '-c', 'other']);
    refuses(/not on lane-x/);
    const d = deps();
    expect(() => check(d, { branch: 'nope', n: 1, exec: [] })).toThrow(/not a worktree/);
    mkdirSync(join(main, '.claude', 'worktrees', 'plain'));
    expect(() => check(d, { branch: 'plain', n: 1, exec: [] })).toThrow(/not a worktree/);
    const clone = tmp('ce-clone-');
    sh(clone, ['init', '-q', '-b', 'sep']);
    seed(clone, { 'x.md': 'x\n' });
    symlinkSync(clone, join(main, '.claude', 'worktrees', 'sep'));
    expect(() => check(d, { branch: 'sep', n: 1, exec: [] })).toThrow(/not a worktree of/);
    expect(() => check(d, { branch: '../x', n: 1, exec: [] })).toThrow(/bad branch/);
    expect(() => check(d, { branch: 'main', n: 1, exec: [] })).toThrow(/bad branch/);
  });
  it('a non-empty info/attributes', () => {
    writePatch(1, EDIT());
    mkdirSync(join(main, '.git', 'info'), { recursive: true });
    writeFileSync(join(main, '.git', 'info', 'attributes'), '* binary\n');
    refuses(/not empty/);
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
});

describe('stage and record refuse', () => {
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
    expect(() => stageIt(base, shownT())).toThrow(Refusal);
  });
  function stagedT() {
    writePatch(1, EDIT());
    const base = B();
    checkIt();
    const tree = shownT();
    stageIt(base, tree);
    return { branch: BR, base, tree };
  }
  it('record refuses before the commit, and is stuck on a commit that is not exactly T on B', () => {
    const a = stagedT();
    expect(() => record(deps(), a)).toThrow(/still B/);
    writeFileSync(join(wt, 'docs/d.md'), 'extra\n');
    sh(wt, ['add', 'docs/d.md']);
    commitHub();
    expect(() => record(deps(), a)).toThrow(Stuck);
  });
  it('record is stuck on T committed twice over (the right tree, the wrong parent)', () => {
    const a = stagedT();
    commitHub();
    sh(wt, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', MSG]);
    expect(() => record(deps(), a)).toThrow(/parents/);
  });
  it('record is stuck when the branch moved off, or the patch-id fails, after the commit', () => {
    const a = stagedT();
    commitHub();
    const noId = wrapped((args) =>
      args[0] === 'patch-id' ? { status: 1, stdout: Buffer.alloc(0), stderr: 'x' } : undefined,
    );
    expect(() => record(deps({ git: noId }), a)).toThrow(/not recorded/);
    sh(wt, ['switch', '-q', '-c', 'elsewhere']);
    expect(() => record(deps(), a)).toThrow(Stuck);
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
  function applied(patch = EDIT()) {
    writePatch(1, patch);
    const base = B();
    checkIt();
    const tree = shownT();
    stageIt(base, tree);
    commitHub();
    record(deps(), { branch: BR, base, tree });
    return sh(wt, ['rev-parse', 'HEAD']);
  }
  const push = () =>
    sh(main, ['update-ref', `refs/remotes/origin/${BR}`, sh(wt, ['rev-parse', 'HEAD'])]);
  const amendTo = (body: string) => {
    writeFileSync(join(wt, 'CLAUDE.md'), body);
    sh(wt, ['add', 'CLAUDE.md']);
    sh(wt, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', MSG]);
    push();
  };

  it('fails on a lane commit to .claude/ with no approved patch', () => {
    applied();
    seed(wt, { '.claude/rules/r.md': 'sneaky\n' }, sh(wt, ['rev-parse', 'HEAD']));
    push();
    expect(() => verify(deps(), { branch: BR })).toThrow(/no approved patch/);
  });
  it("fails on a case-variant path, and on another branch's approval of the same patch", () => {
    const c = seed(wt, { '.CLAUDE/x.md': 'x\n' }, sh(wt, ['rev-parse', 'HEAD']));
    push();
    expect(() => verify(deps(), { branch: BR })).toThrow(/no approved patch/);
    const id = patchId(deps(), wt, `${c}^`, c);
    appendFileSync(
      ledgerPath(deps()),
      JSON.stringify({
        t: '',
        kind: 'applied',
        branch: 'other',
        n: 1,
        base: 'x',
        tree: 'y',
        commit: c,
        patchId: id,
      }) + '\n',
    );
    expect(() => verify(deps(), { branch: BR })).toThrow(/no approved patch/);
  });
  it('refuses a bad branch name and a branch not fetched', () => {
    expect(() => verify(deps(), { branch: 'feature/x' })).toThrow(/bad branch/);
    expect(() => verify(deps(), { branch: BR })).toThrow(/fetch first/);
  });
  it('an indentation-only amend changes the patch-id', () => {
    applied();
    amendTo(CL0.replace('line two', '  line TWO'));
    expect(() => verify(deps(), { branch: BR })).toThrow(/no approved patch/);
  });
  it('the approved line moved to another place changes the patch-id', () => {
    applied(udiff('CLAUDE.md', CL0, CL0.replace('a\n', 'a\nALLOW X\n')));
    amendTo(CL0.replace('line three\n', 'line three\nALLOW X\n'));
    expect(() => verify(deps(), { branch: BR })).toThrow(/no approved patch/);
  });
  it('a clean rebase over a change outside the hunk context keeps the patch-id', () => {
    const hub = applied();
    const root = sh(main, ['rev-parse', 'refs/remotes/origin/main']);
    const newMain = seed(main, { 'CLAUDE.md': CL0.replace('# Rules', '# RULES') }, root);
    sh(main, ['update-ref', 'refs/remotes/origin/main', newMain]);
    sh(wt, ['switch', '-q', '--detach', newMain]);
    sh(wt, ['cherry-pick', hub]);
    sh(wt, ['branch', '-f', BR, 'HEAD']);
    sh(wt, ['switch', '-q', BR]);
    push();
    expect(verify(deps(), { branch: BR })).toBe(0);
  });
  it('refuses merge commits', () => {
    const hub = applied();
    const side = seed(
      wt,
      { 'docs/d.md': 'side\n' },
      sh(main, ['rev-parse', 'refs/remotes/origin/main']),
    );
    const m = sh(wt, ['commit-tree', `${hub}^{tree}`, '-p', hub, '-p', side, '-m', 'merge']);
    sh(main, ['update-ref', `refs/remotes/origin/${BR}`, m]);
    expect(() => verify(deps(), { branch: BR })).toThrow(/merge commits/);
  });
});
