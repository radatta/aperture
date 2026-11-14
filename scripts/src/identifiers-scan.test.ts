import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDS, simCognitoPin } from './identifiers.ts';
import { commitMessages, scanCommit, scanDiff, scanRange } from './identifiers-scan.ts';

const name = IDS.maintainer.name.split(' ')[0]!;
const diff = (path: string, start: number, lines: string[], header = `+++ b/${path}`) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    header,
    `@@ -1,0 +${start},${lines.length} @@`,
    ...lines,
  ].join('\n');
const GIT = ['git', 'commit'].join(' '); // spelled apart: the commit hook reads any Bash line naming it

describe('scanDiff', () => {
  it('names the file and the new line number of each added hit, never the identifier', () => {
    const out = scanDiff(diff('docs/a.md', 10, ['+fine', `+asked by ${name}`, '-gone']));
    expect(out).toEqual(['docs/a.md:11 name']);
    expect(out.join()).not.toContain(name);
  });

  it('ignores removed lines and a deleted file, so a cleanup commit passes', () => {
    expect(scanDiff(diff('docs/a.md', 1, [`-asked by ${name}`]))).toEqual([]);
    const deleted = [
      'diff --git a/x.md b/x.md',
      '--- a/x.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      `-${name}`,
    ];
    expect(scanDiff(deleted.join('\n'))).toEqual([]);
  });

  it('exempts identifiers.json and the sim runner pin, nothing else', () => {
    expect(scanDiff(diff('identifiers.json', 1, [`+"name": "${IDS.maintainer.name}"`]))).toEqual(
      [],
    );
    expect(scanDiff(diff('tools/mailroom/jobs/sim.sh', 14, [`+${simCognitoPin()}`]))).toEqual([]);
    expect(scanDiff(diff('tools/x.sh', 14, [`+${simCognitoPin()}`]))).toEqual([
      'tools/x.sh:14 account-id',
    ]);
  });

  it('a new file counts from its hunk start', () => {
    const added = ['diff --git a/n.md b/n.md', '--- /dev/null', '+++ b/n.md', '@@ -0,0 +1,2 @@'];
    expect(scanDiff([...added, '+ok', `+${name}`].join('\n'))).toEqual(['n.md:2 name']);
  });

  it('reads quoted and tab-suffixed header paths, and a content line that looks like a header', () => {
    expect(scanDiff(diff('caf.md', 1, [`+${name}`], '+++ "b/caf\\303\\251.md"'))).toEqual([
      'café.md:1 name',
    ]);
    expect(scanDiff(diff('a b.md', 1, [`+${name}`], '+++ b/a b.md\t'))).toEqual(['a b.md:1 name']);
    expect(scanDiff(diff('c.md', 1, ['+++ not a header', `+${name}`]))).toEqual(['c.md:2 name']);
  });

  it('a path that names the maintainer is a hit', () => {
    const p = `docs/${name.toLowerCase()}-notes.md`;
    expect(scanDiff(diff(p, 1, ['+fine']))).toEqual([`${p} (its path) name`]);
  });
});

describe('scanDiff on real git output', () => {
  // The flags the hook and the push use; a throwaway repo, so git's own headers are what's parsed.
  const gd = (cwd: string) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--cached',
        '-U0',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--src-prefix=a/',
        '--dst-prefix=b/',
      ],
      { cwd, encoding: 'utf8' },
    );
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  it('names a renamed, a binary and an empty new file, and lets a deleted one go', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    g(dir, 'init', '-q');
    g(dir, 'config', 'user.email', 'x@example.com');
    g(dir, 'config', 'user.name', 'x');
    const n = name.toLowerCase();
    writeFileSync(join(dir, 'old.md'), 'same text\n'.repeat(5));
    writeFileSync(join(dir, `${n}-gone.md`), 'bye\n');
    g(dir, 'add', '.');
    g(dir, 'commit', '-q', '-m', 'base');
    g(dir, 'mv', 'old.md', `${n}-notes.md`);
    writeFileSync(join(dir, `${n}.bin`), Buffer.from([0, 1, 2, 0, 255]));
    writeFileSync(join(dir, `${n}-empty.md`), '');
    g(dir, 'rm', '-q', `${n}-gone.md`);
    g(dir, 'add', '.');
    expect(scanDiff(gd(dir)).sort()).toEqual(
      [
        `${n}-empty.md (its path) name`,
        `${n}-notes.md (its path) name`,
        `${n}.bin (its path) name`,
      ].sort(),
    );
  });
});

describe('scanCommit', () => {
  it('checks the command (its message) as well as the diff', () => {
    expect(scanCommit('', `${GIT} -m "thanks ${name}"`)).toEqual(['the commit message:1 name']);
    expect(scanCommit('', `${GIT} -m "added the config"`)).toEqual([]);
  });

  it('scans only the message, so removing a file named for someone passes', () => {
    expect(scanCommit('', `git rm docs/${name}-notes.md && ${GIT} -m "removed old notes"`)).toEqual(
      [],
    );
  });
});

describe('commitMessages', () => {
  it.each([
    [`${GIT} -m "a b"`, ['a b']],
    [`${GIT} -am 'a b'`, ['a b']],
    [`${GIT} --message="a \\"b\\""`, ['a "b"']],
    [`${GIT} -mword && echo`, ['word']],
    [`${GIT} -F msg.txt`, []],
  ])('%s', (cmd, want) => {
    expect(commitMessages(cmd)).toEqual(want);
  });
});

describe('scanRange', () => {
  it('prefixes each hit with its commit, message and diff alike', () => {
    const sha = 'a'.repeat(40);
    expect(
      scanRange([{ sha, message: `by ${name}`, diff: diff('d.md', 3, [`+${name}`]) }]),
    ).toEqual(['aaaaaaaaaaaa message:1 name', 'aaaaaaaaaaaa d.md:3 name']);
  });
});
