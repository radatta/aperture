// The perf fields (docs/ops/SESSION-BOARD.md → Perf fields): sample.awk on canned input, sampler.sh's reads and its
// RTT probe, and heavy.sh's job-event fields in a temp git repo — everything that feeds the next fit.
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BOARD = fileURLToPath(new URL('../../board/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GiB = 1073741824;
vi.setConfig({ testTimeout: 20_000 }); // bash + git + jq cold starts; slower beside a gate (board-cli.test.ts)

let tmp: string;
let env: NodeJS.ProcessEnv;
// /proc/1/stat with start tick `start` (field 22) — the container's init, whose start marks a container restart
const init = (start: number) =>
  `1 (init) S 0 1 1 0 -1 4194560 1 2 0 0 0 0 0 0 20 0 1 0 ${start} 1000 100\n`;
// how many tsc -b projects lib.sh knows (heavy.sh's cache.tsc.of)
const TSB_COUNT = Number(
  spawnSync('bash', ['-c', `. ${join(BOARD, 'lib.sh')}; echo "\${#SB_TSBUILDINFO[@]}"`], {
    encoding: 'utf8',
  }).stdout.trim(),
);

function put(files: Record<string, string>) {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(tmp, p, '..'), { recursive: true });
    writeFileSync(join(tmp, p), t);
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'perf-'));
  const rest = { ...process.env };
  for (const k of ['CLAUDE_PID', 'TMUX', 'TMUX_PANE', 'VITEST_MAX_WORKERS']) delete rest[k];
  for (const k of Object.keys(rest)) if (k.startsWith('HEAVY_')) delete rest[k];
  put({
    'cg/memory.stat': `anon ${2 * GiB}\nfile 104857600\n`,
    'cg/memory.current': `${2 * GiB}\n`,
    'cg/memory.high': `${18 * GiB}\n`,
    'cg/memory.events': 'high 0\noom_kill 0\n',
    'cg/memory.pressure': 'some avg10=0.00\nfull avg10=0.00\n',
    'cg/cpu.pressure': 'some avg10=0.00\n',
    'cg/cpu.stat': 'usage_usec 1000\n',
    'cg/cpu.max': '900000 100000\n',
    'cg/pids.current': '300\n',
    'cg/pids.max': '4096\n',
    'proc/stat': 'cpu  100 0 50 1000 0 0 0 700 0 0\ncpu0 100 0 50 1000 0 0 0 700 0 0\n',
    'proc/loadavg': '6.14 4.71 7.60 3/1316 4242\n',
    'proc/uptime': '901098.44 7000000.00\n',
    'proc/sys/kernel/random/boot_id': 'aaaa-1\n',
    'proc/1/stat': init(5000),
  });
  writeFileSync(join(tmp, 'limits.json'), readFileSync(join(BOARD, 'limits.json')));
  env = {
    ...rest,
    APERTURE_BOARD_DIR: join(tmp, 'board'),
    APERTURE_BOARD_LOCK: join(tmp, 'lock'),
    APERTURE_CGROUP_DIR: join(tmp, 'cg'),
    APERTURE_LIMITS_JSON: join(tmp, 'limits.json'),
    APERTURE_PROC_DIR: join(tmp, 'proc'),
    APERTURE_SAMPLER_PREV: join(tmp, 'prev'),
  };
});

// ---- sample.awk: per-category CPU, the VM's side, the probe's reading ----

// One tick of sample.awk over canned inputs; procs are "pid ppid comm thr rssPages cpuTicks args own start".
function awkTick(prev: string, procs: string[], v: Record<string, string | number> = {}) {
  const f = (n: string, t: string) => (writeFileSync(join(tmp, n), t), join(tmp, n));
  const files = [f('panes', ''), f('sess', ''), f('slots', ''), f('prevIn', prev)];
  const vars = {
    t: 'T',
    ep: 1030,
    epr: '1030.000000',
    interval: 30,
    page: 4096,
    hz: 100,
    anon: 0,
    file: 0,
    current: 0,
    high: 18 * GiB,
    pids: 1,
    pidsMax: 4096,
    usage: 9_000_000, // 0.30 cores over the 30 s since the prev tick's usage 0
    cpus: 9,
    prevOut: join(tmp, 'prevOut'),
    statusOut: join(tmp, 'status'),
    F1: files[0]!,
    F2: files[1]!,
    F3: files[2]!,
    F4: files[3]!,
    ...v,
  };
  const r = spawnSync(
    'awk',
    [
      '-f',
      join(BOARD, 'sample.awk'),
      ...Object.entries(vars).flatMap(([k, x]) => ['-v', `${k}=${x}`]),
      ...files,
      '-',
    ],
    { input: procs.map((l) => `${l.split(' ').join('\t')}\n`).join(''), encoding: 'utf8' },
  );
  expect(r.stderr).toBe('');
  return { j: JSON.parse(r.stdout), prevOut: readFileSync(join(tmp, 'prevOut'), 'utf8') };
}

const PREV = ['T\t1000\t0\t1000.000000\t500', 'P\t10\t5\t100', 'P\t11\t9\t999'].join('\n') + '\n';
// claude (pid 10) ran 300 own ticks since the last tick; pid 11 is a reused pid (start 7, not 9): all of its 50 count;
// pid 12 is new: all of its 60. cpuTicks (col 6) counts reaped children and is not what's summed.
const PROCS = [
  '10 1 claude 10 100 99999 claude 400 5',
  '11 10 node 4 100 99999 node.vitest/vitest.mjs 50 7',
  '12 10 tsc 2 100 99999 tsc 60 12',
];

describe('sample.awk perf fields', () => {
  it('per-category CPU from own ticks per pid + start, the unseen rest, steal, load, run queue, uptime and net', () => {
    const { j, prevOut } = awkTick(PREV, PROCS, {
      steal: 800,
      load1: '6.14',
      runq: 3,
      upSec: 901098,
      net: '1020 0.040 0.0604 0.150 301', // seconds, as curl gives them
    });
    expect(j.cats.claude.cpu).toBe(0.1); // 300 / 100 Hz / 30 s
    expect(j.cats.vitest.cpu).toBe(0.02); // 50 / 3000
    expect(j.cats.tsc.cpu).toBe(0.02);
    expect(j.cats.pnpm.cpu).toBe(0);
    expect(j.cats.unseen.cpu).toBe(0.16); // 0.30 cgroup − 0.1367 seen
    expect(j.cg.cpuCores).toBe(0.3);
    expect(j.sys).toEqual({ steal: 0.1, load1: 6.14, run: 3, upSec: 901098 });
    expect(j.net).toEqual({ ageSec: 10, dnsMs: 40, connMs: 60, ttfbMs: 150, code: 301 });
    // the next tick's base: T carries steal, one P line per process with its start tick
    expect(prevOut.split('\n')).toEqual(
      expect.arrayContaining([
        'T\t1030\t9000000\t1030.000000\t800',
        'P\t10\t5\t400',
        'P\t11\t7\t50',
        'P\t12\t12\t60',
      ]),
    );
  });

  it('nulls, never zeros, when a reading is missing: first tick, an older lib.sh or sampler.sh, a stale probe', () => {
    // no P lines (a first tick, or a prev from before them): cpu unknown
    expect(awkTick('T\t1000\t0\t1000.000000\n', PROCS, { steal: 800 }).j).toMatchObject({
      cats: { claude: { cpu: null }, unseen: { cpu: null } },
      sys: { steal: null },
    });
    // an older lib.sh's procs (no own/start columns) and an older sampler.sh (no -v perf inputs)
    const old = awkTick(
      PREV,
      PROCS.map((l) => l.split(' ').slice(0, 7).join(' ')),
    ).j;
    expect(old.cats.claude.cpu).toBeNull();
    expect(old.sys).toEqual({ steal: null, load1: null, run: null, upSec: null });
    expect(old.net).toBeNull();
    // a probe reading over 90 s old, or from the future, or torn
    for (const net of ['900 0.04 0.06 0.15 301', '2000 0.04 0.06 0.15 301', '1020 0.04'])
      expect(awkTick(PREV, PROCS, { net }).j.net).toBeNull();
    // no answer: code 0, no times
    expect(awkTick(PREV, PROCS, { net: '1020 - - - 0' }).j.net).toEqual({
      ageSec: 10,
      dnsMs: null,
      connMs: null,
      ttfbMs: null,
      code: 0,
    });
    // a steal counter that went backwards (a reset) is unknown, not negative
    expect(awkTick(PREV, PROCS, { steal: 100 }).j.sys.steal).toBeNull();
  });
});

// ---- sampler.sh: the reads, and the probe ----

const sampler = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
  spawnSync('bash', [join(BOARD, 'sampler.sh'), ...args], {
    env: { ...env, ...extra },
    cwd: tmp,
    encoding: 'utf8',
  });
const lastSample = () => {
  const d = join(tmp, 'board/history');
  const f = readdirSync(d).find((n) => n.startsWith('samples-'))!;
  return JSON.parse(readFileSync(join(d, f), 'utf8').trim().split('\n').at(-1)!);
};
// The probe's curl, as an exported function: a shim FILE whose path ends in that name, under /tmp, trips COI's rule
// (docs/ops/COI-INCIDENTS.md → Incident H); a function never shows on a command line.
const net = () => readFileSync(join(tmp, 'prev.net'), 'utf8');
// the last probe's stamp moved `sec` back, past the probe's own floor
const age = (sec: number) =>
  writeFileSync(
    join(tmp, 'prev.net'),
    net().replace(/^\d+/, (t) => String(Number(t) - sec)),
  );
const curlFn = (out: string, rc = 0) => ({
  'BASH_FUNC_curl%%': `() { printf '%s' '${out}'; return ${rc}; }`,
  APERTURE_PROBE_HOST: 'dev.example.test',
});

describe('sampler.sh perf fields', () => {
  it('two ticks: the VM side from /proc, per-category CPU from the second, real processes', () => {
    expect(sampler(['--once']).status).toBe(0);
    const first = lastSample();
    expect(first.sys).toEqual({ steal: null, load1: 6.14, run: 3, upSec: 901098 });
    expect(first.cats.claude.cpu).toBeNull();
    expect(readFileSync(join(tmp, 'prev'), 'utf8')).toMatch(/^T\t\d+\t1000\t[\d.]+\t700$/m);
    // a P line is the process's own pid, start tick (stat field 22) and utime + stime (14, 15)
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      sampler(['--once']);
      const st = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
      expect(readFileSync(join(tmp, 'prev'), 'utf8')).toContain(
        `P\t${child.pid}\t${st[19]}\t${Number(st[11]) + Number(st[12])}\n`,
      );
    } finally {
      child.kill();
    }
    put({ 'proc/stat': 'cpu  100 0 50 1000 0 0 0 730 0 0\n', 'cg/cpu.stat': 'usage_usec 2000\n' });
    expect(sampler(['--once']).status).toBe(0);
    const s = lastSample();
    expect(typeof s.cats.other.cpu).toBe('number');
    expect(typeof s.sys.steal).toBe('number');
    expect(s.net).toBeNull(); // no probe has run
  });

  it('--probe writes the edge redirect’s timings, which the next tick reads in ms', () => {
    const r = sampler(['--probe'], curlFn('301 0.034 0.150 0.175 Redirect from cloudfront'));
    expect(r.status).toBe(0);
    expect(net()).toMatch(/^\d+ 0.034 0.150 0.175 301\n$/);
    sampler(['--once']);
    expect(lastSample().net).toMatchObject({ dnsMs: 34, connMs: 150, ttfbMs: 175, code: 301 });
  });

  it('one probe per 25 s whatever the tick; after no answer, one per 5 min', () => {
    sampler(['--probe'], curlFn('301 0.034 0.150 0.175 Redirect from cloudfront'));
    const first = net();
    sampler(['--probe'], curlFn('301 0.5 0.5 0.5 Redirect from cloudfront')); // too soon: no call
    expect(net()).toBe(first);
    age(26);
    sampler(['--probe'], curlFn('000 0 0 0 ', 28)); // no answer
    expect(net()).toMatch(/ - - - 0\n$/);
    age(60);
    sampler(['--probe'], curlFn('301 0.5 0.5 0.5 Redirect from cloudfront'));
    expect(net()).toMatch(/ - - - 0\n$/); // backing off
    age(301);
    sampler(['--probe'], curlFn('301 0.5 0.5 0.5 Redirect from cloudfront'));
    expect(net()).toMatch(/ 0.5 0.5 0.5 301\n$/);
  });

  it('no answer is code 0; an answer that isn’t the edge redirect turns the probe off, loudly', () => {
    sampler(['--probe'], curlFn('000 0 0 0 ', 28));
    expect(net()).toMatch(/^\d+ - - - 0\n$/);
    age(400);
    const r = sampler(['--probe'], curlFn('200 0.01 0.02 0.30 Hit from cloudfront'));
    expect(r.stderr).toMatch(/probe off — .* answered 200, x-cache 'Hit from cloudfront'/);
    expect(existsSync(join(tmp, 'prev.net.off'))).toBe(true);
    expect(readFileSync(join(tmp, 'prev.net'), 'utf8')).toMatch(/ - - - 0\n$/); // the last reading stands, then ages out
    // off stays off: the next probe doesn't call out at all
    age(400);
    const again = sampler(['--probe'], curlFn('301 0.034 0.150 0.175 Redirect from cloudfront'));
    expect(again.stderr).toBe('');
    expect(readFileSync(join(tmp, 'prev.net'), 'utf8')).toMatch(/ - - - 0\n$/);
  });

  it('never probes off the real board, nor prod, nor a host that isn’t a hostname; a bad flag is usage', () => {
    const prod = JSON.parse(readFileSync(join(ROOT, 'identifiers.json'), 'utf8')).domains.prod;
    sampler(['--probe'], {
      ...curlFn('301 0 0 0 Redirect from cloudfront'),
      APERTURE_PROBE_HOST: prod,
    });
    expect(existsSync(join(tmp, 'prev.net'))).toBe(false);
    const u = sampler(['--prob']);
    expect(u.status).toBe(2);
    expect(u.stderr).toMatch(/^usage: sampler.sh/);
    // a fake board and no APERTURE_PROBE_HOST: no host, so nothing runs even with curl answering
    sampler(['--probe'], {
      'BASH_FUNC_curl%%': "() { printf '301 0 0 0 Redirect from cloudfront'; }",
    });
    expect(existsSync(join(tmp, 'prev.net'))).toBe(false);
    sampler(['--probe'], {
      ...curlFn('301 0 0 0 Redirect from cloudfront'),
      APERTURE_PROBE_HOST: 'x/y',
    });
    expect(existsSync(join(tmp, 'prev.net'))).toBe(false);
  });
});

// ---- heavy.sh: cache state, slot wait, boot, the detail dir ----

// heavy.sh's cache dir: each <kind>.last's stamp (which must exist), how many start.<pid> stamps, anything else
function cacheDir(dir: string) {
  const d = join(dir, 'node_modules/.cache/aperture-heavy');
  const names = readdirSync(d);
  const last: Record<string, string> = {};
  for (const n of names.filter((n) => n.endsWith('.last'))) {
    const ref = readFileSync(join(d, n), 'utf8').trim().split(' ')[1]!;
    expect(names).toContain(ref);
    last[n.replace('.last', '')] = ref;
  }
  const stamps = names.filter((n) => /^start\.\d+\.\d+$/.test(n)).length;
  return {
    last,
    stamps,
    other: names.filter((n) => !n.endsWith('.last') && !/^start\.\d+\.\d+$/.test(n)),
  };
}

function gitRepo() {
  const dir = join(tmp, 'repo');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'lane');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  for (const f of ['a.ts', 'c.ts', 'r.ts']) writeFileSync(join(dir, f), 'export {};\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  return { dir, git, sha: () => git('rev-parse', 'HEAD').stdout.trim() };
}

function heavy(cmd: string, extra: NodeJS.ProcessEnv = {}, cwd = tmp) {
  const r = spawnSync('bash', [join(BOARD, 'heavy.sh'), '--', 'bash', '-c', cmd], {
    env: { ...env, ...extra },
    cwd,
    encoding: 'utf8',
  });
  const d = join(tmp, 'board/history');
  const f = readdirSync(d).find((n) => n.startsWith('events-'))!;
  const jobs = readFileSync(join(d, f), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'job');
  return { code: r.status, err: r.stderr, ev: jobs.at(-1) };
}

const TSB = 'app/node_modules/.tmp/tsconfig.app.tsbuildinfo';
const writeTsb = `mkdir -p app/node_modules/.tmp && echo x >${TSB}`;

describe('heavy.sh perf fields', () => {
  it('typecheck cache: a cold first run, a warm one, then the files changed since', async () => {
    const { dir, git, sha } = gitRepo();
    const tc = { HEAVY_CLASS: 'typecheck' };
    const one = heavy(writeTsb, tc, dir).ev;
    expect(one.cache).toEqual({
      sha: sha(),
      tsc: {
        lastSha: null,
        lastAgeSec: null,
        first: true,
        changed: null,
        changedSrc: null,
        changedCfg: null,
        of: TSB_COUNT,
        existed: 0,
        rewritten: 1,
      },
      cold: true,
    });
    const settle = () => new Promise((r) => setTimeout(r, 1100)); // mtime granularity on some filesystems
    await settle();
    // since run one: a tracked edit left uncommitted, and a tracked file deleted
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    unlinkSync(join(dir, 'c.ts'));
    const two = heavy('true', tc, dir).ev;
    expect(two.cache.tsc).toMatchObject({
      lastSha: sha(),
      first: false,
      changed: 2,
      changedSrc: 2,
      changedCfg: 0,
      existed: 1,
      rewritten: 0,
    });
    expect(two.cache.cold).toBe(true); // 1 of the buildinfo files: still a cold cache
    expect(two.cache.tsc.lastAgeSec).toBeGreaterThanOrEqual(1); // run one's stamp to run two's, a settle apart
    await settle();
    // since run two: an untracked file and a committed tsconfig. a.ts, still dirty but untouched, isn't counted again;
    // c.ts, still gone, is (the known over-count: SESSION-BOARD.md → Perf fields)
    writeFileSync(join(dir, 'b.mjs'), '');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    git('add', 'tsconfig.json');
    git('commit', '-qm', 'two');
    const three = heavy('true', tc, dir).ev;
    expect(three.cache.tsc).toMatchObject({ changed: 3, changedSrc: 2, changedCfg: 1 });
    expect(three.cache.tsc.lastSha).toBe(two.cache.sha);
    expect(three.cache.sha).toBe(sha());
    await settle();
    // since run three: a.ts touched again, and a `git mv` (the new name keeps the old mtime; the old one is missing)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    git('mv', 'r.ts', 's.ts');
    const four = heavy('true', tc, dir).ev;
    expect(four.cache.tsc).toMatchObject({ changed: 3, changedSrc: 3 }); // a.ts, r.ts, c.ts
    // four runs, and only the stamp tsc.last names plus the one before it (each run sweeps the dead and unnamed)
    expect(cacheDir(dir)).toEqual({ last: { tsc: expect.any(String) }, stamps: 2, other: [] });
  });

  it('a gate’s outer run reports both caches’ state and moves neither baseline', () => {
    const { dir } = gitRepo();
    const r = heavy(
      'echo "${HEAVY_DETAIL_DIR:-none}" >../dd.txt',
      { HEAVY_CLASS: 'gate-wide' },
      dir,
    );
    expect(r.ev.cache).toMatchObject({
      tsc: { existed: 0, first: true },
      eslint: { existed: false, first: true },
      cold: true,
    });
    expect(cacheDir(dir)).toEqual({ last: {}, stamps: 1, other: [] }); // its own start only
    expect(readFileSync(join(tmp, 'dd.txt'), 'utf8').trim()).toBe('none'); // its steps have their own
  });

  it('lint cache: eslint’s cache file before the run; gate steps count as their tool', () => {
    const { dir } = gitRepo();
    const make =
      'mkdir -p node_modules/.cache/eslint && echo x >node_modules/.cache/eslint/.eslintcache';
    const one = heavy(make, { HEAVY_CLASS: 'gate-lint' }, dir).ev;
    expect(one.cache).toMatchObject({ eslint: { existed: false, first: true }, cold: true });
    expect(one.cache.tsc).toBeUndefined();
    const two = heavy('true', { HEAVY_CLASS: 'lint' }, dir).ev; // lint and gate-lint share the one eslint cache
    expect(two.cache).toMatchObject({
      eslint: { existed: true, first: false, changed: 0 },
      cold: false,
    });
  });

  it('a stopped or signalled run doesn’t move the baseline; a failed one does', () => {
    const { dir } = gitRepo();
    const tc = { HEAVY_CLASS: 'typecheck' };
    heavy('exit 2', tc, dir);
    const last = join(dir, 'node_modules/.cache/aperture-heavy/tsc.last');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).stdout.trim();
    const l0 = readFileSync(last, 'utf8');
    expect(l0).toMatch(new RegExp(`^${head} start\\.\\d+\\.\\d+\n$`));
    heavy('kill -TERM $$', tc, dir); // the command dies of a signal
    expect(readFileSync(last, 'utf8')).toBe(l0);
    heavy('sleep 5', { ...tc, HEAVY_DURATION: '1' }, dir); // heavy.sh's own duration stop
    expect(readFileSync(last, 'utf8')).toBe(l0);
    // the signalled run's stamp is swept by the next; the named one and the last run's own stay
    expect(cacheDir(dir)).toEqual({ last: { tsc: l0.trim().split(' ')[1] }, stamps: 2, other: [] });
  });

  it('heavy.sh itself signalled doesn’t move the baseline, even when its command exits 0', () => {
    const { dir } = gitRepo();
    const tc = { HEAVY_CLASS: 'typecheck' };
    heavy('true', tc, dir);
    const last = join(dir, 'node_modules/.cache/aperture-heavy/tsc.last');
    const l0 = readFileSync(last, 'utf8');
    // the command turns TERM into exit 0; heavy.sh gets the TERM (spawnSync's timeout). Its interrupted wait makes it a
    // 143 either way: the `$sig` guard is for a signal outside that wait (before the fork, during the fold), untimeable
    const r = spawnSync(
      'bash',
      [join(BOARD, 'heavy.sh'), '--', 'bash', '-c', "trap 'exit 0' TERM; sleep 10 & wait"],
      { env: { ...env, ...tc }, cwd: dir, encoding: 'utf8', timeout: 2500, killSignal: 'SIGTERM' },
    );
    expect(r.signal ?? r.status).not.toBeNull();
    expect(readFileSync(last, 'utf8')).toBe(l0);
  });

  it('no cache field outside tsc and eslint classes, outside a git checkout, or without node_modules', () => {
    const { dir } = gitRepo();
    expect(heavy('true', { HEAVY_CLASS: 'build' }, dir).ev.cache).toBeNull();
    expect(heavy('true', { HEAVY_CLASS: 'typecheck' }).ev.cache).toBeNull(); // tmp: no .git above it
    const bare = join(tmp, 'bare');
    mkdirSync(bare);
    spawnSync('git', ['init', '-q', bare]);
    expect(heavy('true', { HEAVY_CLASS: 'typecheck' }, bare).ev.cache).toBeNull();
  });

  it('waitSec and slot; boot.first once per class until the container or the VM restarts', () => {
    const a = heavy('true', { HEAVY_CLASS: 'typecheck' }).ev;
    expect(a.waitSec).toBeGreaterThanOrEqual(0);
    expect(a.waitSec).toBeLessThan(10);
    expect(a.slot).toBe('typecheck');
    expect(a.boot).toEqual({ upSec: 901098, first: true });
    expect(heavy('true', { HEAVY_CLASS: 'typecheck' }).ev.boot.first).toBe(false);
    expect(heavy('true', { HEAVY_CLASS: 'lint' }).ev.boot.first).toBe(true); // per class
    const other = heavy('true', { HEAVY_CLASS: 'other' }).ev;
    expect(other.slot).toBeNull(); // `other` takes no slot
    // a clock step (the Mac slept) moves epoch − uptime, never pid 1's start tick: still the same container
    put({ 'proc/uptime': '30.00 1.00\n' });
    expect(heavy('true', { HEAVY_CLASS: 'typecheck' }).ev.boot).toEqual({
      upSec: 30,
      first: false,
    });
    put({ 'proc/1/stat': init(9000) }); // the container restarted
    expect(heavy('true', { HEAVY_CLASS: 'typecheck' }).ev.boot.first).toBe(true);
    expect(heavy('true', { HEAVY_CLASS: 'typecheck' }).ev.boot.first).toBe(false);
    put({ 'proc/sys/kernel/random/boot_id': 'bbbb-2\n' }); // the VM rebooted
    expect(heavy('true', { HEAVY_CLASS: 'typecheck' }).ev.boot.first).toBe(true);
    put({ 'proc/uptime': 'garbage\n', 'proc/1/stat': 'garbage\n' });
    expect(heavy('true', { HEAVY_CLASS: 'typecheck' }).ev.boot).toEqual({
      upSec: null,
      first: null,
    });
  });

  it('folds vitest-*.json lines (a bad one skipped) and devcheck.json into the event, then removes the dir', () => {
    const v = (pkg: string, files: number, wall: number, transform: number | null = 100) =>
      JSON.stringify({
        pkg,
        files,
        tests: files * 10,
        failed: 1,
        skipped: 0,
        wallMs: wall,
        ms: { transform, setup: 1, import: 200, tests: 300, environment: 4, prepare: 5 },
      });
    const dc = JSON.stringify({ tier: 'full', status: 'PASS', ms: { total: 9000, stepsMs: 8000 } });
    const cmd = [
      `echo '${v('app', 3, 5000)}' >"$HEAVY_DETAIL_DIR/vitest-1.json"`,
      `echo '${v('scripts', 2, 7000)}' >"$HEAVY_DETAIL_DIR/vitest-2.json"`,
      `echo '{"files": "torn' >"$HEAVY_DETAIL_DIR/vitest-3.json"`,
      `echo '${dc}' >"$HEAVY_DETAIL_DIR/devcheck.json"`,
      'echo "$HEAVY_DETAIL_DIR" >dir.txt',
    ].join('; ');
    const { ev } = heavy(cmd, { HEAVY_CLASS: 'test' });
    expect(ev.vitest).toEqual({
      runs: 2,
      files: 5,
      tests: 50,
      failed: 2,
      skipped: 0,
      ms: {
        wall: 7000,
        transform: 200,
        setup: 2,
        import: 400,
        tests: 600,
        environment: 8,
        prepare: 10,
      },
      pkgs: {
        app: { files: 3, tests: 30, wallMs: 5000 },
        scripts: { files: 2, tests: 20, wallMs: 7000 },
      },
    });
    expect(ev.devcheck).toEqual(JSON.parse(dc));
    // one process whose vitest moved its transform counter: the total is unknown, never a partial sum
    const nul = heavy(
      `echo '${v('app', 1, 10)}' >"$HEAVY_DETAIL_DIR/vitest-1.json"; echo '${v('cdk', 1, 10, null)}' >"$HEAVY_DETAIL_DIR/vitest-2.json"`,
      {
        HEAVY_CLASS: 'test',
      },
    ).ev;
    expect(nul.vitest.ms).toMatchObject({ transform: null, setup: 2 });
    // two objects in devcheck.json: the last
    const two = heavy(`echo '{"a":1}{"a":2}' >"$HEAVY_DETAIL_DIR/devcheck.json"`, {
      HEAVY_CLASS: 'ui',
    }).ev;
    expect(two.devcheck).toEqual({ a: 2 });
    expect(existsSync(readFileSync(join(tmp, 'dir.txt'), 'utf8').trim())).toBe(false);
    // nothing written: null, not an empty object
    expect(heavy('true', { HEAVY_CLASS: 'test' }).ev).toMatchObject({
      vitest: null,
      devcheck: null,
    });
  });

  it('a class that isn’t a plain word gets no perf fields; an inherited detail dir never reaches a tsc run', () => {
    const odd = heavy('true', { HEAVY_CLASS: 'x/../y' }).ev;
    expect(odd).not.toHaveProperty('boot');
    expect(existsSync(join(tmp, 'board/boot'))).toBe(false);
    const { dir } = gitRepo();
    heavy(
      'echo "${HEAVY_DETAIL_DIR:-none}" >../in.txt',
      { HEAVY_CLASS: 'typecheck', HEAVY_DETAIL_DIR: join(tmp, 'outer') },
      dir,
    );
    expect(readFileSync(join(tmp, 'in.txt'), 'utf8').trim()).toBe('none');
  });

  it('HEAVY_DETAIL=0 drops every perf field and sets no detail dir', () => {
    const { dir } = gitRepo();
    const r = heavy(
      'echo "${HEAVY_DETAIL_DIR:-none}" >../d.txt',
      { HEAVY_CLASS: 'typecheck', HEAVY_DETAIL: '0' },
      dir,
    );
    expect(r.code).toBe(0);
    for (const k of ['waitSec', 'slot', 'boot', 'cache', 'vitest', 'devcheck'])
      expect(r.ev).not.toHaveProperty(k);
    expect(readFileSync(join(tmp, 'd.txt'), 'utf8').trim()).toBe('none');
    expect(existsSync(join(dir, 'node_modules/.cache/aperture-heavy'))).toBe(false);
  });
});

// lib.sh's tsBuildInfoFile list is what heavy.sh's `cache.tsc.of` counts: it must name every tsc -b project's.
it('SB_TSBUILDINFO lists every tsconfig’s tsBuildInfoFile', () => {
  const r = spawnSync(
    'bash',
    ['-c', `. ${join(BOARD, 'lib.sh')}; printf '%s\\n' "\${SB_TSBUILDINFO[@]}"`],
    {
      encoding: 'utf8',
    },
  );
  const listed = r.stdout.trim().split('\n').sort();
  const tracked = spawnSync('git', ['ls-files', '*tsconfig*.json'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .flatMap((f) => {
      const m = /"tsBuildInfoFile":\s*"([^"]+)"/.exec(readFileSync(join(ROOT, f), 'utf8'));
      return m ? [join(f, '..', m[1]!)] : [];
    })
    .sort();
  expect(listed).toEqual(tracked);
});

// heavy.sh's vitest totals sum one line per vitest process: every package's config must load the teardown that writes it.
it('every vitest config loads vitest-stats.ts under heavy.sh', () => {
  const configs = spawnSync('git', ['ls-files', '*vitest.config.*'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .stdout.trim()
    .split('\n');
  expect(configs.length).toBeGreaterThanOrEqual(6);
  for (const f of configs) {
    const m = /globalSetup: process\.env\.HEAVY_DETAIL_DIR \? \['([^']+)'\] : \[\]/.exec(
      readFileSync(join(ROOT, f), 'utf8'),
    );
    expect(m, f).not.toBeNull();
    expect(join(ROOT, f, '..', m![1]!), f).toBe(join(ROOT, 'scripts/src/board/vitest-stats.ts'));
  }
});
