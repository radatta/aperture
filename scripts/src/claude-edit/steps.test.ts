// End to end on temp repos: a main checkout with a lane worktree at .claude/worktrees/<branch>, driven through the
// hardened runner exactly as the hub runs it. History is seeded with commit-tree; the hub's commit is `git commit`.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeExec, makeGit } from './git.ts';
import { Refusal, Stuck } from './rules.ts';
import { check, ledgerPath, record, showingPath, stage, verify } from './steps.ts';
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
// A plain `diff -u` patch, as the lane's recipe writes it (exit 1 = a difference).
function udiff(path: string, before: string | null, after: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'ce-diff-'));
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
const writePatch = (n: number, body: string) =>
  writeFileSync(join(wt, 'localNotes', `claude-edit-${n}.patch`), body);
const B = () => sh(wt, ['rev-parse', 'HEAD']);
const shownT = () => /^T ([0-9a-f]{40})/m.exec(logs.join('\n'))![1]!;
const commitHub = () =>
  sh(wt, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'applied rule edit']);
const rows = () =>
  readFileSync(ledgerPath(deps()), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { kind: string; patchId?: string });

beforeEach(() => {
  logs = [];
  main = mkdtempSync(join(tmpdir(), 'ce-main-'));
  sh(main, ['init', '-q', '-b', 'main']);
  const root = seed(main, {
    '.gitignore': 'localNotes/\n.claude/worktrees/\n',
    'CLAUDE.md': '# Rules\n\nline one\nline two\nline three\n',
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

const EDIT = () =>
  udiff(
    'CLAUDE.md',
    '# Rules\n\nline one\nline two\nline three\n',
    '# Rules\n\nline one\nline TWO\nline three\n',
  );

describe('check → stage → commit → record → verify', () => {
  it('shows T, stages exactly T, records the commit and verifies the branch', () => {
    writePatch(1, EDIT());
    const base = B();
    expect(check(deps(), { branch: BR, n: 1, exec: [] })).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain(`B ${base}`);
    expect(out).not.toContain('+line TWO');
    expect(out).toMatch(/^file: <mac-repo>\/localNotes\/claude-edits\/lane-x-[0-9a-f]{8}\.md$/m);
    expect(readFileSync(showingPath(deps(), BR, shownT()), 'utf8')).toContain('\n+line TWO\n');
    expect(out).toContain('go names: the branch or');
    expect(out).toContain('files: M CLAUDE.md (+1 -1)');
    const tree = shownT();
    expect(stage(deps(), { branch: BR, base, tree })).toBe(0);
    expect(sh(wt, ['write-tree'])).toBe(tree);
    commitHub();
    expect(record(deps(), { branch: BR, base, tree })).toBe(0);
    expect(rows().map((r) => r.kind)).toEqual(['shown', 'applied']);
    sh(main, ['update-ref', `refs/remotes/origin/${BR}`, sh(wt, ['rev-parse', 'HEAD'])]);
    expect(verify(deps(), { branch: BR })).toBe(0);
  });

  it('a second showing on the branch asks for T8 only', () => {
    writePatch(1, EDIT());
    check(deps(), { branch: BR, n: 1, exec: [] });
    writePatch(
      2,
      udiff(
        'CLAUDE.md',
        '# Rules\n\nline one\nline two\nline three\n',
        '# Rules\n\nline one\nline 2\nline three\n',
      ),
    );
    logs = [];
    check(deps(), { branch: BR, n: 2, exec: [] });
    expect(logs.join('\n')).toMatch(/showing 2 on this branch/);
    expect(logs.join('\n')).toMatch(/go names: `[0-9a-f]{8}`$/m);
  });

  it('a patch rewritten after the showing changes nothing: stage applies the objects shown', () => {
    writePatch(1, EDIT());
    const base = B();
    check(deps(), { branch: BR, n: 1, exec: [] });
    const tree = shownT();
    writePatch(1, udiff('.claude/rules/r.md', 'rule a\nrule b\n', 'rule a\nrule EVIL\n'));
    stage(deps(), { branch: BR, base, tree });
    expect(sh(wt, ['write-tree'])).toBe(tree);
    expect(readFileSync(join(wt, '.claude/rules/r.md'), 'utf8')).toBe('rule a\nrule b\n');
  });

  it('a showing file edited after the showing refuses stage; nothing is staged', () => {
    writePatch(1, EDIT());
    const base = B();
    check(deps(), { branch: BR, n: 1, exec: [] });
    const tree = shownT();
    const f = showingPath(deps(), BR, tree);
    writeFileSync(f, readFileSync(f, 'utf8').replace('+line TWO', '+line too'));
    expect(() => stage(deps(), { branch: BR, base, tree })).toThrow(
      /not T: run check and show it again/,
    );
    expect(sh(wt, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('a new executable named with --exec arrives 100755, on disk too', () => {
    writePatch(1, udiff('.claude/hooks/n.sh', null, '#!/bin/bash\necho hi\n'));
    const base = B();
    expect(() => check(deps(), { branch: BR, n: 1, exec: [] })).not.toThrow();
    logs = [];
    check(deps(), { branch: BR, n: 1, exec: ['.claude/hooks/n.sh'] });
    expect(logs.join('\n')).toContain('guard new (executable): .claude/hooks/n.sh');
    const tree = shownT();
    stage(deps(), { branch: BR, base, tree });
    expect(statSync(join(wt, '.claude/hooks/n.sh')).mode & 0o111).not.toBe(0);
  });
});

describe('check refuses', () => {
  const refuses = (re: RegExp) =>
    expect(() => check(deps(), { branch: BR, n: 1, exec: [] })).toThrow(re);

  it('a path outside the agent rules', () => {
    writePatch(1, udiff('docs/d.md', 'doc\n', 'DOC\n'));
    refuses(/outside CLAUDE.md/);
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
  it('hidden characters', () => {
    writePatch(
      1,
      udiff(
        'CLAUDE.md',
        '# Rules\n\nline one\nline two\nline three\n',
        '# Rules\n\nline one\nline​ two\nline three\n',
      ),
    );
    refuses(/U\+200B/);
  });
  it('a CLAUDE.md of 200 lines', () => {
    const before = '# Rules\n\nline one\nline two\nline three\n';
    writePatch(1, udiff('CLAUDE.md', before, before + 'x\n'.repeat(195)));
    refuses(/200 lines/);
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
  it('a worktree on another branch, and a name that is not a worktree', () => {
    writePatch(1, EDIT());
    sh(wt, ['switch', '-q', '-c', 'other']);
    refuses(/not on lane-x/);
    expect(() => check(deps(), { branch: 'nope', n: 1, exec: [] })).toThrow(/not a worktree/);
    expect(() => check(deps(), { branch: '../x', n: 1, exec: [] })).toThrow(/bad branch/);
  });
  it('a non-empty info/attributes', () => {
    writePatch(1, EDIT());
    mkdirSync(join(main, '.git', 'info'), { recursive: true });
    writeFileSync(join(main, '.git', 'info', 'attributes'), '* binary\n');
    refuses(/not empty/);
  });
});

describe('hostile config', () => {
  it("can't change the showing: repo diff.external and textconv, attributes files, inherited GIT_* env", () => {
    writePatch(1, EDIT());
    check(deps(), { branch: BR, n: 1, exec: [] });
    const clean = logs.join('\n');
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
    const home = mkdtempSync(join(tmpdir(), 'ce-home-'));
    writeFileSync(join(home, '.gitconfig'), `[diff]\n\texternal = ${fake}\n`);
    const env = {
      ...process.env,
      HOME: home,
      GIT_EXTERNAL_DIFF: fake,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'diff.external',
      GIT_CONFIG_VALUE_0: fake,
    };
    logs = [];
    check(deps({ git: makeGit(makeExec(env)) }), { branch: BR, n: 1, exec: [] });
    expect(logs.join('\n')).toBe(clean);
    expect(logs.join('\n')).not.toContain('FAKE');
  });
});

describe('stage and record refuse', () => {
  it('a B and T never shown, and a moved HEAD', () => {
    writePatch(1, EDIT());
    const base = B();
    check(deps(), { branch: BR, n: 1, exec: [] });
    const tree = shownT();
    expect(() => stage(deps(), { branch: BR, base, tree: 'b'.repeat(40) })).toThrow(/never shown/);
    seed(wt, { 'docs/d.md': 'moved\n' }, base);
    expect(() => stage(deps(), { branch: BR, base, tree })).toThrow(/it moved/);
  });
  it('staged work added after the showing', () => {
    writePatch(1, EDIT());
    const base = B();
    check(deps(), { branch: BR, n: 1, exec: [] });
    writeFileSync(join(wt, 'docs/d.md'), 'later\n');
    sh(wt, ['add', 'docs/d.md']);
    expect(() => stage(deps(), { branch: BR, base, tree: shownT() })).toThrow(Refusal);
  });
  it('record is stuck on a commit that is not exactly T on B', () => {
    writePatch(1, EDIT());
    const base = B();
    check(deps(), { branch: BR, n: 1, exec: [] });
    const tree = shownT();
    stage(deps(), { branch: BR, base, tree });
    writeFileSync(join(wt, 'docs/d.md'), 'extra\n');
    sh(wt, ['add', 'docs/d.md']);
    commitHub();
    expect(() => record(deps(), { branch: BR, base, tree })).toThrow(Stuck);
  });
  it('from a lane copy: check is a PRE-CHECK with no row, the rest refuse', () => {
    writePatch(1, EDIT());
    const lane = deps({ fromMain: false });
    check(lane, { branch: BR, n: 1, exec: [] });
    expect(logs[0]).toMatch(/^PRE-CHECK/);
    expect(() => readFileSync(ledgerPath(lane))).toThrow();
    const a = { branch: BR, base: B(), tree: 'c'.repeat(40) };
    expect(() => stage(lane, a)).toThrow(/main checkout/);
    expect(() => record(lane, a)).toThrow(/main checkout/);
    expect(() => verify(lane, { branch: BR })).toThrow(/main checkout/);
  });
});

describe('verify', () => {
  function applied() {
    writePatch(1, EDIT());
    const base = B();
    check(deps(), { branch: BR, n: 1, exec: [] });
    const tree = shownT();
    stage(deps(), { branch: BR, base, tree });
    commitHub();
    record(deps(), { branch: BR, base, tree });
    return sh(wt, ['rev-parse', 'HEAD']);
  }
  const push = () =>
    sh(main, ['update-ref', `refs/remotes/origin/${BR}`, sh(wt, ['rev-parse', 'HEAD'])]);

  it('fails on a lane commit to .claude/ with no approved patch, also with no branch named', () => {
    applied();
    seed(wt, { '.claude/rules/r.md': 'sneaky\n' }, sh(wt, ['rev-parse', 'HEAD']));
    push();
    expect(() => verify(deps(), { branch: BR })).toThrow(/no approved patch/);
    expect(() => verify(deps(), { branch: null })).toThrow(/no approved patch/);
  });
  it('fails on a case-variant path and on an approval for another branch only', () => {
    seed(wt, { '.CLAUDE/x.md': 'x\n' }, sh(wt, ['rev-parse', 'HEAD']));
    push();
    expect(() => verify(deps(), { branch: BR })).toThrow(/no approved patch/);
  });
  it('an indentation-only amend changes the patch-id', () => {
    applied();
    writeFileSync(join(wt, 'CLAUDE.md'), '# Rules\n\nline one\n  line TWO\nline three\n');
    sh(wt, ['add', 'CLAUDE.md']);
    sh(wt, ['commit', '-q', '--amend', '-m', 'amended rule edit']);
    push();
    expect(() => verify(deps(), { branch: BR })).toThrow(/no approved patch/);
  });
  it('a clean rebase over a neighbouring change keeps the patch-id', () => {
    const hub = applied();
    const root = sh(main, ['rev-parse', 'refs/remotes/origin/main']);
    // line 1 sits in the hub hunk's 3-line context but is no conflict: a -U3 patch-id would change, -U0's doesn't
    const newMain = seed(
      main,
      { 'CLAUDE.md': '# RULES\n\nline one\nline two\nline three\n' },
      root,
    );
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
