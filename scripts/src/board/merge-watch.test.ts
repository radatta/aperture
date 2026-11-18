// scripts/board/merge-watch.sh (docs/ops/SESSION-BOARD.md → Watchers → merge-watch) against a fake board. The clock
// is a file, as in watchers.test.ts: PATH shims replace `sleep` (advance the clock, apply the next tick's files, or —
// with no tick left — kill the watcher, which reads as "stayed quiet") and `date` (`+%s` reads the clock).
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mergedRows } from './merge-record.ts';
import { RAN_ID } from './ran.ts';
const ctl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 && c !== '\n'); // a control byte other than newline

vi.setConfig({ testTimeout: 60_000 });
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const SCRIPT = join(import.meta.dirname, '../../board/merge-watch.sh');
const REAL_DATE = ['/usr/bin/date', '/bin/date'].find(existsSync)!;
const T0 = Date.parse('2026-11-18T12:00:00-08:00') / 1000;

const SLEEP = `#!/bin/bash
f=$WATCH_FAKE
c=$(<"$f/clock"); echo $((c + \${1%.*})) >"$f/clock"
n=$(( $(<"$f/tick") + 1 )); echo "$n" >"$f/tick"
if [ -d "$f/ticks/$n" ]; then cp -r "$f/ticks/$n/." "$f/"; else kill "$PPID"; fi
`;
const DATE = `#!/bin/bash
c=$(<"$WATCH_FAKE/clock")
if [ "$*" = "+%s" ]; then echo "$c"; exit 0; fi
for a in "$@"; do case "$a" in -d*) exec ${REAL_DATE} "$@" ;; esac; done
exec ${REAL_DATE} -d "@$c" "$@"
`;

type Files = Record<string, string>; // path under the fake root → content
const sha = (c: string) => c.repeat(40);
// the writer's own rows (merge-record.ts), so a change to its shape breaks this reader's tests too
const merged = (pr: number, s: string, title = `PR ${pr} title`) => {
  const [row] = mergedRows(`${s}\t1795031880\t${title} (#${pr})`, new Date('2026-11-18T20:00:00Z'));
  if (!row) return JSON.stringify({ kind: 'merged', pr, sha: s, title }); // a bad sha: what the writer can't make
  return JSON.stringify(row);
};
const job = JSON.stringify({
  v: 1,
  t: '2026-11-18T19:00:00Z',
  kind: 'job',
  class: 'test',
  wallSec: 9,
});
const ev = (day: string) => `board/history/events-${day}.jsonl`;

function fake(ticks: Files[], pre: (dir: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-watch-'));
  made.push(dir);
  const put = (base: string, files: Files) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(base, p, '..'), { recursive: true });
      writeFileSync(join(base, p), text);
    }
  };
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/sleep'), SLEEP, { mode: 0o755 });
  writeFileSync(join(dir, 'bin/date'), DATE, { mode: 0o755 });
  mkdirSync(join(dir, 'board/history'), { recursive: true });
  writeFileSync(join(dir, 'clock'), `${T0}\n`);
  writeFileSync(join(dir, 'tick'), '0\n');
  put(dir, ticks[0] ?? {});
  ticks.slice(1).forEach((f, i) => {
    mkdirSync(join(dir, 'ticks', String(i + 1)), { recursive: true }); // an empty tick still ticks
    put(join(dir, 'ticks', String(i + 1)), f);
  });
  pre(dir);
  return dir;
}

function run(dir: string, args: string[] = []) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 25_000,
    killSignal: 'SIGKILL',
    env: {
      PATH: `${dir}/bin:${process.env.PATH}`,
      HOME: process.env.HOME,
      TZ: 'PST8',
      WATCH_FAKE: dir,
      APERTURE_BOARD_DIR: join(dir, 'board'),
    },
  });
  return {
    status: r.status,
    quiet: r.signal === 'SIGTERM' && !r.error && r.stdout === '' && r.stderr === '',
    tick: Number(readFileSync(join(dir, 'tick'), 'utf8')),
    stdout: r.stdout,
    stderr: r.stderr,
  };
}
const lines = (s: string) => s.split('\n').filter(Boolean);
const announced = (dir: string) => lines(readFileSync(join(dir, 'board/merge-announced'), 'utf8'));

describe('merge-watch.sh: merges', () => {
  it('a first run seeds what is already there and stays quiet; a merge at tick 2 exits 10 once', () => {
    const dir = fake([
      { [ev('2026-11-18')]: `${job}\n${merged(220, sha('a'))}\n` },
      {},
      {
        [ev('2026-11-18')]:
          `${job}\n${merged(220, sha('a'))}\n${merged(231, sha('b'), 'Board brief')}\n`,
      },
    ]);
    const r = run(dir);
    expect([r.status, r.tick]).toEqual([10, 2]);
    expect(lines(r.stdout)).toEqual(['12:01 MERGED PR 231 bbbbbbb at 11:58 "Board brief"']);
    expect(announced(dir)).toEqual([sha('a'), sha('b')]);
    expect(readFileSync(join(dir, 'board/merge-watch.log'), 'utf8')).toMatch(
      /first run: seeded 1 merge\(s\)[\s\S]*MERGED PR 231/,
    );
    // restarted, it stays quiet: nothing new
    writeFileSync(join(dir, 'tick'), '0\n');
    rmSync(join(dir, 'ticks'), { recursive: true });
    expect(run(dir).quiet).toBe(true);
  });
  it('a first run with no events file at all seeds an empty baseline; the first merge after it is announced', () => {
    const dir = fake([{}, { [ev('2026-11-18')]: `${merged(231, sha('b'))}\n` }]);
    expect(run(dir)).toMatchObject({ status: 10, tick: 1 });
  });
  // root writes through the mode bit: the container user and CI's runner aren't root
  it.skipIf(process.getuid?.() === 0)(
    'a state file it cannot write: its lines, then exit 74 naming it, never a quiet exit 10',
    () => {
      const dir = fake(
        [{ [ev('2026-11-18')]: `${merged(231, sha('b'))}\n`, 'board/merge-announced': '' }],
        (d) => {
          mkdirSync(join(d, 'board/ran'), { recursive: true });
          writeFileSync(join(d, 'board/ran-announced'), '');
          chmodSync(join(d, 'board'), 0o500);
        },
      );
      try {
        const r = run(dir);
        expect([r.status, r.stderr]).toEqual([
          74,
          expect.stringMatching(/cannot write .*merge-announced/),
        ]);
        expect(r.stdout).toMatch(/MERGED PR 231 bbbbbbb/); // recorded or not, its line is said before the exit
      } finally {
        chmodSync(join(dir, 'board'), 0o700);
      }
    },
  );
  it('an empty merge-announced is a real baseline: every merged row is new', () => {
    const dir = fake([
      { [ev('2026-11-18')]: `${merged(231, sha('b'))}\n`, 'board/merge-announced': '' },
    ]);
    expect(run(dir)).toMatchObject({ status: 10, tick: 0 });
  });
  it('two merges in one round: two lines, one exit; a duplicate row is said once', () => {
    const dir = fake([
      { 'board/merge-announced': '' },
      {
        [ev('2026-11-18')]:
          [merged(231, sha('b')), merged(232, sha('c')), merged(231, sha('b'))].join('\n') + '\n',
      },
    ]);
    const r = run(dir);
    expect(r.status).toBe(10);
    expect(lines(r.stdout).map((l) => l.split(' ').slice(1, 5).join(' '))).toEqual([
      'MERGED PR 231 bbbbbbb',
      'MERGED PR 232 ccccccc',
    ]);
    expect(announced(dir)).toEqual([sha('b'), sha('c')]);
  });
  it('a bad sha, a string pr, a torn line and a job row are ignored', () => {
    const bad = [
      merged(240, 'abc'),
      JSON.stringify({ kind: 'merged', pr: '241', sha: sha('d') }),
      '{"kind":"merged","pr":242,"sha":"',
      job,
    ];
    const dir = fake([
      { 'board/merge-announced': '' },
      { [ev('2026-11-18')]: bad.join('\n') + '\n' },
    ]);
    expect(run(dir).quiet).toBe(true);
  });
  it("reads yesterday's file too (just past midnight), never older ones", () => {
    const dir = fake([
      { 'board/merge-announced': '' },
      {
        [ev('2026-11-16')]: `${merged(200, sha('e'))}\n`,
        [ev('2026-11-17')]: `${merged(201, sha('f'))}\n`,
        [ev('2026-11-18')]: `${job}\n`,
      },
    ]);
    const r = run(dir);
    expect(r.status).toBe(10);
    expect(r.stdout).toMatch(/PR 201/);
    expect(r.stdout).not.toMatch(/PR 200/);
  });
  it('an empty field stays a field: no time reads ?, a backslash in a title stays one, a control byte in a time is cut', () => {
    const row = (pr: number, c: string, o: object) =>
      JSON.stringify({ v: 1, kind: 'merged', pr, sha: sha(c), ...o });
    const dir = fake([
      { 'board/merge-announced': '' },
      {
        [ev('2026-11-18')]:
          [
            row(250, 'd', { mergedAt: '', title: 'a\\b' }),
            row(251, 'e', { title: 'no time' }),
            row(252, 'f', { mergedAt: '2026-11-18T20:00:00Z\n\u001fx', title: 'torn' }),
          ].join('\n') + '\n',
      },
    ]);
    const r = run(dir);
    expect(r.status).toBe(10);
    expect(lines(r.stdout).map((l) => l.slice(6))).toEqual([
      'MERGED PR 250 ddddddd at ? "a\\b"',
      'MERGED PR 251 eeeeeee at ? "no time"',
      'MERGED PR 252 fffffff at ? "torn"',
    ]);
    expect(ctl(r.stdout)).toBe(false);
  });
  it('no jq: exit 78 naming it, never a watcher that can no longer see a merge', () => {
    const dir = fake([{ 'board/merge-announced': '' }]);
    // every tool on the box but jq
    const nojq = join(dir, 'nojq');
    mkdirSync(nojq);
    for (const f of readdirSync('/usr/bin'))
      if (f !== 'jq') symlinkSync(join('/usr/bin', f), join(nojq, f));
    const r = spawnSync('/usr/bin/bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 25_000,
      env: { PATH: `${dir}/bin:${nojq}`, WATCH_FAKE: dir, APERTURE_BOARD_DIR: join(dir, 'board') },
    });
    expect([r.status, r.stderr]).toEqual([78, expect.stringMatching(/jq missing/)]);
  });
  it('control bytes in a title never reach stdout', () => {
    const dir = fake([
      { 'board/merge-announced': '' },
      { [ev('2026-11-18')]: `${merged(231, sha('b'), 'evil\u001b[31m\u0007 title')}\n` },
    ]);
    const r = run(dir);
    expect(r.status).toBe(10);
    expect(ctl(r.stdout)).toBe(false);
  });
});

describe('merge-watch.sh: Mac ran markers', () => {
  const base = { 'board/merge-announced': '' };
  it('a marker with an exit code exits 11 with it; a restart is quiet', () => {
    const dir = fake([base, { 'board/ran/xcode-1a2b': '0\n' }]);
    const r = run(dir);
    expect([r.status, r.tick, lines(r.stdout)]).toEqual([11, 1, ['12:00 RAN xcode-1a2b exit 0']]);
    writeFileSync(join(dir, 'tick'), '0\n');
    rmSync(join(dir, 'ticks'), { recursive: true });
    expect(run(dir).quiet).toBe(true);
  });
  it('a non-zero exit is said as it is', () => {
    const dir = fake([{ ...base, 'board/ran/token-0001': '127\n' }]);
    expect(lines(run(dir).stdout)).toEqual(['12:00 RAN token-0001 exit 127']);
  });
  it('non-numeric content: quiet one tick, then unreadable, never echoed', () => {
    const dir = fake([{ ...base, 'board/ran/odd-0001': 'rm -r\n' }, {}]);
    const r = run(dir);
    expect([r.status, r.tick]).toEqual([11, 1]);
    expect(r.stdout).toMatch(/RAN odd-0001 unreadable/);
    expect(r.stdout).not.toMatch(/rm/);
  });
  it('an empty file that fills in reads its code', () => {
    const dir = fake([{ ...base, 'board/ran/late-0001': '' }, { 'board/ran/late-0001': '1\n' }]);
    const r = run(dir);
    expect([r.status, lines(r.stdout)]).toEqual([11, ['12:00 RAN late-0001 exit 1']]);
  });
  it('a FIFO swapped in after the file check never hangs the watcher', () => {
    const REAL_STAT = ['/usr/bin/stat', '/bin/stat'].find(existsSync)!;
    const dir = fake([{ ...base, 'board/ran/swap-0001': '0\n' }, {}], (d) =>
      // stat runs between the -f check and the read: this one swaps the marker for a FIFO with no writer first
      writeFileSync(
        join(d, 'bin/stat'),
        `#!/bin/bash\nfor a; do case "$a" in */swap-0001) rm -f "$a"; mkfifo "$a" ;; esac; done\nexec ${REAL_STAT} "$@"\n`,
        { mode: 0o755 },
      ),
    );
    const r = run(dir);
    expect(r.quiet).toBe(true); // a 1 s timeout, then never a plain file again: skipped, not a hang to the test's kill
    expect(r.tick).toBe(2);
  });
  it('more markers than any cap: each said once, a restart is quiet', () => {
    const many = Object.fromEntries(
      Array.from({ length: 205 }, (_, i) => [`board/ran/m-${String(i).padStart(4, '0')}`, '0\n']),
    );
    const dir = fake([{ ...base, ...many }]);
    const r = run(dir);
    expect([r.status, lines(r.stdout).length]).toEqual([11, 205]);
    writeFileSync(join(dir, 'tick'), '0\n');
    expect(run(dir).quiet).toBe(true);
  });
  it('a bad name, a symlink, a directory and an oversize file are never read or announced', () => {
    const dir = fake(
      [{ ...base, 'board/ran/Bad_Name': '0\n', 'board/ran/big-0001': '0'.repeat(9) }, {}],
      (d) => {
        writeFileSync(join(d, 'secret'), '0\n');
        symlinkSync(join(d, 'secret'), join(d, 'board/ran/link-0001'));
        mkdirSync(join(d, 'board/ran/dir-0001'));
      },
    );
    expect(run(dir).quiet).toBe(true);
  });
  it('a merge and a marker together: exit 10, both lines', () => {
    const dir = fake([
      base,
      { [ev('2026-11-18')]: `${merged(231, sha('b'))}\n`, 'board/ran/push-0001': '0\n' },
    ]);
    const r = run(dir);
    expect(r.status).toBe(10);
    expect(lines(r.stdout).map((l) => l.split(' ')[1])).toEqual(['MERGED', 'RAN']);
  });
  it('the same line run again (a new mtime) fires again', () => {
    const dir = fake([{ ...base, 'board/ran/again-0001': '0\n' }]);
    expect(run(dir).status).toBe(11);
    const f = join(dir, 'board/ran/again-0001');
    const t = statSync(f).mtimeMs / 1000 + 60;
    utimesSync(f, t, t);
    writeFileSync(join(dir, 'tick'), '0\n');
    expect(run(dir).status).toBe(11);
  });
  it('markers a week old are deleted at start', () => {
    const dir = fake([base], (d) => {
      const f = join(d, 'board/ran/old-0001');
      mkdirSync(join(d, 'board/ran'), { recursive: true });
      writeFileSync(f, '0\n');
      const t = Date.now() / 1000 - 8 * 86400;
      utimesSync(f, t, t);
    });
    expect(run(dir).quiet).toBe(true);
    expect(existsSync(join(dir, 'board/ran/old-0001'))).toBe(false);
  });
  it('its name pattern is ran.ts RAN_ID', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain(`ID_RE='${RAN_ID.source}'`);
  });
});

describe('merge-watch.sh: its shape', () => {
  it('an argument is exit 2; the script is executable', () => {
    const dir = fake([]);
    expect(run(dir, ['x'])).toMatchObject({ status: 2 });
    expect(statSync(SCRIPT).mode & 0o111).toBe(0o111);
  });
});
