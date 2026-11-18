import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
const HAS_ZSH = existsSync('/usr/bin/zsh') || existsSync('/bin/zsh'); // CI's runner may have none: the case shows as skipped

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
  it('captures the chain status, then writes it create-only into the absolute ran/ path', () => {
    expect(ranSuffix('/mac/repo', 'push-0a1b')).toBe(
      '; (r=$?; set -C; echo $r > /mac/repo/localNotes/board/ran/push-0a1b)',
    );
    expect(() => ranSuffix('/r', 'Bad Id')).toThrow(/bad id/);
  });
  it('the placeholder root carries the note, never a real path', () => {
    expect(ranOut(MAC_PLACEHOLDER, 'a-0000')).toBe(
      `${ranSuffix(MAC_PLACEHOLDER, 'a-0000')}\n${MAC_ROOT_NOTE}`,
    );
    expect(ranOut('/r', 'a-0000')).not.toContain('\n');
  });

  // The suffix under the shells it runs in: the Mac's zsh (when this box has one) and bash.
  const shells: [string, boolean, string[]][] = [
    ['bash', true, ['--norc', '--noprofile', '-c']],
    ['zsh', HAS_ZSH, ['-f', '-c']],
  ];
  for (const [sh, has, flags] of shells) {
    const world = () => {
      const root = tmp();
      mkdirSync(join(root, 'localNotes/board/ran'), { recursive: true });
      mkdirSync(join(root, 'wt'));
      const runLine = (line: string) =>
        spawnSync(sh, [...flags, line], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      const path = (id: string) => join(root, 'localNotes/board/ran', id);
      return { root, runLine, path, sfx: (id: string) => ranSuffix(root, id) };
    };
    it.skipIf(!has)(`${sh}: records the && chain's status, after a cd elsewhere`, () => {
      const { root, runLine, path, sfx } = world();
      const read = (id: string) => readFileSync(path(id), 'utf8');
      runLine(`cd ${root} && true && cd wt && true${sfx('ok-0001')}`);
      expect(read('ok-0001')).toBe('0\n');
      runLine(`cd ${root} && false && true${sfx('fail-0001')}`);
      expect(read('fail-0001')).toBe('1\n');
      runLine(`cd ${root} && (exit 7)${sfx('seven-0001')}`);
      expect(read('seven-0001')).toBe('7\n');
      runLine(`cd ${root}/nowhere && true${sfx('cd-0001')}`);
      expect(read('cd-0001')).toBe('1\n');
    });
    it.skipIf(!has)(
      `${sh}: never writes through what is already there — a file, a planted symlink, a dangling one`,
      () => {
        const { root, runLine, path, sfx } = world();
        runLine(`cd ${root} && true${sfx('once-0001')}`);
        const again = runLine(`cd ${root} && false${sfx('once-0001')}`);
        expect(readFileSync(path('once-0001'), 'utf8')).toBe('0\n'); // the rerun is refused, aloud
        expect(again.stderr).toMatch(/exist/);
        const mac = join(root, 'precious');
        writeFileSync(mac, 'precious\n');
        symlinkSync(mac, path('link-0001'));
        symlinkSync(join(root, 'nothing-here'), path('dangle-0001'));
        expect(runLine(`cd ${root} && false${sfx('link-0001')}`).stderr).toMatch(/exist/);
        runLine(`cd ${root} && false${sfx('dangle-0001')}`);
        expect(readFileSync(mac, 'utf8')).toBe('precious\n');
        expect(existsSync(join(root, 'nothing-here'))).toBe(false);
        // the user's own noclobber setting changes nothing
        const nc = sh === 'zsh' ? 'setopt noclobber' : 'set -o noclobber';
        runLine(`${nc}; cd ${root} && true${sfx('nc-0001')}`);
        expect(readFileSync(path('nc-0001'), 'utf8')).toBe('0\n');
      },
    );
  }
});

describe('pnpm board ran', () => {
  const board = () => join(tmp(), 'localNotes/board');
  const ran = (dir: string, ...a: string[]) =>
    spawnSync('node', [CLI, 'ran', ...a], {
      encoding: 'utf8',
      env: { ...process.env, APERTURE_BOARD_DIR: dir },
    });
  it('prints only the suffix and makes the ran/ folder', () => {
    const dir = board();
    const r = ran(dir, 'xcode');
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')[0]).toMatch(
      /^; \(r=\$\?; set -C; echo \$r > \S+\/localNotes\/board\/ran\/xcode-[0-9a-z]{4}\)$/,
    );
    expect(statSync(join(dir, 'ran')).isDirectory()).toBe(true);
  });
  it('a bad slug, none, a board dir the suffix does not write, or an id already on disk refuses', () => {
    const dir = board();
    expect(ran(dir, 'Bad').status).toBe(2);
    expect(ran(dir).status).toBe(2);
    const other = ran(join(tmp(), 'board'), 'xcode');
    expect([other.status, other.stderr]).toEqual([
      2,
      expect.stringMatching(/not <repo>\/localNotes\/board/),
    ]);
    // every id this minute's slug can take is on disk: whichever second it runs in, refused
    mkdirSync(join(dir, 'ran'), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    for (let t = now - 5; t <= now + 60; t++)
      writeFileSync(join(dir, 'ran', `dup-${(t % 36 ** 4).toString(36).padStart(4, '0')}`), '0\n');
    const dup = ran(dir, 'dup');
    expect([dup.status, dup.stderr]).toEqual([2, expect.stringMatching(/already on disk/)]);
  });
});
