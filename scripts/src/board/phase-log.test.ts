// scripts/board/phase-log.sh: lane phase changes → the usage dir's phase-log.jsonl (docs/ops/USAGE-METER.md → Phase
// log). Driven against temp board and usage dirs; every lane, time and percent is invented.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const boardScripts = fileURLToPath(new URL('../../board/', import.meta.url));
const script = join(boardScripts, 'phase-log.sh');

let tmp: string;
let board: string;
let usage: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'phase-log-'));
  board = join(tmp, 'board');
  usage = join(tmp, 'usage');
  mkdirSync(join(board, 'lanes'), { recursive: true });
  mkdirSync(usage);
  writeFileSync(
    join(tmp, 'limits.json'),
    JSON.stringify({ watchers: { usage: { freshSec: 600 } } }),
  );
  env = {
    PATH: process.env.PATH,
    TZ: 'UTC', // meter ts are local with an offset; in UTC the script's local cut and these stamps agree
    APERTURE_BOARD_DIR: board,
    APERTURE_USAGE_DIR: usage,
    APERTURE_LIMITS_JSON: join(tmp, 'limits.json'),
  };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const lane = (branch: string, phase: string, since: string, step = 'x') =>
  writeFileSync(
    join(board, 'lanes', `${branch}.json`),
    JSON.stringify({ v: 1, branch, phase, phaseSince: since, step }, null, 2),
  );
const iso = (agoSec: number) =>
  `${new Date(Date.now() - agoSec * 1000).toISOString().slice(0, 19)}+00:00`;
const meter = (rows: { agoSec: number; sid: string; pct: number }[]) =>
  writeFileSync(
    join(usage, 'meter-2026-01-05.jsonl'),
    rows
      .map((r) =>
        JSON.stringify({
          ts: iso(r.agoSec),
          sid: r.sid,
          rl: { seven_day: { used_percentage: r.pct } },
        }),
      )
      .join('\n') + '\n',
  );
const pass = () => spawnSync('bash', [script, '--once'], { env, encoding: 'utf8' });
const rows = () =>
  existsSync(join(usage, 'phase-log.jsonl'))
    ? readFileSync(join(usage, 'phase-log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const S1 = '2026-01-05T10:00:00.000Z';
const S2 = '2026-01-05T11:00:00.000Z';

describe('phase-log.sh', () => {
  it('writes a first sighting per lane, with phaseSince and the max fresh meter %, and nothing on stdout', () => {
    meter([
      { agoSec: 60, sid: 'a', pct: 40 },
      { agoSec: 30, sid: 'b', pct: 42 },
      { agoSec: 3600, sid: 'c', pct: 99 }, // stale: outside freshSec
    ]);
    lane('aa', 'build', S1);
    lane('bb', 'review', S2);
    const r = pass();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(rows()).toEqual([
      { v: 1, lane: 'aa', from: null, to: 'build', ts: S1, pct: 42 },
      { v: 1, lane: 'bb', from: null, to: 'review', ts: S2, pct: 42 },
    ]);
    pass(); // nothing changed: nothing new
    expect(rows()).toHaveLength(2);
  });

  it('logs a phase change, not a same-phase rewrite, and a removed lane as to null', () => {
    lane('aa', 'build', S1);
    lane('bb', 'review', S2);
    pass();
    lane('aa', 'build', S1, 'section 2'); // `board lane build --step …` keeps phaseSince
    pass();
    expect(rows()).toHaveLength(2);
    lane('aa', 'gate', S2);
    rmSync(join(board, 'lanes', 'bb.json'));
    pass();
    const [gate, gone] = rows().slice(2);
    expect(gate).toMatchObject({ lane: 'aa', from: 'build', to: 'gate', ts: S2 });
    expect(gone).toMatchObject({ lane: 'bb', from: 'review', to: null });
    expect(Date.parse(gone.ts)).toBeGreaterThan(Date.now() - 60_000);
    pass(); // the removed lane is dropped from the state: said once
    expect(rows()).toHaveLength(4);
  });

  it('a phase that left and came back between passes still logs (phaseSince moved)', () => {
    lane('aa', 'review', S1);
    pass();
    lane('aa', 'review', S2);
    pass();
    expect(rows().at(-1)).toMatchObject({ from: 'review', to: 'review', ts: S2 });
  });

  it('skips a torn lane file and keeps its state, so a write caught mid-way is no change', () => {
    lane('aa', 'build', S1);
    pass();
    writeFileSync(join(board, 'lanes', 'aa.json'), '{"v":1,"branch":"aa","pha');
    pass();
    expect(rows()).toHaveLength(1); // not removed, not changed
    lane('aa', 'build', S1);
    pass();
    expect(rows()).toHaveLength(1);
    writeFileSync(join(board, 'lanes', 'zz.json'), '{"v":1,"pha'); // torn on first sight: nothing yet
    pass();
    expect(rows()).toHaveLength(1);
  });

  it('pct is null with no fresh meter row, or no meter at all', () => {
    lane('aa', 'build', S1);
    pass();
    meter([{ agoSec: 7200, sid: 'a', pct: 50 }]);
    lane('aa', 'gate', S2);
    pass();
    expect(rows().map((r) => r.pct)).toEqual([null, null]);
  });

  it('a failed append leaves the state alone, so the next pass writes the rows; exit 0 either way', () => {
    lane('aa', 'build', S1);
    env.APERTURE_PHASE_LOG = join(tmp, 'nodir', 'x', 'log.jsonl');
    writeFileSync(join(tmp, 'nodir'), 'a file, not a dir');
    const r = pass();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(existsSync(join(board, 'phase-log.state'))).toBe(false);
    expect(readFileSync(join(board, 'phase-log.log'), 'utf8')).toMatch(/cannot append/);
    delete env.APERTURE_PHASE_LOG;
    pass();
    expect(rows()).toEqual([expect.objectContaining({ lane: 'aa', to: 'build' })]);
  });

  it('ignores a file whose name is not a lane name, and refuses arguments', () => {
    writeFileSync(join(board, 'lanes', 'Bad_Name.json'), JSON.stringify({ phase: 'build' }));
    pass();
    expect(rows()).toEqual([]);
    expect(spawnSync('bash', [script], { env }).status).toBe(2);
    expect(spawnSync('bash', [script, '--once', 'x'], { env }).status).toBe(2);
  });

  it('is executable, and the sampler loop runs it every tick in the background with fd 8 closed', () => {
    expect(statSync(script).mode & 0o111).toBe(0o111);
    const sampler = readFileSync(join(boardScripts, 'sampler.sh'), 'utf8');
    const start = sampler.indexOf('while :; do');
    const loop = sampler.slice(start, sampler.indexOf('\ndone', start));
    // inside the loop: launched in the background, cut off, its stderr kept, its pid taken for the skip guard
    expect(loop).toMatch(
      /if ! \{ \[ -n "\$\{pl:-\}" \] && kill -0 "\$pl" 2>\/dev\/null; \}; then\n\s+timeout 25 bash "\$SB_SCRIPTS\/phase-log\.sh" --once >\/dev\/null 2>>"\$BOARD_DIR\/phase-log\.log" 8>&- &\n\s+pl=\$!\n/,
    );
  });

  it('a row that fails to build (a refused fork) appends nothing and keeps the state', () => {
    lane('aa', 'build', S1);
    pass();
    const state = readFileSync(join(board, 'phase-log.state'), 'utf8');
    // a jq that prints nothing when asked to build a row, as a refused fork leaves it
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const real = spawnSync('bash', ['-c', 'command -v jq'], {
      env,
      encoding: 'utf8',
    }).stdout.trim();
    writeFileSync(
      join(bin, 'jq'),
      `#!/bin/bash\nfor a; do [ "$a" = -nc ] && exit 0; done\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    lane('aa', 'gate', S2);
    const r = spawnSync('bash', [script, '--once'], {
      env: { ...env, PATH: `${bin}:${env.PATH}` },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(rows()).toHaveLength(1);
    expect(readFileSync(join(board, 'phase-log.state'), 'utf8')).toBe(state);
    expect(readFileSync(join(board, 'phase-log.log'), 'utf8')).toMatch(/row failed to build/);
    pass(); // the real jq: the change is written now
    expect(rows().at(-1)).toMatchObject({ from: 'build', to: 'gate', ts: S2 });
  });

  it('says so when it cannot open its lock, and keeps stderr open for the sampler past it', () => {
    lane('aa', 'build', S1);
    env.APERTURE_PHASE_STATE = join(tmp, 'no-such-dir', 'phase-log.state');
    expect(pass().status).toBe(0);
    expect(rows()).toEqual([]);
    expect(readFileSync(join(board, 'phase-log.log'), 'utf8')).toMatch(/cannot open .*\.lock/);
    // the lock's redirect is scoped to its group: a bare `exec 9>… 2>/dev/null` would silence the rest of the script
    expect(readFileSync(script, 'utf8')).toMatch(
      /^\{ exec 9>"\$STATE\.lock"; \} 2>\/dev\/null \|\| /m,
    );
  });

  it('reads past a corrupt state file: its bad lines are no lanes', () => {
    writeFileSync(join(board, 'phase-log.state'), 'Bad Lane\tbuild\tx\n\x00garbage\n');
    lane('aa', 'build', S1);
    pass();
    expect(rows()).toEqual([expect.objectContaining({ lane: 'aa', from: null, to: 'build' })]);
  });

  it('one pass at a time: a pass that finds the lock held writes nothing', () => {
    lane('aa', 'build', S1);
    const held = spawnSync(
      'flock',
      [join(board, 'phase-log.state.lock'), 'bash', script, '--once'],
      { env, encoding: 'utf8' },
    );
    expect(held.status).toBe(0);
    expect(rows()).toEqual([]);
    pass();
    expect(rows()).toHaveLength(1);
  });

  it('starts a fresh line after a torn last line, so the first row survives', () => {
    writeFileSync(join(usage, 'phase-log.jsonl'), '{"v":1,"lane":"aa","fr');
    lane('aa', 'build', S1);
    pass();
    const lines = readFileSync(join(usage, 'phase-log.jsonl'), 'utf8').split('\n');
    expect(JSON.parse(lines[1]!)).toMatchObject({ lane: 'aa', to: 'build', ts: S1 });
  });

  it('a log path with no directory part is written in place', () => {
    lane('aa', 'build', S1);
    spawnSync('bash', [script, '--once'], {
      env: { ...env, APERTURE_PHASE_LOG: 'plain.jsonl' },
      cwd: usage,
    });
    expect(readFileSync(join(usage, 'plain.jsonl'), 'utf8')).toMatch(/"to":"build"/);
  });

  it('with no phaseSince the first sighting is stamped now, and an unchanged file is not relogged', () => {
    writeFileSync(join(board, 'lanes', 'aa.json'), JSON.stringify({ v: 1, phase: 'build' }));
    pass();
    pass();
    expect(rows()).toHaveLength(1);
    expect(Date.parse(rows()[0].ts)).toBeGreaterThan(Date.now() - 60_000);
    writeFileSync(join(board, 'lanes', 'bb.json'), JSON.stringify({ v: 1, phase: 7 }));
    pass(); // a phase that isn't a string is no lane yet
    expect(rows()).toHaveLength(1);
  });

  it('pct is null with freshSec missing, and says so in its log', () => {
    writeFileSync(join(tmp, 'limits.json'), JSON.stringify({ watchers: {} }));
    meter([{ agoSec: 30, sid: 'a', pct: 40 }]);
    lane('aa', 'build', S1);
    pass();
    expect(rows()[0].pct).toBeNull();
    expect(readFileSync(join(board, 'phase-log.log'), 'utf8')).toMatch(/freshSec missing or bad/);
  });

  it("reads the meter in the container's own zone: a UTC−8-stamped fresh row counts, a stale one not", () => {
    env.TZ = 'Etc/GMT+8'; // UTC−8 all year (the POSIX sign is inverted): Pacific's offset without the DST switch
    const pt = (agoSec: number) => {
      const d = new Date(Date.now() - agoSec * 1000 - 8 * 3600_000);
      return `${d.toISOString().slice(0, 19)}-08:00`;
    };
    writeFileSync(
      join(usage, 'meter-2026-01-05.jsonl'),
      [
        { ts: pt(30), sid: 'a', rl: { seven_day: { used_percentage: 41 } } },
        { ts: pt(7200), sid: 'b', rl: { seven_day: { used_percentage: 90 } } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    lane('aa', 'build', S1);
    pass();
    expect(rows()[0].pct).toBe(41);
  });
});
