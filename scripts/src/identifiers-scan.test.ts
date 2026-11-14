import { describe, expect, it } from 'vitest';
import { IDS, simCognitoPin } from './identifiers.ts';
import { scanCommit, scanDiff } from './identifiers-scan.ts';

const name = IDS.maintainer.name.split(' ')[0]!;
const diff = (path: string, start: number, lines: string[]) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +${start},${lines.length} @@`,
    ...lines,
  ].join('\n');

describe('scanDiff', () => {
  it('names the file and the new line number of each added hit, never the identifier', () => {
    const out = scanDiff(diff('docs/a.md', 10, ['+fine', `+asked by ${name}`, '-gone']));
    expect(out).toEqual(['docs/a.md:11 name']);
    expect(out.join()).not.toContain(name);
  });

  it('ignores removed lines and a deleted file, so a cleanup commit passes', () => {
    expect(scanDiff(diff('docs/a.md', 1, [`-asked by ${name}`]))).toEqual([]);
    expect(
      scanDiff(['--- a/x.md', '+++ /dev/null', '@@ -1 +0,0 @@', `-${name}`].join('\n')),
    ).toEqual([]);
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
    const out = scanDiff(
      ['--- /dev/null', '+++ b/n.md', '@@ -0,0 +1,2 @@', '+ok', `+${name}`].join('\n'),
    );
    expect(out).toEqual(['n.md:2 name']);
  });
});

describe('scanCommit', () => {
  it('checks the command (its message) as well as the diff', () => {
    expect(scanCommit('', `git commit -m "thanks ${name}"`)).toEqual(['the commit command:1 name']);
    expect(scanCommit('', 'git commit -m "added the config"')).toEqual([]);
  });
});
