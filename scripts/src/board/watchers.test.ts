// The hub's watchers (scripts/board/{pace,usage,context}-watch.sh; docs/ops/SESSION-BOARD.md → Watchers) against a fake
// cgroup, loadavg, board and meter dir. The clock is a file: PATH shims replace `sleep` (advance the clock, apply the
// next tick's files, or — with no tick left — kill the watcher, which reads as "stayed quiet") and `date` (`+%s` reads
// the clock; `-d @N` forms pass through). Each exit fires once, at the tick worked out by hand; each non-exit stays
// quiet. TZ=PST8 needs no tzdata and pins local time to -08:00, which the meter rows and history file names use.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PACE_DEFAULTS, paceReasons } from '../lane/pace.ts';
import { STOP_LEAD_SEC } from './away.ts';

// Every case is a few dozen bash/jq forks per tick: well under a second idle, slower beside a full gate.
// A test runs several watchers back to back; one run is capped at 25 s below.
vi.setConfig({ testTimeout: 120_000 });
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

const ROOT = join(import.meta.dirname, '../../..');
const BOARD = join(ROOT, 'scripts/board');
const LIMITS = JSON.parse(readFileSync(join(BOARD, 'limits.json'), 'utf8'));
const REAL_DATE = ['/usr/bin/date', '/bin/date'].find(existsSync)!;
const MiB = 1048576;
const at = (iso: string) => Date.parse(iso) / 1000; // ISO with -08:00
const T10 = at('2026-11-17T10:00:00-08:00');

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
type Run = {
  status: number | null;
  pid: number | undefined;
  quiet: boolean;
  tick: number;
  stdout: string;
  stderr: string;
  dir: string;
};

// A fake root: tick 0's files at the root, tick n's under ticks/<n>/ (applied by the n-th sleep).
function fake(t0: number, ticks: Files[]) {
  const dir = tmp('watch-');
  const put = (base: string, files: Files) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(base, p, '..'), { recursive: true });
      writeFileSync(join(base, p), text);
    }
  };
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/sleep'), SLEEP, { mode: 0o755 });
  writeFileSync(join(dir, 'bin/date'), DATE, { mode: 0o755 });
  mkdirSync(join(dir, 'board'));
  mkdirSync(join(dir, 'usage'));
  writeFileSync(join(dir, 'clock'), `${t0}\n`);
  writeFileSync(join(dir, 'tick'), '0\n');
  writeFileSync(join(dir, 'nticks'), `${ticks.length}\n`);
  put(dir, ticks[0] ?? {});
  ticks.slice(1).forEach((f, i) => {
    mkdirSync(join(dir, 'ticks', String(i + 1)), { recursive: true }); // an empty tick still ticks
    put(join(dir, 'ticks', String(i + 1)), f);
  });
  return dir;
}

// Always the fake's own board dir, so no test ever meets the live watchers' locks.
const envOf = (dir: string): NodeJS.ProcessEnv => ({
  PATH: `${dir}/bin:${process.env.PATH}`,
  HOME: process.env.HOME,
  TZ: 'PST8',
  WATCH_FAKE: dir,
  APERTURE_BOARD_DIR: join(dir, 'board'), // the usage dir follows it: <board>/../usage
  APERTURE_CGROUP_DIR: join(dir, 'cg'),
  APERTURE_LOADAVG: join(dir, 'loadavg'),
});

function run(dir: string, script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync('bash', [join(BOARD, script), ...args], {
    encoding: 'utf8',
    timeout: 25_000,
    killSignal: 'SIGKILL', // a hung watcher must never read as the shim's SIGTERM
    env: { ...envOf(dir), ...env },
  });
  return {
    status: r.status,
    pid: r.pid,
    // quiet: killed by the shim once every tick ran, and nothing on stderr on the way
    quiet:
      r.signal === 'SIGTERM' &&
      !r.error &&
      r.stderr === '' &&
      readFileSync(join(dir, 'tick'), 'utf8') === readFileSync(join(dir, 'nticks'), 'utf8'),
    tick: Number(readFileSync(join(dir, 'tick'), 'utf8')),
    stdout: r.stdout,
    stderr: r.stderr,
    dir,
  };
}

const read = (r: Run, p: string) => readFileSync(join(r.dir, p), 'utf8');
const json = (r: Run, p: string) => JSON.parse(read(r, p));
const lines = (r: Run, p: string) => read(r, p).trim().split('\n');
const hist = (r: Run, series: string) =>
  readdirSync(join(r.dir, 'board/history')).filter((f) => f.startsWith(`${series}-`));

// ---- pace ----
type Sample = { anon?: number; cores?: number; psiCpu?: number; psiMem?: number; l5?: number };
type PaceTick = Sample & { ctl?: object; queue?: object; files?: Files };
const DEF: Required<Sample> = { anon: 5000, cores: 1, psiCpu: 2, psiMem: 0, l5: 3 };

// ticks[0] is the state before the first sleep (the watcher's baseline cpu.stat); ticks[1..] are samples.
function paceFake(t0: number, n: number, at: (i: number) => PaceTick = () => ({})) {
  let usage = 0;
  const ticks: Files[] = [];
  for (let i = 0; i <= n; i++) {
    const t = at(i);
    const s = { ...DEF, ...t };
    if (i > 0) usage += Math.round(s.cores * 60 * 1e6);
    const f: Files = {
      'cg/cpu.stat': `usage_usec ${usage}\nuser_usec 0\n`,
      'cg/memory.stat': `anon ${s.anon * MiB}\nfile 0\n`,
      'cg/cpu.pressure': `some avg10=${s.psiCpu.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`,
      'cg/memory.pressure': `some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=${s.psiMem.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`,
      loadavg: `${s.l5} ${s.l5} ${s.l5} 1/700 4242\n`,
      ...t.files,
    };
    if (t.ctl) f['board/pace-control.json'] = JSON.stringify(t.ctl);
    if (t.queue) f['board/queue.json'] = JSON.stringify(t.queue);
    ticks.push(f);
  }
  return fake(t0, ticks);
}
const pace = (t0: number, n: number, at?: (i: number) => PaceTick) =>
  run(paceFake(t0, n, at), 'pace-watch.sh');
const all = (t: PaceTick) => (i: number) => (i === 0 ? { ...t } : t); // the same reading every tick
const hot = (since: number, extra: object = {}) => ({
  state: 'hot',
  since,
  held: [],
  triggers: [],
  ...extra,
});
const ready = { autoStart: [{ branch: 'a' }], devQueue: [] };

describe('pace-watch.sh', () => {
  it('trips on anon at the 3-sample floor, not before, and not at 1 MiB under', () => {
    const r = pace(T10, 6, all({ anon: 10800 }));
    expect([r.status, r.tick]).toEqual([3, 3]);
    expect(r.stdout).toMatch(/^10:03 calm · anon avg 10800\.00 .* · TRIP memory\n$/);
    expect(read(r, 'board/pace-watch.log')).toContain('TRIP memory');
    expect(pace(T10, 6, all({ anon: 10799 })).quiet).toBe(true);
  });

  it('trips on memory PSI full above psiMemFullMax (strictly)', () => {
    expect(pace(T10, 6, all({ psiMem: 1.01 }))).toMatchObject({ status: 3, tick: 3 });
    expect(pace(T10, 6, all({ psiMem: 1 })).quiet).toBe(true);
  });

  it('trips on CPU only after 5 minutes held: cores, then CPU PSI', () => {
    // hot from the floor (tick 3), held 300 s → tick 8
    const r = pace(T10, 10, all({ cores: 8.5 }));
    expect([r.status, r.tick]).toEqual([3, 8]);
    expect(r.stdout).toContain('TRIP cpu (5 min)');
    expect(pace(T10, 7, all({ cores: 8.5 })).quiet).toBe(true);
    expect(pace(T10, 10, all({ psiCpu: 40 }))).toMatchObject({ status: 3, tick: 8 });
    expect(pace(T10, 10, all({ cores: 8.4, psiCpu: 39.9 })).quiet).toBe(true);
  });

  it('restarts the CPU hold when the average cools', () => {
    // 9 cores, one idle tick at 7: the 5-sample average sits at 7.2 from tick 7 to 11, hot again at 12, so the hold
    // restarts there and trips at 17 (an un-reset hold from tick 3 would trip at 12)
    const cool = (i: number) => ({ cores: i === 7 ? 0 : 9 });
    expect(pace(T10, 16, cool).quiet).toBe(true);
    expect(pace(T10, 20, cool)).toMatchObject({ status: 3, tick: 17 });
  });

  it('restarts the CPU hold after a hot spell the hub ends', () => {
    // hold from tick 3; the hub marks it hot at 5 and calm at 7: the hold restarts at 7 and trips at 12 (one carried
    // over from tick 3 would trip at 8)
    const r = pace(T10, 15, (i) => ({
      cores: 9,
      ...(i === 5 && { ctl: hot(T10 + 300) }),
      ...(i === 7 && { ctl: { state: 'calm', since: T10 + 420 } }),
    }));
    expect([r.status, r.tick]).toEqual([3, 12]);
  });

  it('while hot: a lane trigger exits 5 before recovery is judged', () => {
    const ctl = hot(T10, { triggers: [{ lane: 'x', load5Below: 20 }] });
    const r = pace(T10, 6, all({ ctl, l5: 15 }));
    expect([r.status, r.tick]).toEqual([5, 3]);
    expect(r.stdout).toContain('TRIGGER x');
    expect(json(r, 'board/pace.json').state).toBe('hot'); // the hub's state reaches the gate's file
    expect(pace(T10, 6, all({ ctl, l5: 25 })).quiet).toBe(true);
    // load5 5 would also recover, but not before 10 min: the trigger still wins at the floor
    expect(pace(T10, 6, all({ ctl: { ...ctl, since: T10 - 3000 }, l5: 5 }))).toMatchObject({
      status: 5,
      tick: 3,
    });
  });

  it('recovers after 10 min hot once load5 and anon are under their lines', () => {
    const r = pace(T10, 8, all({ ctl: hot(T10 - 300) }));
    expect([r.status, r.tick]).toEqual([0, 5]); // 300 + 5 × 60 = 600 s since the trip
    expect(r.stdout).toContain('hot · anon avg 5000.00');
    expect(r.stdout).toContain('RECOVERED');
    expect(pace(T10, 4, all({ ctl: hot(T10 - 300) })).quiet).toBe(true);
    expect(pace(T10, 8, all({ ctl: hot(T10 - 300), l5: 12 })).quiet).toBe(true);
    expect(pace(T10, 8, all({ ctl: hot(T10 - 300), anon: 9000 })).quiet).toBe(true);
  });

  it('exits 4 after an hour hot', () => {
    const r = pace(T10, 6, all({ ctl: hot(T10 - 3420), l5: 30 }));
    expect([r.status, r.tick]).toEqual([4, 3]);
    expect(r.stdout).toContain('HOT 60 min');
    expect(pace(T10, 3, all({ ctl: hot(T10 - 3360), l5: 30 })).quiet).toBe(true);
  });

  it('a since that isn’t a whole past epoch: a fraction floors, milliseconds or a string count as 0', () => {
    expect(pace(T10, 8, all({ ctl: hot(T10 - 299.5) }))).toMatchObject({ status: 0, tick: 5 });
    expect(pace(T10, 6, all({ ctl: hot(T10 * 1000), l5: 30 }))).toMatchObject({
      status: 4,
      tick: 3,
    });
    expect(pace(T10, 6, all({ ctl: hot('yesterday' as unknown as number), l5: 30 }))).toMatchObject(
      {
        status: 4,
        tick: 3,
      },
    );
  });

  it('a trigger needs a numeric load5Below; a state that isn’t a string keeps the last view', () => {
    const ctl = (t: object) => hot(T10, { triggers: [t] });
    expect(pace(T10, 6, all({ ctl: ctl({ lane: 'x', load5Below: '20' }), l5: 15 })).quiet).toBe(
      true,
    );
    expect(pace(T10, 6, all({ ctl: ctl({ lane: 'x', load5Below: 20 }), l5: 15 }))).toMatchObject({
      status: 5,
    });
    // hot, then the file loses its state: still hot, so anon over the trip line doesn't trip
    const r = pace(T10, 6, (i) => ({
      anon: 11000,
      l5: 30,
      ...(i === 0 && { ctl: hot(T10) }),
      ...(i === 2 && { ctl: { since: T10 } }),
    }));
    expect(r.quiet).toBe(true);
  });

  it('a missing cgroup file is a skipped tick, not a line of stderr every minute', () => {
    const d = paceFake(T10, 3);
    for (const base of ['', 'ticks/1/', 'ticks/2/', 'ticks/3/'])
      rmSync(join(d, base, 'cg/memory.stat'));
    const r = run(d, 'pace-watch.sh');
    expect(r.quiet).toBe(true); // quiet includes an empty stderr
    expect(existsSync(join(d, 'board/pace.json'))).toBe(false);
  });

  it('an empty or torn pace-control.json keeps the last view: hot stays hot', () => {
    // hot from tick 0; the file is caught empty from tick 2 on; anon over the trip line would trip a calm reading
    const r = pace(T10, 6, (i) => ({
      anon: 11000,
      l5: 30,
      ...(i === 0 && { ctl: hot(T10) }),
      ...(i === 2 && { files: { 'board/pace-control.json': '' } }),
    }));
    expect(r.quiet).toBe(true);
    expect(json(r, 'board/pace.json').state).toBe('hot');
    // no file at all is calm
    expect(pace(T10, 6, all({ anon: 11000 }))).toMatchObject({ status: 3, tick: 3 });
  });

  it('exits 6 on 10 min of idle with a ready lane, and stamps idle-fired', () => {
    const r = pace(T10, 15, all({ queue: ready }));
    expect([r.status, r.tick]).toEqual([6, 13]); // idle from the floor (tick 3), held 600 s
    expect(r.stdout).toContain('IDLE ready=a');
    expect(read(r, 'board/idle-fired').trim()).toBe(String(T10 + 13 * 60));
    expect(pace(T10, 12, all({ queue: ready })).quiet).toBe(true);
  });

  it('idle only from 07:00: quiet at 06:53, fires at 07:00 and at 09:03, never from 05:00', () => {
    const r = pace(at('2026-11-17T06:40:00-08:00'), 25, all({ queue: ready }));
    expect([r.status, r.tick]).toEqual([6, 20]);
    expect(r.stdout).toMatch(/^07:00 /);
    const nine = pace(at('2026-11-17T08:50:00-08:00'), 15, all({ queue: ready })); // "09" is not octal
    expect([nine.status, nine.tick]).toEqual([6, 13]);
    expect(nine.stdout).toMatch(/^09:03 /);
    expect(pace(at('2026-11-17T05:00:00-08:00'), 20, all({ queue: ready })).quiet).toBe(true);
  });

  it('idle skips LOW and HOLD notes and lanes whose `after` is still queued', () => {
    const q = (autoStart: object[], devQueue: object[] = []) =>
      all({ queue: { autoStart, devQueue } });
    const low = [
      { branch: 'a', note: 'LOW later' },
      { branch: 'b', note: 'HOLD for x' },
    ];
    expect(pace(T10, 15, q(low)).quiet).toBe(true);
    expect(pace(T10, 15, q([...low, { branch: 'c', note: 'next' }])).stdout).toContain(
      'IDLE ready=c\n',
    );
    const after = [{ branch: 'b', after: ['a'] }];
    expect(pace(T10, 15, q(after, [{ branch: 'a' }])).quiet).toBe(true);
    expect(pace(T10, 15, q([{ branch: 'a', note: 'HOLD' }, ...after])).quiet).toBe(true);
    expect(pace(T10, 15, q(after))).toMatchObject({ status: 6, tick: 13 });
  });

  it('idle fires at most once per 30 min, and needs calm, load5 and anon held throughout', () => {
    const last = { files: { 'board/idle-fired': `${T10 - 1000}\n` } };
    expect(pace(T10, 13, all({ queue: ready, ...last })).quiet).toBe(true); // 780 + 1000 < 1800
    expect(pace(T10, 15, all({ queue: ready, ...last }))).toMatchObject({ status: 6, tick: 14 });
    // an unreadable idle-fired counts as never fired
    expect(pace(T10, 15, all({ queue: ready, files: { 'board/idle-fired': '\n' } }))).toMatchObject(
      { tick: 13 },
    );
    // idle-level readings while hot (the hub re-stamps since each tick, so it never recovers): never idle
    expect(pace(T10, 15, (i) => ({ queue: ready, ctl: hot(T10 + 60 * i) })).quiet).toBe(true);
    expect(pace(T10, 20, (i) => ({ queue: ready, l5: i === 8 ? 9 : 3 }))).toMatchObject({
      status: 6,
      tick: 19,
    });
    expect(pace(T10, 15, all({ queue: ready, anon: 8000 })).quiet).toBe(true);
  });

  it('writes pace.json and a vm-pace history line every tick; mac-load only with mac-stats.json', () => {
    const r = pace(T10, 7);
    expect(r.quiet).toBe(true);
    const p = json(r, 'board/pace.json');
    // the fields the start gate reads (scripts/src/lane/pace.ts)
    expect(p).toEqual({
      state: 'calm',
      heartbeat: T10 + 7 * 60,
      pid: expect.any(Number),
      samples: 5,
      avg: { anonMiB: 5000, cores: 1, psiCpu: 2 },
      psiMemFull: 0,
      load5: 3,
    });
    expect(hist(r, 'vm-pace')).toEqual(['vm-pace-2026-11-17.jsonl']);
    const h = lines(r, 'board/history/vm-pace-2026-11-17.jsonl').map((l) => JSON.parse(l));
    expect(h.map((x) => x.samples)).toEqual([1, 2, 3, 4, 5, 5, 5]);
    expect(h[0].t).toBe('2026-11-17T10:01:00-08:00');
    expect(hist(r, 'mac-load')).toEqual([]);
    // what the watcher writes, the start gate passes (scripts/src/lane/pace.ts)
    expect(
      paceReasons(read(r, 'board/pace.json'), null, null, p.heartbeat * 1000, PACE_DEFAULTS, 'b'),
    ).toEqual([]);
    const mac = JSON.stringify({ t: 'x', load: [1, 2, 3], cpus: 12, mem: { freePct: 30 } });
    const m = pace(T10, 2, all({ files: { 'board/mac-stats.json': mac } }));
    const ml = lines(m, 'board/history/mac-load-2026-11-17.jsonl').map((l) => JSON.parse(l));
    // an agent from before power (PR 198) reports none: the row says null, never drops the key
    expect(ml).toEqual([
      {
        t: 'x',
        mac: [1, 2, 3],
        cpus: 12,
        memFreePct: 30,
        vm: '3',
        power: null,
        vmCpuPct: null,
        top: null,
        sim: null,
        jobs: null,
      },
      {
        t: 'x',
        mac: [1, 2, 3],
        cpus: 12,
        memFreePct: 30,
        vm: '3',
        power: null,
        vmCpuPct: null,
        top: null,
        sim: null,
        jobs: null,
      },
    ]);
    // the power reading rides along whole: battery, Low Power Mode and thermal told apart in history (F120)
    const power = {
      source: 'battery',
      batteryPct: 41,
      state: 'discharging',
      remainingMin: 95,
      lowPowerMode: true,
      thermal: { warningLevel: null, cpuSpeedLimit: 80 },
    };
    const withPower = JSON.stringify({ ...JSON.parse(mac), power });
    const p2 = pace(T10, 1, all({ files: { 'board/mac-stats.json': withPower } }));
    expect(lines(p2, 'board/history/mac-load-2026-11-17.jsonl').map((l) => JSON.parse(l))).toEqual([
      {
        t: 'x',
        mac: [1, 2, 3],
        cpus: 12,
        memFreePct: 30,
        vm: '3',
        power,
        vmCpuPct: null,
        top: null,
        sim: null,
        jobs: null,
      },
    ]);
  });

  it('mac-load rows carry the agent’s top, VM cpu and sim flag, and the mailroom jobs the Mac is running', () => {
    const mac = JSON.stringify({
      t: 'x',
      load: [1, 2, 3],
      cpus: 12,
      mem: { freePct: 30 },
      vm: { pid: 1, rssMiB: 2, comm: 'v', cpuPct: 312.4 },
      top: [{ comm: 'Safari', cpuPct: 19.7 }],
      sim: false,
    });
    const dir = paceFake(T10, 1, all({ files: { 'board/mac-stats.json': mac } }));
    const hj = join(dir, 'hostjobs');
    // the first row is 10:01 PST = 18:01Z. A running job: a result dir with no result.json, touched (picked up, or a
    // heartbeat renamed inside it) in the last 15 min — whenever its id was stamped
    const now = T10 + 60;
    const job = (id: string, ageSec: number, done = false) => {
      const d = join(hj, 'results', id);
      mkdirSync(d, { recursive: true });
      if (done) writeFileSync(join(d, 'result.json'), '{}');
      utimesSync(d, now - ageSec, now - ageSec);
    };
    job('20261117T175500Z-ios-lane-ab12', 300);
    job('20261117T173000Z-fx-lane-cd34', 840); // stamped 31 min ago, picked up 14 min ago: running
    job('20261117T180000Z-edit-lane-ef56', 60);
    job('20261117T175000Z-lane-done-0001', 60, true);
    job('20261117T170000Z-ios-stale-0002', 960); // untouched for 16 min: abandoned, not running
    job('20261116T235900Z-ios-yesterday-0003', 60); // stamped on a day outside the window
    mkdirSync(join(hj, 'inbox'));
    writeFileSync(join(hj, 'inbox', 'q.json'), '{}');
    const r = run(dir, 'pace-watch.sh', [], { APERTURE_HOSTJOBS: hj });
    expect(lines(r, 'board/history/mac-load-2026-11-17.jsonl').map((l) => JSON.parse(l))).toEqual([
      {
        t: 'x',
        mac: [1, 2, 3],
        cpus: 12,
        memFreePct: 30,
        vm: '3',
        power: null,
        vmCpuPct: 312.4,
        top: [{ comm: 'Safari', cpuPct: 19.7 }],
        sim: false, // false stays false (not jq's `// null`)
        jobs: { ios: 1, fx: 1, other: 1, queued: 1 },
      },
    ]);
  });

  it('mailroom jobs across UTC midnight: an id stamped on the day before still counts', () => {
    const t0 = at('2026-11-17T16:05:00-08:00'); // the row is 00:06Z on 11-18
    const dir = paceFake(t0, 1, all({ files: { 'board/mac-stats.json': '{"t":"x"}' } }));
    const hj = join(dir, 'hostjobs');
    const job = (id: string) => {
      const d = join(hj, 'results', id);
      mkdirSync(d, { recursive: true });
      utimesSync(d, t0, t0);
    };
    job('20261117T235800Z-ios-lane-ab12');
    job('20261118T000100Z-fx-lane-cd34');
    const r = run(dir, 'pace-watch.sh', [], { APERTURE_HOSTJOBS: hj });
    const [row] = lines(r, 'board/history/mac-load-2026-11-17.jsonl').map((l) => JSON.parse(l));
    expect(row.jobs).toEqual({ ios: 1, fx: 1, other: 0, queued: 0 });
  });

  it('a history day follows local time, not UTC', () => {
    const r = pace(at('2026-11-17T23:59:00-08:00'), 2);
    expect(hist(r, 'vm-pace')).toEqual(['vm-pace-2026-11-18.jsonl']);
  });

  it.each([
    ['loadavg', { loadavg: 'garbage\n' }],
    ['memory PSI', { 'cg/memory.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n' }],
    ['CPU PSI', { 'cg/cpu.pressure': '' }],
    ['anon', { 'cg/memory.stat': 'file 0\n' }],
  ])(
    'an unreadable %s skips the tick: no pace.json, no history — the gate fails closed',
    (_, files) => {
      const r = pace(T10, 3, (i) => ({ anon: 11000, ...(i > 0 && { files }) }));
      expect(r.quiet).toBe(true);
      expect(existsSync(join(r.dir, 'board/pace.json'))).toBe(false);
      expect(existsSync(join(r.dir, 'board/history'))).toBe(true);
      expect(hist(r, 'vm-pace')).toEqual([]);
    },
  );

  it('takes no arguments', () => {
    const r = run(fake(T10, []), 'pace-watch.sh', ['--help']);
    expect([r.status, r.stderr]).toEqual([2, expect.stringContaining('usage: pace-watch.sh')]);
  });
});

describe('pace-watch.sh: the hard stop (exit 12)', () => {
  // stop.json, the stop's own file (board stop writes it): pace-control.json's hand rewrites never touch it
  const stop = (stopAt: unknown, more: Record<string, string> = {}) => ({
    files: { 'board/stop.json': JSON.stringify({ v: 1, stopAt }), ...more },
  });
  const st = T10 + 15 * 60; // 10:15: exit 12 ten minutes ahead, at the 10:05 tick

  it("STOP_LEAD is away.ts's STOP_LEAD_SEC (the CLI's line names the time pace-watch fires)", () => {
    expect(readFileSync(join(BOARD, 'pace-watch.sh'), 'utf8')).toContain(
      `STOP_LEAD=${STOP_LEAD_SEC} `,
    );
  });
  it('a stopAt in pace-control.json is not the stop: only stop.json fires', () => {
    expect(
      pace(T10, 8, all({ ctl: { state: 'calm', since: 0, held: [], triggers: [], stopAt: st } }))
        .quiet,
    ).toBe(true);
    // a calm/hot rewrite of pace-control.json beside a set stop still fires it
    expect(pace(T10, 8, (i) => ({ ...stop(st), ctl: hot(T10 + i) }))).toMatchObject({
      status: 12,
      tick: 5,
    });
  });

  it('exits 12 STOP_LEAD ahead of stopAt, before the sample floor and on a bad reading', () => {
    const r = pace(T10, 8, (i) => stop(st, i === 5 ? { 'cg/memory.stat': 'garbled' } : {}));
    expect([r.status, r.tick]).toEqual([12, 5]);
    expect(r.stdout).toBe('10:05 STOP at 10:15: hard stop, lanes stop clean by then\n');
    expect(read(r, 'board/stop-fired').trim()).toBe(String(st));
    expect(pace(T10, 4, all(stop(st))).quiet).toBe(true);
  });
  it('fires once per stopAt: a restarted watcher stays quiet, a new time fires again', () => {
    const fired = { 'board/stop-fired': `${st}\n` };
    expect(pace(T10, 8, all(stop(st, fired))).quiet).toBe(true);
    expect(pace(T10, 8, all(stop(st + 60, fired)))).toMatchObject({
      status: 12,
      tick: 6,
    });
  });
  it('an unwritable stop-fired exits 74, naming the stop that is due, never 12 on every restart', () => {
    const d = paceFake(T10, 8, all(stop(st)));
    const sf = join(d, 'board', 'stop-fired');
    mkdirSync(sf); // a read-only directory: the read fails, and sb_write's mv into it fails too
    chmodSync(sf, 0o555);
    const r = run(d, 'pace-watch.sh');
    expect([r.status, r.tick]).toEqual([74, 5]);
    expect(r.stdout).toBe('10:05 STOP at 10:15 is due, but stop-fired is unwritable\n');
  });
  it('a stop over an hour past, a garbled stopAt or none never fires', () => {
    expect(pace(T10, 4, all(stop(T10 - 3600))).quiet).toBe(true);
    expect(pace(T10, 4, all(stop(T10 - 3500)))).toMatchObject({ status: 12, tick: 1 }); // late, still within the hour
    for (const bad of ['10:15', null, -5, { at: st }])
      expect(pace(T10, 8, all(stop(bad))).quiet).toBe(true);
    expect(pace(T10, 8, all({ files: { 'board/stop.json': '{' } })).quiet).toBe(true);
    expect(pace(T10, 8, all({})).quiet).toBe(true);
  });
});

// ---- usage ----
const ts = (epoch: number) =>
  new Date((epoch - 8 * 3600) * 1000).toISOString().slice(0, 19) + '-08:00'; // local -08:00, as the logger writes
const meterRow = (epoch: number, pct: number, name = 's', ctx?: object) =>
  JSON.stringify({
    ts: ts(epoch),
    name,
    rl: { seven_day: { used_percentage: pct } },
    ...(ctx && { ctx }),
  });
const meter = (rows: string[]) => ({ 'usage/meter-2026-11-17.jsonl': rows.join('\n') + '\n' });
const usage = (ticks: Files[], args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  run(fake(T10, ticks), 'usage-watch.sh', args, env);

describe('usage-watch.sh', () => {
  it('under the soft line: quiet, and usage-now.json carries the reading and both lines', () => {
    const r = usage([meter([meterRow(T10 - 30, 57)])]);
    expect(r).toMatchObject({ quiet: true, tick: 1 });
    expect(json(r, 'board/usage-now.json')).toEqual({ pct: 57, at: T10, soft: 58, hard: 60 });
  });

  it('exits 7 at the soft line, 8 at the hard line (hard checked first)', () => {
    const soft = usage([meter([meterRow(T10 - 30, 58)])]);
    expect([soft.status, soft.tick, soft.stdout]).toEqual([7, 0, '10:00 SOFT 58\n']);
    expect(read(soft, 'board/usage-watch.log')).toBe('10:00 SOFT 58\n');
    expect(usage([meter([meterRow(T10 - 30, 59.5)])]).status).toBe(7);
    const hard = usage([meter([meterRow(T10 - 30, 57), meterRow(T10 - 20, 60)])]);
    expect([hard.status, hard.stdout]).toEqual([8, '10:00 HARD 60\n']);
  });

  it('--hard-only skips the soft line; SOFT / HARD in the env override limits.json', () => {
    expect(usage([meter([meterRow(T10 - 30, 59)])], ['--hard-only']).quiet).toBe(true);
    expect(usage([meter([meterRow(T10 - 30, 60)])], ['--hard-only']).status).toBe(8);
    expect(usage([meter([meterRow(T10 - 30, 20)])], [], { APERTURE_USAGE_SOFT: '13' }).status).toBe(
      7,
    );
    expect(usage([meter([meterRow(T10 - 30, 20)])], [], { APERTURE_USAGE_HARD: '20' }).status).toBe(
      8,
    );
    expect(usage([meter([meterRow(T10 - 30, 20)])], [], { SOFT: '13' }).quiet).toBe(true); // a generic name is ignored
    expect(usage([], ['--soft']).status).toBe(2);
    expect(usage([], [], { APERTURE_USAGE_SOFT: 'x' }).status).toBe(2);
  });

  it('ignores rows older than freshSec; a row that lands later is seen at the next check', () => {
    const stale = usage([meter([meterRow(T10 - 601, 61)])]);
    expect(stale.quiet).toBe(true);
    expect(existsSync(join(stale.dir, 'board/usage-now.json'))).toBe(false);
    expect(usage([meter([meterRow(T10 - 590, 61)])]).status).toBe(8);
    const later = usage([{}, {}, meter([meterRow(T10 + 100, 61)]), {}]);
    expect([later.status, later.tick]).toEqual([8, 2]);
  });

  it('no meter file is quiet; a torn last line hides nothing', () => {
    expect(usage([{}, {}]).quiet).toBe(true);
    // a row of the wrong shape is dropped alone, not the whole reading
    const odd = [JSON.stringify({ ts: 5, rl: 1 }), JSON.stringify({ ts: ts(T10), rl: 'x' })];
    expect(usage([meter([...odd, meterRow(T10 - 30, 59)])]).status).toBe(7);
    const torn = {
      'usage/meter-2026-11-17.jsonl': meterRow(T10 - 30, 59) + '\n{"ts":"2026-11-17T09:59:5',
    };
    expect(usage([torn]).status).toBe(7);
  });

  it('reads the two newest meter files (a fresh row can sit in yesterday’s)', () => {
    const r = usage([
      {
        'usage/meter-2026-11-15.jsonl': meterRow(T10 - 30, 99) + '\n',
        'usage/meter-2026-11-16.jsonl': meterRow(T10 - 30, 58) + '\n',
        'usage/meter-2026-11-17.jsonl': meterRow(T10 - 30, 20) + '\n',
      },
    ]);
    expect([r.status, r.stdout]).toEqual([7, '10:00 SOFT 58\n']);
  });
});

// ---- context ----
const tok = (n: number) => ({
  input_tokens: 2,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: n - 2,
});
const ctxRow = (epoch: number, name: string, tokens: number) =>
  meterRow(epoch, 30, name, tok(tokens));
const context = (ticks: Files[], env: NodeJS.ProcessEnv = {}) =>
  run(fake(T10, ticks), 'context-watch.sh', [], env);
const alerted = (o: object) => ({ 'board/ctx-alerted.json': JSON.stringify(o) });

describe('context-watch.sh', () => {
  it('writes ctx.json sorted by pct, a history line, and exits 9 for a session at urgent', () => {
    const r = context([meter([ctxRow(T10 - 60, 'b', 300_000), ctxRow(T10 - 30, 'a', 510_000)])]);
    expect([r.status, r.tick, r.stdout]).toEqual([9, 0, '10:00 URGENT a 51%\n']);
    expect(json(r, 'board/ctx.json')).toEqual([
      { name: 'a', ts: '09:59', tokens: 510_000, pct: 51 },
      { name: 'b', ts: '09:59', tokens: 300_000, pct: 30 },
    ]);
    expect(json(r, 'board/ctx-alerted.json')).toEqual({ a: T10 });
    const h = lines(r, 'board/history/ctx-2026-11-17.jsonl').map((l) => JSON.parse(l));
    expect(h).toEqual([{ t: '2026-11-17T10:00:00-08:00', sessions: json(r, 'board/ctx.json') }]);
    expect(read(r, 'board/context-watch.log')).toBe('10:00 URGENT a 51%\n');
  });

  it('alerts a session once per realertSec (strictly after), and stays quiet in between', () => {
    const rows = meter([ctxRow(T10 - 30, 'a', 510_000)]);
    const q = context([{ ...rows, ...alerted({ a: T10 - 3600 }) }, {}, {}]);
    expect(q).toMatchObject({ quiet: true, tick: 3 });
    expect(lines(q, 'board/history/ctx-2026-11-17.jsonl')).toHaveLength(3); // one per check, every 300 s
    expect(context([{ ...rows, ...alerted({ a: T10 - 21600 }) }]).quiet).toBe(true);
    expect(context([{ ...rows, ...alerted({ a: T10 - 21601 }) }]).status).toBe(9);
  });

  it('a newly urgent session alerts alone and leaves the others’ timers alone', () => {
    const r = context([
      {
        ...meter([ctxRow(T10 - 30, 'a', 600_000), ctxRow(T10 - 30, 'c', 500_000)]),
        ...alerted({ a: T10 - 60 }),
      },
    ]);
    expect([r.status, r.stdout]).toEqual([9, '10:00 URGENT c 50%\n']);
    expect(json(r, 'board/ctx-alerted.json')).toEqual({ a: T10 - 60, c: T10 });
  });

  it('stale rows are dropped, the latest row per session wins, a corrupt alerted file still alerts', () => {
    const stale = context([meter([ctxRow(T10 - 700, 'a', 900_000)])]);
    expect(stale.quiet).toBe(true);
    expect(json(stale, 'board/ctx.json')).toEqual([]);
    const later = context([
      meter([ctxRow(T10 - 200, 'a', 900_000), ctxRow(T10 - 100, 'a', 100_000)]),
    ]);
    expect(later.quiet).toBe(true);
    expect(json(later, 'board/ctx.json')).toEqual([
      { name: 'a', ts: '09:58', tokens: 100_000, pct: 10 },
    ]);
    const corrupt = context([
      { ...meter([ctxRow(T10 - 30, 'a', 510_000)]), 'board/ctx-alerted.json': '{nope' },
    ]);
    expect(corrupt.status).toBe(9);
    expect(json(corrupt, 'board/ctx-alerted.json')).toEqual({ a: T10 });
  });

  it('two sessions urgent at once alert together, both stamped', () => {
    const r = context([meter([ctxRow(T10 - 30, 'c', 500_000), ctxRow(T10 - 30, 'a', 600_000)])]);
    expect([r.status, r.stdout]).toEqual([9, '10:00 URGENT a 60%, c 50%\n']);
    expect(json(r, 'board/ctx-alerted.json')).toEqual({ a: T10, c: T10 });
  });

  it('a row of the wrong shape is dropped alone', () => {
    const odd = [
      JSON.stringify({ ts: ts(T10 - 30), name: 'x', ctx: 'big' }),
      JSON.stringify({ ts: ts(T10 - 30), name: 7, ctx: tok(900_000) }),
    ];
    const r = context([meter([...odd, ctxRow(T10 - 30, 'a', 510_000)])]);
    expect([r.status, json(r, 'board/ctx.json').map((e: { name: string }) => e.name)]).toEqual([
      9,
      ['a'],
    ]);
  });

  it('APERTURE_CTX_URGENT / _WINDOW in the env override limits.json; a bad one is exit 2', () => {
    const rows = [meter([ctxRow(T10 - 30, 'a', 300_000)])];
    expect(context(rows, { APERTURE_CTX_URGENT: '30' }).status).toBe(9);
    expect(context(rows, { APERTURE_CTX_WINDOW: '500000' }).stdout).toBe('10:00 URGENT a 60%\n');
    expect(context(rows, { WINDOW: '1' }).quiet).toBe(true); // screen's WINDOW is ignored
    expect(context(rows, { APERTURE_CTX_WINDOW: '0' }).status).toBe(2);
    expect(usage([], ['--hard-only', 'x']).status).toBe(2);
    expect(run(fake(T10, []), 'context-watch.sh', ['x']).status).toBe(2);
  });
});

// ---- the meter gone blind (exit 13) ----
// A live working session: this test process, with its real start tick (sb_alive checks both).
const startTick = (pid: number) =>
  readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]!;
const session = (o: object = {}, file = `${process.pid}`) => ({
  [`board/sessions/${file}.json`]: JSON.stringify({
    pid: process.pid,
    pidStart: startTick(process.pid),
    state: 'working',
    name: 'lane-a',
    ...o,
  }),
});
const blank = (n: number): Files[] => Array.from({ length: n }, () => ({}));
const OLD = meterRow(T10 - 9000, 30); // a usable row 2.5 h old at the start: 07:30
const old = meter([OLD]);
const stale = (first: Files, n = 12, args: string[] = []) => usage([first, ...blank(n - 1)], args);
const deadPid = () => spawnSync('true').pid!;
const fired = (r: Run) => read(r, 'board/meter-stale-fired');

describe('usage-watch.sh: the meter gone blind (13)', () => {
  it('no usable row for staleSec while a session works: 13 after freshSec of blind ticks', () => {
    const r = stale({ ...old, ...session() });
    expect([r.status, r.tick, r.stdout]).toEqual([
      13,
      10,
      '10:10 METER STALE last usable row 11-17 07:30, working: lane-a\n',
    ]);
    expect(fired(r)).toBe(`${T10 + 600}\n`);
    expect(read(r, 'board/usage-watch.log')).toContain('10:10 METER STALE last usable row');
    // a row exactly staleSec old at tick 12 fires there; one second newer, a tick later
    const edge = stale({ ...meter([meterRow(T10 + 720 - 7200, 30)]), ...session() }, 14);
    expect([edge.status, edge.tick]).toEqual([13, 12]);
    const newer = stale({ ...meter([meterRow(T10 + 721 - 7200, 30)]), ...session() }, 14);
    expect([newer.status, newer.tick]).toEqual([13, 13]);
    const hard = stale({ ...old, ...session() }, 12, ['--hard-only']);
    expect([hard.status, hard.tick]).toEqual([13, 10]);
  });

  it('nothing working: quiet, whatever the session files say', () => {
    for (const s of [
      {},
      session({ state: 'idle' }),
      session({ pid: deadPid() }),
      session({ pidStart: '1' }),
      session({ pidStart: undefined }), // no start tick: sb_alive would pass a bare live pid
      session({ pidStart: '' }),
      session({ state: 'gone' }),
    ])
      expect(stale({ ...old, ...s }, 14).quiet, JSON.stringify(s)).toBe(true);
  });

  it('a healed blind spell does not arm the next pause: a reading resets the hold', () => {
    const r = usage([
      { ...old, ...session() },
      ...blank(8),
      meter([OLD, meterRow(T10 + 540, 30)]), // tick 9: a reading
      { clock: `${T10 + 600 + 8 * 3600}\n` }, // tick 10: the VM slept 8 h
      ...blank(5),
    ]);
    expect(r.quiet).toBe(true);
  });

  it('a pause is not an outage: the hold counts ticks, not the clock', () => {
    const wake = T10 + 60 + 8 * 3600;
    const r = usage([
      { ...meter([meterRow(T10 - 30, 30)]), ...session() },
      { clock: `${wake}\n` }, // tick 1: every row is 8 h old
      {},
      meter([meterRow(T10 - 30, 30), meterRow(wake + 120, 30)]), // tick 3: the lane's logger writes
      ...blank(4),
    ]);
    expect(r.quiet).toBe(true);
  });

  it('a session with no name still counts, as ?', () => {
    for (const name of ['', null])
      expect(stale({ ...old, ...session({ name }) }).stdout, String(name)).toBe(
        '10:10 METER STALE last usable row 11-17 07:30, working: ?\n',
      );
  });

  it('a bad session file hides nothing and counts for nothing', () => {
    const torn = stale({ ...old, 'board/sessions/1.json': '{"pid":1,"sta', ...session() });
    expect([torn.status, torn.tick]).toEqual([13, 10]);
    for (const text of [
      '[1]',
      '5',
      'null',
      JSON.stringify({ pid: `${process.pid}`, pidStart: startTick(process.pid), state: 'working' }),
    ])
      expect(stale({ ...old, 'board/sessions/9.json': text }, 14).quiet, text).toBe(true);
  });

  it('rows without a weekly % are not a reading, and do not make the meter fresh', () => {
    const rows = [
      OLD,
      JSON.stringify({ ts: ts(T10 - 30), name: 's', rl: null }),
      JSON.stringify({ ts: ts(T10 - 20), name: 's', rl: { five_hour: { used_percentage: 3 } } }),
    ];
    const r = stale({ ...meter(rows), ...session() });
    expect([r.status, r.tick]).toEqual([13, 10]);
    expect(r.stdout).toContain('last usable row 11-17 07:30');
    // newest-first across both files: a usable row in yesterday's file still counts
    const two = stale(
      {
        'usage/meter-2026-11-16.jsonl': `${meterRow(T10 - 3600, 30)}\n`,
        ...meter(rows.slice(1)),
        ...session(),
      },
      13,
    );
    expect(two.quiet).toBe(true);
  });

  it("the row's own offset sets its age; a ts of another shape is dropped alone", () => {
    const row = (t: unknown) =>
      JSON.stringify({ ts: t, name: 's', rl: { seven_day: { used_percentage: 30 } } });
    const east = stale({ ...meter([row('2026-11-17T09:30:00-05:00')]), ...session() }); // 06:30 here, 3.5 h old
    expect([east.status, east.tick]).toEqual([13, 10]);
    expect(east.stdout).toContain('last usable row 11-17 06:30');
    const west = stale({ ...meter([row('2026-11-17T06:30:00-10:00')]), ...session() }, 13); // 08:30 here
    expect(west.quiet).toBe(true);
    const bad = [
      row('2026-11-17T05:00:00Z'),
      row('2026-11-17T05:00:00'),
      row('2026-00-17T05:00:00-08:00'),
      row(5),
    ];
    const alone = stale({ ...meter(bad), ...session() });
    expect([alone.status, alone.stdout]).toEqual([
      13,
      '10:10 METER STALE no usable row in the two newest meter files, working: lane-a\n',
    ]);
    expect(
      stale({ ...meter([...bad, row('2026-11-17T08:30:00-08:00')]), ...session() }, 13).quiet,
    ).toBe(true);
  });

  it('at most one 13 per staleSec, across both meter watchers (meter-stale-fired)', () => {
    const m = (v: string | number) => ({ 'board/meter-stale-fired': `${v}\n` });
    expect(stale({ ...old, ...session(), ...m(T10 - 100) }).quiet).toBe(true);
    const due = stale({ ...old, ...session(), ...m(T10 + 600 - 7200) });
    expect([due.status, due.tick, fired(due)]).toEqual([13, 10, `${T10 + 600}\n`]);
    const younger = stale({ ...old, ...session(), ...m(T10 + 601 - 7200) });
    expect([younger.status, younger.tick]).toEqual([13, 11]);
    expect(stale({ ...old, ...session(), ...m('garbage') }).tick).toBe(10);
    const octal = stale({ ...old, ...session(), ...m('089') }); // octal to $((…))
    expect([octal.status, octal.tick]).toEqual([13, 10]);
    expect(stale({ ...old, ...session(), ...m(T10 + 99999) }).tick).toBe(10);
    // restarted after its 13, it stays quiet
    writeFileSync(join(due.dir, 'tick'), '0\n');
    writeFileSync(join(due.dir, 'clock'), `${T10 + 600}\n`);
    expect(run(due.dir, 'usage-watch.sh').quiet).toBe(true);
    // the marker usage-watch wrote keeps context-watch quiet too
    const ctx = context([
      { ...meter([meterRow(T10 - 30, 30)]), ...session(), ...m(T10) },
      ...blank(3),
    ]);
    expect(ctx.quiet).toBe(true);
  });

  // root writes through the mode bit: the container user and CI's runner aren't root
  it.skipIf(process.getuid?.() === 0)(
    'an unwritable marker is 74 with the line, never 13 on every restart',
    () => {
      const d = fake(T10, [{ ...old, ...session() }, ...blank(11)]);
      mkdirSync(join(d, 'board/meter-stale-fired'));
      chmodSync(join(d, 'board/meter-stale-fired'), 0o555);
      const r = run(d, 'usage-watch.sh');
      expect([r.status, r.stdout]).toEqual([
        74,
        '10:10 METER STALE last usable row 11-17 07:30, but meter-stale-fired is unwritable\n',
      ]);
    },
  );

  it('no meter file at all: 13 only when a session works', () => {
    const r = stale(session());
    expect([r.status, r.tick, r.stdout]).toEqual([
      13,
      10,
      '10:10 METER STALE no usable row in the two newest meter files, working: lane-a\n',
    ]);
    expect(stale({}, 14).quiet).toBe(true);
  });
});

describe('context-watch.sh: the meter gone blind (13)', () => {
  it('13 by the same rule, on its own usable test (a ctx object and a name)', () => {
    const noCtx = meter([meterRow(T10 - 30, 30)]); // fresh, with a weekly %, but no ctx
    const r = context([{ ...noCtx, ...session() }, ...blank(3)]);
    expect([r.status, r.tick, r.stdout]).toEqual([
      13,
      2,
      '10:10 METER STALE no usable row in the two newest meter files, working: lane-a\n',
    ]);
    expect(json(r, 'board/ctx.json')).toEqual([]);
    expect(context([noCtx, ...blank(4)]).quiet).toBe(true);
    const urgent = context([
      { ...meter([ctxRow(T10 - 30, 'a', 600000)]), ...session() },
      ...blank(3),
    ]);
    expect([urgent.status, urgent.tick]).toEqual([9, 0]);
    const nameless = JSON.stringify({ ...JSON.parse(ctxRow(T10 - 30, 'a', 1000)), name: 5 });
    const n = context([{ ...meter([nameless]), ...session() }, ...blank(3)]);
    expect([n.status, n.tick]).toEqual([13, 2]);
  });
});

// ---- the singleton lock (exit 73) ----
const REAL_SLEEP = ['/usr/bin/sleep', '/bin/sleep'].find(existsSync)!;
// A holder's sleep: records its pid, then becomes a real 30 s sleep, so the holder sits in it.
const HOLD_SLEEP = `#!/bin/bash
echo $$ >"$WATCH_FAKE/sleeper"
exec ${REAL_SLEEP} 30
`;
const WATCHERS = {
  'pace-watch.sh': () => paceFake(T10, 3),
  'usage-watch.sh': () => fake(T10, [meter([meterRow(T10 - 30, 20)]), {}]),
  'context-watch.sh': () => fake(T10, [meter([ctxRow(T10 - 30, 'a', 1000)]), {}]),
  'merge-watch.sh': () => fake(T10, [{}, {}]),
} as const;
type W = keyof typeof WATCHERS;
const kill = (pid: number | undefined, sig: NodeJS.Signals = 'SIGKILL') => {
  try {
    if (pid) process.kill(pid, sig);
  } catch {
    /* gone already */
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidOf = (dir: string, w: W) =>
  readFileSync(join(dir, `board/${w.replace('.sh', '')}.pid`), 'utf8');

// Starts a copy of the watcher that sits in a real sleep holding the lock; resolves once it is there.
async function holder(dir: string, w: W) {
  mkdirSync(join(dir, 'hbin'), { recursive: true });
  writeFileSync(join(dir, 'hbin/sleep'), HOLD_SLEEP, { mode: 0o755 });
  writeFileSync(join(dir, 'hbin/date'), DATE, { mode: 0o755 });
  const p = spawn('bash', [join(BOARD, w)], {
    stdio: 'ignore',
    env: { ...envOf(dir), PATH: `${dir}/hbin:${process.env.PATH}` },
  });
  const exited = new Promise<void>((res) => p.once('exit', () => res()));
  const sleeperOf = () =>
    Number(existsSync(join(dir, 'sleeper')) && readFileSync(join(dir, 'sleeper'), 'utf8'));
  for (let i = 0; i < 200 && !sleeperOf(); i++) await new Promise((r) => setTimeout(r, 50));
  const sleeper = sleeperOf();
  if (!sleeper) {
    kill(p.pid);
    throw new Error(`${w}: the holder never reached its sleep`);
  }
  return { pid: p.pid!, sleeper, exited };
}

describe('the singleton lock (73)', () => {
  it('a second copy is refused with the holder’s pid, before it writes any state', async () => {
    const hs: { pid: number; sleeper: number }[] = [];
    try {
      for (const w of Object.keys(WATCHERS) as W[]) {
        const dir = WATCHERS[w]();
        const h = await holder(dir, w);
        hs.push(h);
        rmSync(join(dir, 'board/ctx-alerted.json'), { force: true });
        rmSync(join(dir, 'board/merge-announced'), { force: true });
        rmSync(join(dir, 'board/pace.json'), { force: true });
        rmSync(join(dir, 'board/usage-now.json'), { force: true });
        const r = run(dir, w, w === 'usage-watch.sh' ? ['--hard-only'] : []);
        expect(r.status, w).toBe(73);
        expect(r.stderr, w).toMatch(new RegExp(`already running as pid ${h.pid} `));
        expect(read(r, `board/${w.replace('.sh', '')}.log`), w).toContain(
          `already running as pid ${h.pid}`,
        );
        expect(pidOf(dir, w).trim(), w).toBe(String(h.pid));
        expect(existsSync(join(dir, 'board/ctx-alerted.json')), w).toBe(false);
        expect(existsSync(join(dir, 'board/merge-announced')), w).toBe(false);
        expect(existsSync(join(dir, 'board/pace.json')), w).toBe(false);
        expect(existsSync(join(dir, 'board/usage-now.json')), w).toBe(false);
      }
    } finally {
      hs.forEach((h) => (kill(h.pid), kill(h.sleeper)));
    }
  });

  it('a copy stopped by pid frees the lock at once, though its sleep lives on', async () => {
    for (const w of Object.keys(WATCHERS) as W[]) {
      const dir = WATCHERS[w]();
      const h = await holder(dir, w);
      try {
        kill(h.pid, 'SIGTERM');
        await h.exited;
        expect(alive(h.sleeper), w).toBe(true);
        const r = run(dir, w);
        expect([r.quiet, r.stderr], w).toEqual([true, '']);
        expect(pidOf(dir, w).trim(), w).toBe(String(r.pid));
      } finally {
        kill(h.pid);
        kill(h.sleeper);
      }
    }
  });

  it('a dead copy’s lock and pid files are taken over, even when the pid now names a live process', () => {
    for (const w of Object.keys(WATCHERS) as W[])
      for (const pid of [deadPid(), process.pid]) {
        const dir = WATCHERS[w]();
        const n = w.replace('.sh', '');
        writeFileSync(join(dir, `board/${n}.lock`), '');
        writeFileSync(join(dir, `board/${n}.pid`), `${pid}\n`);
        const r = run(dir, w);
        expect(r.quiet, `${w} ${pid}`).toBe(true);
        expect(pidOf(dir, w).trim(), w).toBe(String(r.pid));
      }
  });

  it('a holder that lets go within the 2 s wait: the new copy starts', async () => {
    const dir = WATCHERS['usage-watch.sh']();
    const lock = join(dir, 'board/usage-watch.lock');
    const h = spawn('bash', ['-c', 'exec 9>>"$0" && flock 9 && exec sleep 1', lock], {
      stdio: 'ignore',
    });
    try {
      for (let i = 0; i < 100 && spawnSync('flock', ['-n', lock, 'true']).status !== 1; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(1);
      const r = run(dir, 'usage-watch.sh');
      expect([r.quiet, r.stderr]).toEqual([true, '']);
      expect(pidOf(dir, 'usage-watch.sh').trim()).toBe(String(r.pid));
    } finally {
      kill(h.pid);
    }
  });

  it.skipIf(process.getuid?.() === 0)('lock faults are 74, never 73, and no tick runs', () => {
    const asDir = WATCHERS['usage-watch.sh']();
    mkdirSync(join(asDir, 'board/usage-watch.lock'));
    const a = run(asDir, 'usage-watch.sh');
    expect([a.status, a.tick]).toEqual([74, 0]);
    expect(a.stderr).toMatch(/cannot open .*usage-watch\.lock/);

    const shim = WATCHERS['usage-watch.sh']();
    writeFileSync(join(shim, 'bin/flock'), '#!/bin/bash\nexit 66\n', { mode: 0o755 });
    const b = run(shim, 'usage-watch.sh');
    expect([b.status, b.tick]).toEqual([74, 0]);
    expect(b.stderr).toMatch(/flock failed \(66\)/);

    const ro = WATCHERS['usage-watch.sh']();
    mkdirSync(join(ro, 'board/usage-watch.pid'));
    chmodSync(join(ro, 'board/usage-watch.pid'), 0o555);
    const c = run(ro, 'usage-watch.sh');
    expect([c.status, c.tick]).toEqual([74, 0]);
    expect(c.stderr).toMatch(/cannot write .*usage-watch\.pid/);
  });
});

// ---- all three ----
function limitsWithout(path: readonly string[]) {
  const l = structuredClone(LIMITS);
  let o = l;
  for (const k of path.slice(0, -1)) o = o[k];
  delete o[path.at(-1)!];
  const f = join(tmp('limits-'), 'limits.json');
  writeFileSync(f, JSON.stringify(l));
  return f;
}

describe('limits.json and the scripts themselves', () => {
  const keys = (w: string) => Object.keys(LIMITS.watchers[w]).map((k) => ['watchers', w, k]);
  it.each([
    ...keys('pace').map((p) => ['pace-watch.sh', p] as const),
    ...['psiMemFullMax', 'psiCpuBelow', 'anonMiBBelow', 'minSamples'].map(
      (k) => ['pace-watch.sh', ['pace', k]] as const,
    ),
    ...keys('usage').map((p) => ['usage-watch.sh', p] as const),
    ...keys('context').map((p) => ['context-watch.sh', p] as const),
  ])('%s exits 78 naming a missing key (%j)', (script, path) => {
    const r = run(fake(T10, []), script, [], { APERTURE_LIMITS_JSON: limitsWithout(path) });
    expect(r.status).toBe(78);
    expect(r.stderr).toContain(`limits.json .${path.join('.')} missing`);
  });

  it('a bad value is 78 too: a fractional interval, an hour past 23, a flag above urgent', () => {
    const bad = (edit: (l: typeof LIMITS) => void) => {
      const l = structuredClone(LIMITS);
      edit(l);
      const f = join(tmp('limits-'), 'limits.json');
      writeFileSync(f, JSON.stringify(l));
      return { APERTURE_LIMITS_JSON: f };
    };
    const go = (script: string, edit: (l: typeof LIMITS) => void) =>
      run(fake(T10, []), script, [], bad(edit));
    expect(go('usage-watch.sh', (l) => (l.watchers.usage.intervalSec = 1.5)).status).toBe(78);
    expect(go('pace-watch.sh', (l) => (l.watchers.pace.idleFromHour = 24)).status).toBe(78);
    expect(go('pace-watch.sh', (l) => (l.pace.minSamples = 6)).status).toBe(78); // above windowSamples
    expect(go('context-watch.sh', (l) => (l.watchers.context.windowTokens = 0)).status).toBe(78);
    const flag = go('context-watch.sh', (l) => (l.watchers.context.flagPct = 60));
    expect([flag.status, flag.stderr]).toEqual([
      78,
      expect.stringContaining('flagPct 60 is above urgentPct 50'),
    ]);
  });

  it('wake lines say the configured hold and hour', () => {
    const lim = (edit: (l: typeof LIMITS) => void) => {
      const l = structuredClone(LIMITS);
      edit(l);
      const f = join(tmp('limits-'), 'limits.json');
      writeFileSync(f, JSON.stringify(l));
      return { APERTURE_LIMITS_JSON: f };
    };
    const cpu = run(
      paceFake(T10, 8, all({ cores: 9 })),
      'pace-watch.sh',
      [],
      lim((l) => (l.watchers.pace.tripCpuHoldSec = 120)),
    );
    expect([cpu.status, cpu.tick]).toEqual([3, 5]);
    expect(cpu.stdout).toContain('TRIP cpu (2 min)');
    const hour = run(
      paceFake(T10, 6, all({ ctl: hot(T10 - 1620), l5: 30 })),
      'pace-watch.sh',
      [],
      lim((l) => (l.watchers.pace.hotExitSec = 1800)),
    );
    expect([hour.status, hour.tick, hour.stdout]).toEqual([
      4,
      3,
      expect.stringContaining('HOT 30 min'),
    ]);
  });

  it('ships the maintainer’s thresholds', () => {
    expect(LIMITS.watchers).toEqual({
      pace: {
        intervalSec: 60,
        windowSamples: 5,
        tripAnonMiB: 10800,
        tripCores: 8.5,
        tripCpuHoldSec: 300,
        recoverLoad5Below: 12,
        recoverMinSec: 600,
        hotExitSec: 3600,
        idleLoad5Below: 8,
        idleAnonMiBBelow: 8000,
        idleHoldSec: 600,
        idleFromHour: 7,
        idleEverySec: 1800,
      },
      usage: { softPct: 58, hardPct: 60, intervalSec: 60, freshSec: 600, staleSec: 7200 },
      context: {
        flagPct: 40,
        urgentPct: 50,
        windowTokens: 1000000,
        intervalSec: 300,
        realertSec: 21600,
        freshSec: 600,
        staleSec: 7200,
      },
    });
    // the four the trip shares with the start gate
    expect(LIMITS.pace).toMatchObject({
      psiMemFullMax: 1,
      psiCpuBelow: 40,
      anonMiBBelow: 9000,
      minSamples: 3,
    });
  });

  it('every watcher is executable (a sed -i once dropped the bit: exit 126)', () => {
    for (const s of ['pace-watch.sh', 'usage-watch.sh', 'context-watch.sh', 'merge-watch.sh'])
      expect(statSync(join(BOARD, s)).mode & 0o111, s).toBe(0o111);
  });
});
