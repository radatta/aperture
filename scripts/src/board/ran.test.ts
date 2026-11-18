import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAC_PLACEHOLDER, MAC_ROOT_NOTE } from '../mac-root.ts';
import { RAN_ID, ranId, ranOut, ranSuffix } from './ran.ts';

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ran-'));
  made.push(d);
  return d;
};
const CLI = join(import.meta.dirname, 'cli.ts');

describe('ranId', () => {
  it('is the slug plus 4 base36 of the epoch second, and fits RAN_ID', () => {
    const id = ranId('xcode-build', new Date('2026-11-18T20:00:00Z'));
    expect(id).toMatch(/^xcode-build-[0-9a-z]{4}$/);
    expect(RAN_ID.test(id)).toBe(true);
    expect(ranId('a', new Date(0))).toBe('a-0000');
    // a minute later is another file
    expect(ranId('a', new Date(60_000))).not.toBe(ranId('a', new Date(0)));
  });
  it('refuses a slug that could break the line or the name check', () => {
    for (const bad of ['', 'Caps', 'a b', 'a;b', '-lead', '../x', 'x'.repeat(28), 'a$(x)'])
      expect(() => ranId(bad, new Date())).toThrow(/slug/);
  });
});

describe('ranSuffix', () => {
  it('echoes the chain status with >| into the absolute ran/ path', () => {
    expect(ranSuffix('/mac/repo', 'push-0a1b')).toBe(
      '; echo $? >| /mac/repo/localNotes/board/ran/push-0a1b',
    );
    expect(() => ranSuffix('/r', 'Bad Id')).toThrow(/bad id/);
  });
  it('the placeholder root carries the note, never a real path', () => {
    expect(ranOut(MAC_PLACEHOLDER, 'a-0000')).toBe(
      `; echo $? >| ${MAC_PLACEHOLDER}/localNotes/board/ran/a-0000\n${MAC_ROOT_NOTE}`,
    );
    expect(ranOut('/r', 'a-0000')).not.toContain('\n');
  });

  // The suffix under the shells it runs in: the Mac's zsh (when this box has one) and bash.
  const shells = [
    ['bash', '--norc', '--noprofile', '-c'],
    ...(existsSync('/usr/bin/zsh') || existsSync('/bin/zsh') ? [['zsh', '-f', '-c']] : []),
  ];
  for (const [sh, ...flags] of shells) {
    it(`${sh}: records the && chain's status, past noclobber, after a cd elsewhere`, () => {
      const root = tmp();
      mkdirSync(join(root, 'localNotes/board/ran'), { recursive: true });
      mkdirSync(join(root, 'wt'));
      const sfx = (id: string) => ranSuffix(root, id);
      const runLine = (line: string) =>
        spawnSync(sh!, [...flags, line], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      const read = (id: string) => readFileSync(join(root, 'localNotes/board/ran', id), 'utf8');
      runLine(`cd ${root} && true && cd wt && true${sfx('ok-0001')}`);
      expect(read('ok-0001')).toBe('0\n');
      runLine(`cd ${root} && false && true${sfx('fail-0001')}`);
      expect(read('fail-0001')).toBe('1\n');
      runLine(`cd ${root} && (exit 7)${sfx('seven-0001')}`);
      expect(read('seven-0001')).toBe('7\n');
      runLine(`cd ${root}/nowhere && true${sfx('cd-0001')}`);
      expect(read('cd-0001')).toBe('1\n');
      // a rerun over an existing file, with noclobber on
      const noclobber = sh === 'zsh' ? 'setopt noclobber' : 'set -o noclobber';
      runLine(`${noclobber}; cd ${root} && false${sfx('ok-0001')}`);
      expect(read('ok-0001')).toBe('1\n');
    });
  }
});

describe('pnpm board ran', () => {
  it('prints only the suffix and makes the ran/ folder', () => {
    const dir = join(tmp(), 'board');
    const r = spawnSync('node', [CLI, 'ran', 'xcode'], {
      encoding: 'utf8',
      env: { ...process.env, APERTURE_BOARD_DIR: dir },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toMatch(
      /^; echo \$\? >\| \S+\/localNotes\/board\/ran\/xcode-[0-9a-z]{4}$/,
    );
    expect(statSync(join(dir, 'ran')).isDirectory()).toBe(true);
  });
  it('a bad slug, or none, refuses', () => {
    const env = { ...process.env, APERTURE_BOARD_DIR: join(tmp(), 'board') };
    expect(spawnSync('node', [CLI, 'ran', 'Bad'], { encoding: 'utf8', env }).status).toBe(2);
    expect(spawnSync('node', [CLI, 'ran'], { encoding: 'utf8', env }).status).toBe(2);
  });
});
