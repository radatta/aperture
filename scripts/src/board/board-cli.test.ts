// End-to-end over the bash layer: board.sh / heavy.sh against a temp board, a fake cgroup, and real pids.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardLine } from './tower/stale.ts';

const boardDir = fileURLToPath(new URL('../../board/', import.meta.url));
const GiB = 1073741824;
const children: ChildProcess[] = [];
afterAll(() => children.forEach((c) => c.kill()));
// Each test here is several bash + node cold starts (cli.ts decide / barriers): 0.5–1 s idle, 5 s+ when the gate
// runs beside the other packages at 9 cores — a timeout then is contention, not a bug (the maintainer, 2026-11-05).
vi.setConfig({ testTimeout: 20_000 });

let tmp: string;
let env: NodeJS.ProcessEnv;

function cgroup(pids: number, anonBytes: number) {
  const cg = join(tmp, 'cg');
  mkdirSync(cg, { recursive: true });
  const files: Record<string, string> = {
    'memory.stat': `anon ${anonBytes}\nfile 104857600\n`,
    'memory.current': `${anonBytes + 104857600}\n`,
    'memory.high': `${18 * GiB}\n`,
    'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
    'memory.pressure':
      'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    'cpu.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    'cpu.stat': 'usage_usec 1000\n',
    'cpu.max': '900000 100000\n', // 9 CPUs whatever the host has: the sampler's null bound is 1.5 × these
    'pids.current': `${pids}\n`,
    'pids.max': '4096\n',
  };
  for (const [f, v] of Object.entries(files)) writeFileSync(join(cg, f), v);
}

function limits(patch: object) {
  const l = { ...JSON.parse(readFileSync(join(boardDir, 'limits.json'), 'utf8')), ...patch };
  writeFileSync(join(tmp, 'limits.json'), JSON.stringify(l));
}

function repo(branch: string) {
  const dir = join(tmp, branch);
  mkdirSync(dir);
  spawnSync('git', ['init', '-q', '-b', branch, dir]);
  return dir;
}

// A live process to stand in for a second Claude session (start time read from its /proc/<pid>/stat).
function liveSession(): number {
  const c = spawn('sleep', ['300'], { stdio: 'ignore' });
  children.push(c);
  return c.pid!;
}
const statField = (pid: number, i: number) =>
  readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[i]!;
const stateOf = (pid: number) => statField(pid, 0);
const startOf = (pid: number) => statField(pid, 19);
// A process that exited but was never reaped: its parent (a wrapper that went `cmd & exec …`) never waits, so
// /proc/<pid>/stat stays readable with state Z — the shape that kept a dead job's slot alive.
async function zombie(): Promise<number> {
  const c = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 300'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  children.push(c);
  const pid = await new Promise<number>((r) =>
    c.stdout!.once('data', (d) => r(Number(String(d).trim()))),
  );
  for (let i = 0; i < 50 && stateOf(pid) !== 'Z'; i++) await new Promise((r) => setTimeout(r, 50));
  return pid;
}

function board(args: string[], cwd = tmp) {
  const r = spawnSync('bash', [join(boardDir, 'board.sh'), ...args], {
    env,
    cwd,
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function heavy(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('bash', [join(boardDir, 'heavy.sh'), ...args], {
    env: { ...env, ...extra },
    cwd: tmp,
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}

const events = () =>
  readdirSync(join(tmp, 'board/history'))
    .filter((f) => f.startsWith('events-'))
    .flatMap((f) =>
      readFileSync(join(tmp, 'board/history', f), 'utf8')
        .trim()
        .split('\n'),
    )
    .map((l) => JSON.parse(l));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'board-cli-'));
  // Run as if outside any Claude session: identity comes from --pid only.
  const rest = { ...process.env };
  delete rest.CLAUDE_PID;
  delete rest.CLAUDE_CODE_SESSION_ID;
  delete rest.TMUX_PANE; // else sessions are named after the tmux window running the tests
  delete rest.TMUX;
  delete rest.VITEST_MAX_WORKERS; // scripts' test script pins it (and heavy.sh may export it): inherited, it'd mask the export
  // edge.sh / matrix.sh run this suite with HEAVY_LOADTEST / HEAVY_GUARD exported: inherited, they'd bypass
  // the cap these tests check (and their failure would read as a load-caused edge)
  for (const k of Object.keys(rest)) if (k.startsWith('HEAVY_')) delete rest[k];
  env = {
    ...rest,
    APERTURE_BOARD_DIR: join(tmp, 'board'),
    APERTURE_BOARD_LOCK: join(tmp, 'lock'),
    APERTURE_CGROUP_DIR: join(tmp, 'cg'),
    APERTURE_LIMITS_JSON: join(tmp, 'limits.json'),
  };
  cgroup(300, 2 * GiB);
  limits({});
});

describe('sampler.sh', () => {
  it('reads every process’s own command line, not just the first one /proc lists', () => {
    // comm is `sleep`; only argv says vitest — its row carries that only if args are read per process
    // (asserted on this pid's row: the test runner's own workers would satisfy a category count anyway)
    const c = spawn('sleep', ['300'], { argv0: 'vitest', stdio: 'ignore' });
    children.push(c);
    const r = spawnSync('bash', ['-c', `. ${join(boardDir, 'lib.sh')}; sb_procs args`], {
      env,
      encoding: 'utf8',
    });
    const row = r.stdout.split('\n').find((l) => l.startsWith(`${c.pid}\t`));
    expect(row?.split('\t')[6]).toMatch(/^vitest 300/);
  });

  it('prints one parseable sample with the fake cgroup’s numbers', () => {
    const r = spawnSync('bash', [join(boardDir, 'sampler.sh'), '--print'], {
      env,
      encoding: 'utf8',
    });
    const s = JSON.parse(r.stdout);
    expect(s.cg).toMatchObject({ anonMiB: 2048, pids: 300, pidsMax: 4096, highMiB: 18432 });
    expect(Object.keys(s.cats)).toEqual(expect.arrayContaining(['claude', 'vitest', 'other']));
    expect(s.mix).toEqual(expect.objectContaining({ working: expect.any(Number) }));
  });

  // The path is asked for, never proven by running a tick: a regression would write the live file.
  it('keeps a fake cgroup’s prev tick beside it, never in the live sampler’s file', () => {
    const where = (e: NodeJS.ProcessEnv) =>
      spawnSync('bash', [join(boardDir, 'sampler.sh'), '--prev-path'], {
        env: e,
        encoding: 'utf8',
      }).stdout.trim();
    expect(where(env)).toBe(join(tmp, 'cg/sampler.prev'));
    expect(where({ ...env, APERTURE_SAMPLER_PREV: join(tmp, 'x.prev') })).toBe(join(tmp, 'x.prev'));
    const live = { ...env };
    delete live.APERTURE_CGROUP_DIR;
    expect(where(live)).toBe('/tmp/aperture-sampler.prev');
    const prev = join(tmp, 'own.prev');
    spawnSync('bash', [join(boardDir, 'sampler.sh'), '--once'], {
      env: { ...env, APERTURE_SAMPLER_PREV: prev },
      encoding: 'utf8',
    });
    expect(readFileSync(prev, 'utf8')).toMatch(/^T\t\d+\t1000\t\d+\.\d+$/m); // epoch, usage, µs clock
  });

  // The real bad pair from 2026-11-08T05:38:53Z: the live counter (~6.28e10 µs) against a test's
  // usage_usec 1000 left in the shared prev file 1 s earlier read as 62763.68 cores on a 9-CPU box.
  it('writes null cores, not thousands, when the prev tick is not this cgroup’s', () => {
    const prev = join(tmp, 'pair.prev');
    const tick = (prevUsage: number, usage: number, ago: number, realtime = false) => {
      writeFileSync(join(tmp, 'cg/cpu.stat'), `usage_usec ${usage}\n`);
      const rt = realtime ? `\t${(Date.now() / 1000 - ago).toFixed(6)}` : ''; // the 4th field, µs clock
      writeFileSync(prev, `T\t${Math.floor(Date.now() / 1000 - ago)}\t${prevUsage}${rt}\n`);
      const r = spawnSync('bash', [join(boardDir, 'sampler.sh'), '--print'], {
        env: { ...env, APERTURE_SAMPLER_PREV: prev },
        encoding: 'utf8',
      });
      return JSON.parse(r.stdout).cg.cpuCores as number | null;
    };
    expect(tick(1000, 62_763_681_000, 1)).toBeNull();
    expect(tick(62_763_681_000, 1000, 30)).toBeNull(); // a counter that went backwards
    const ok = tick(62_700_000_000, 62_700_000_000 + 2.5 * 30e6, 30); // a real 30 s tick (±1 s epoch rounding)
    expect(ok).toBeGreaterThan(2.3);
    expect(ok).toBeLessThan(2.6);
    // half a second after a tick (a `board.sh status`): whole seconds would read 0 or 2×. The µs clock reads
    // 7 cores' worth of usage over 0.5 s plus however long the spawn took, measured around it.
    const t0 = Date.now();
    const quick = tick(62_700_000_000, 62_700_000_000 + 7 * 0.5e6, 0.5, true)!;
    const spent = (Date.now() - t0) / 1000;
    expect(quick).toBeGreaterThanOrEqual((7 * 0.5) / (0.5 + spent) - 0.05);
    expect(quick).toBeLessThanOrEqual(7.05);
    // a 2-CPU cpu.max: 7 cores' worth can't be this cgroup's
    writeFileSync(join(tmp, 'cg/cpu.max'), '200000 100000\n');
    expect(tick(62_700_000_000, 62_700_000_000 + 7 * 30e6, 30)).toBeNull();
    expect(tick(62_700_000_000, 62_700_000_000 + 2.5 * 30e6, 30)).not.toBeNull();
  });
});

describe('board.sh register repair', () => {
  it('register heals a corrupt or empty session file instead of keeping it', () => {
    const a = liveSession();
    const f = join(tmp, 'board/sessions', `${a}.json`);
    mkdirSync(join(tmp, 'board/sessions'), { recursive: true });
    for (const bad of ['{"pid":', '']) {
      writeFileSync(f, bad);
      expect(board(['register', '--pid', `${a}`, '--cwd', repo(`r${bad.length}`)]).code).toBe(0);
      expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({
        pid: a,
        branch: `r${bad.length}`,
      });
    }
  });
});

function devlock(args: string[], source?: string) {
  const r = spawnSync('bash', [join(boardDir, 'devlock.sh'), ...args], {
    env: { ...env, APERTURE_DEVLOCK_SOURCE: source ?? `file:${join(tmp, 'gh-lock')}` },
    cwd: tmp,
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout.trim() };
}
// What GitHub's refs/locks/dev tag says ('' = no ref); the fake source devlock.sh reads.
const ghLock = (holder: object | '') =>
  writeFileSync(join(tmp, 'gh-lock'), holder === '' ? '' : JSON.stringify(holder));
const cache = () => JSON.parse(readFileSync(join(tmp, 'board/devlock.json'), 'utf8'));
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const SHA = 'a'.repeat(40);

describe('devlock.sh', () => {
  beforeEach(() => mkdirSync(join(tmp, 'board'), { recursive: true }));

  it('shows the real lock with the holder’s session name from the board', () => {
    const a = liveSession();
    board(['register', '--pid', `${a}`, '--cwd', repo('flux')]);
    ghLock({ branch: 'flux', sha: SHA, expiresAt: iso(30 * 60_000) });
    expect(devlock(['refresh']).code).toBe(0);
    expect(cache()).toMatchObject({ v: 1, source: 'peek', holder: { branch: 'flux', sha: SHA } });
    expect(devlock(['line']).out).toMatch(/^dev lock: flux \(flux\) until \d\d:\d\d$/);
  });

  it('adds slot B after slot A once devb has a cache, each judged on its own', () => {
    const a = liveSession();
    board(['register', '--pid', `${a}`, '--cwd', repo('lc')]);
    ghLock('');
    writeFileSync(
      join(tmp, 'gh-lock.devb'),
      JSON.stringify({ branch: 'lc', sha: SHA, expiresAt: iso(20 * 60_000) }),
    );
    expect(devlock(['refresh']).code).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp, 'board/devlock.devb.json'), 'utf8'))).toMatchObject({
      v: 1,
      source: 'peek',
      holder: { branch: 'lc' },
    });
    expect(devlock(['line']).out).toMatch(/^dev lock: free · devb: lc \(lc\) until \d\d:\d\d$/);
    writeFileSync(
      join(tmp, 'gh-lock.devb'),
      JSON.stringify({ branch: 'lc', sha: SHA, expiresAt: iso(-60_000) }),
    );
    devlock(['refresh', '--max-age', '0']);
    expect(devlock(['line']).out).toMatch(
      /^dev lock: free · devb: lc — EXPIRED \d\d:\d\d, the next acquire takes it over$/,
    );
    writeFileSync(join(tmp, 'gh-lock.devb'), '');
    devlock(['refresh', '--max-age', '0']);
    expect(devlock(['line']).out).toBe('dev lock: free · devb: free');
  });

  it('says free when the ref is absent, and EXPIRED past expiresAt', () => {
    ghLock('');
    devlock(['refresh']);
    expect(devlock(['line']).out).toBe('dev lock: free');
    ghLock({ branch: 'flux', sha: SHA, expiresAt: iso(-60_000) });
    devlock(['refresh', '--max-age', '0']);
    expect(devlock(['line']).out).toMatch(
      /^dev lock: flux — EXPIRED \d\d:\d\d, the next acquire takes it over$/,
    );
  });

  it('keeps the last cache and marks it stale when the fetch fails or times out', () => {
    expect(devlock(['line']).out).toBe('dev lock: unknown (offline, no cache)');
    const old = new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const holder = { branch: 'flux', sha: SHA, expiresAt: iso(20 * 60_000) };
    writeFileSync(
      join(tmp, 'board/devlock.json'),
      JSON.stringify({ v: 1, t: old, source: 'peek', holder }),
    );
    expect(devlock(['refresh'], `file:${join(tmp, 'missing')}`).code).toBe(0);
    expect(cache()).toMatchObject({ t: old, holder, failedAt: expect.any(String) });
    expect(devlock(['line']).out).toMatch(
      /^dev lock: flux until \d\d:\d\d \(as of \d\d:\d\d, refresh failed\)$/,
    );
  });

  it('waits a minute after a failed peek before asking GitHub again', () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const holder = { branch: 'flux', sha: SHA, expiresAt: iso(20 * 60_000) };
    writeFileSync(
      join(tmp, 'board/devlock.json'),
      JSON.stringify({ v: 1, t: old, source: 'peek', holder }),
    );
    devlock(['refresh'], `file:${join(tmp, 'missing')}`); // fails: failedAt set
    ghLock(''); // GitHub is back and says free
    devlock(['refresh']);
    expect(cache().holder).toEqual(holder); // within the minute: not asked again
  });

  it('one caller’s failed peek never holds back another caller, and records why and who', () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const holder = { branch: 'flux', sha: SHA, expiresAt: iso(20 * 60_000) };
    writeFileSync(
      join(tmp, 'board/devlock.json'),
      JSON.stringify({ v: 1, t: old, source: 'peek', holder }),
    );
    const as = (caller: string, source?: string) =>
      spawnSync('bash', [join(boardDir, 'devlock.sh'), 'refresh'], {
        env: {
          ...env,
          APERTURE_DEVLOCK_CALLER: caller,
          APERTURE_DEVLOCK_SOURCE: source ?? `file:${join(tmp, 'gh-lock')}`,
        },
        encoding: 'utf8',
      });
    as('status', `file:${join(tmp, 'missing')}`);
    expect(cache()).toMatchObject({
      t: old,
      holder,
      failedWhy: 'source file missing',
      failedBy: 'status',
    });
    ghLock('');
    as('status'); // the same caller, inside its minute: not asked again
    expect(cache().holder).toEqual(holder);
    as('tower'); // another caller asks, and its good read clears the failure
    expect(cache()).toEqual({ v: 1, t: expect.any(String), source: 'peek', holder: null });
  });

  it('in an outage each caller keeps its own minute, however their failures interleave', () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(
      join(tmp, 'board/devlock.json'),
      JSON.stringify({ v: 1, t: old, source: 'peek', holder: null }),
    );
    const as = (caller: string, source: string) =>
      spawnSync('bash', [join(boardDir, 'devlock.sh'), 'refresh'], {
        env: { ...env, APERTURE_DEVLOCK_CALLER: caller, APERTURE_DEVLOCK_SOURCE: source },
        encoding: 'utf8',
      });
    const down = `file:${join(tmp, 'missing')}`;
    as('tower', down);
    as('status', down);
    expect(cache().failedFor).toEqual({ tower: expect.any(String), status: expect.any(String) });
    ghLock({ branch: 'flux', sha: SHA, expiresAt: iso(20 * 60_000) }); // back up, but…
    as('tower', `file:${join(tmp, 'gh-lock')}`); // …the tower failed under a minute ago: not asked
    expect(cache().holder).toBeNull();
    expect(cache().failedBy).toBe('status');
  });

  it('says why when GitHub refuses, and asks with HOME set when the caller has none (the tmux status bar)', () => {
    // git and gh stand-ins first on PATH: git records the HOME it saw, then answers as told
    const bin = join(tmp, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/bash\necho "\${HOME:-unset}" >"${join(tmp, 'git-home')}"\n` +
        `[ -f "${join(tmp, 'git-fail')}" ] && { cat "${join(tmp, 'git-fail')}" >&2; exit 128; }\nexit 0\n`,
      { mode: 0o755 },
    );
    const noHome = { ...env };
    delete noHome.HOME;
    const run = () =>
      spawnSync('bash', [join(boardDir, 'devlock.sh'), 'refresh', '--max-age', '0'], {
        env: { ...noHome, PATH: `${bin}:${env.PATH}`, APERTURE_DEVLOCK_CALLER: 'status' },
        encoding: 'utf8',
      });
    const failWith = (line: string) => {
      writeFileSync(join(tmp, 'git-fail'), `warning: noise\n${line}\n`);
      writeFileSync(
        join(tmp, 'board/devlock.json'),
        JSON.stringify({ v: 1, t: iso(-10 * 60_000), source: 'peek', holder: null }),
      );
      run();
      return cache();
    };
    expect(failWith('fatal: Could not read from remote repository.')).toMatchObject({
      failedWhy: 'ls-remote: fatal: Could not read from remote repository.',
      failedBy: 'status',
    });
    // the reason reaches a page that leaves the box: a URL's credentials never do
    const why = failWith(
      "fatal: unable to access 'https://x-access-token:tok@github.com/o/r/'",
    ).failedWhy;
    expect(why).toBe("ls-remote: fatal: unable to access 'https://github.com/o/r/'");
    expect(failWith("fatal: unable to access 'https://u:p@ss@github.com/o/r/'").failedWhy).toBe(
      "ls-remote: fatal: unable to access 'https://github.com/o/r/'",
    );
    rmSync(join(tmp, 'git-fail'));
    writeFileSync(
      join(tmp, 'board/devlock.json'),
      JSON.stringify({ v: 1, t: iso(-10 * 60_000), source: 'peek', holder: null }),
    );
    run();
    expect(readFileSync(join(tmp, 'git-home'), 'utf8').trim()).toBe(userInfo().homedir);
    expect(cache()).toEqual({ v: 1, t: expect.any(String), source: 'peek', holder: null });
  });

  it('skips the fetch while the cache is fresh', () => {
    ghLock({ branch: 'flux', sha: SHA, expiresAt: iso(30 * 60_000) });
    devlock(['refresh']);
    ghLock(''); // GitHub says free now, but the cache is seconds old
    devlock(['refresh']);
    expect(cache().holder.branch).toBe('flux');
    devlock(['refresh', '--max-age', '0']);
    expect(cache().holder).toBeNull();
  });

  it('says unknown for a garbled cache, and a refresh replaces it', () => {
    writeFileSync(join(tmp, 'board/devlock.json'), '{"v":1,"t":');
    expect(devlock(['line']).out).toBe('dev lock: unknown (unreadable cache)');
    ghLock('');
    expect(devlock(['refresh']).code).toBe(0);
    expect(devlock(['line']).out).toBe('dev lock: free');
  });

  it('reads a cache the bot wrote (milliseconds in its times)', () => {
    writeFileSync(
      join(tmp, 'board/devlock.json'),
      JSON.stringify({
        v: 1,
        t: new Date().toISOString(),
        source: 'bot',
        holder: { branch: 'ci-bot', sha: SHA, expiresAt: iso(45 * 60_000) },
      }),
    );
    expect(devlock(['line']).out).toMatch(/^dev lock: ci-bot until \d\d:\d\d$/);
  });
});

describe('board.sh with the real dev lock', () => {
  it('board.sh status prints the dev lock line and no dev lease', () => {
    mkdirSync(join(tmp, 'board'), { recursive: true });
    ghLock({ branch: 'flux', sha: SHA, expiresAt: iso(30 * 60_000) });
    const r = spawnSync('bash', [join(boardDir, 'board.sh'), 'status'], {
      env: { ...env, APERTURE_DEVLOCK_SOURCE: `file:${join(tmp, 'gh-lock')}` },
      cwd: tmp,
      encoding: 'utf8',
    });
    expect(r.stdout).toMatch(/^dev lock: flux until \d\d:\d\d$/m);
    expect(r.stdout).not.toMatch(/dev lease/);
    // F120: the Mac's power line and the slowdown ratio, from cli.ts machine (no mac-stats.json, no history here)
    expect(r.stdout).toMatch(/^mac: no stats \(agent not installed/m);
    expect(r.stdout).toMatch(/^slowdown \(30 min vs 24 h\): typecheck – \(no data in 7 d\)/m);
  });

  it('the sampler’s status line carries the lock holder from the cache', () => {
    mkdirSync(join(tmp, 'board'), { recursive: true });
    const line = (holder: object | null) => {
      writeFileSync(
        join(tmp, 'board/devlock.json'),
        JSON.stringify({ v: 1, t: new Date().toISOString(), source: 'bot', holder }),
      );
      spawnSync('bash', [join(boardDir, 'sampler.sh'), '--once'], { env, encoding: 'utf8' });
      return readFileSync(join(tmp, 'board/status.line'), 'utf8');
    };
    expect(line({ branch: 'flux', sha: SHA, expiresAt: iso(30 * 60_000) })).toMatch(/ · dev: flux/);
    expect(line({ branch: 'flux', sha: SHA, expiresAt: iso(-60_000) })).not.toMatch(/dev:/);
    expect(line(null)).not.toMatch(/dev:/);
  });

  it('board.sh hub names the hub from hub.json and says whether it is registered', () => {
    const hub = JSON.parse(readFileSync(join(boardDir, 'hub.json'), 'utf8')).name;
    expect(board(['hub']).out).toMatch(new RegExp(`^hub: ${hub} — not on the board`));
    const a = liveSession();
    board(['register', '--pid', `${a}`, '--cwd', repo(hub)]); // no tmux here: the name is the branch
    expect(board(['hub']).out.trim()).toBe(`hub: ${hub} — on the board (idle, ${hub})`);
    board(['--pid', `${a}`, 'end']);
    expect(board(['hub']).out).toMatch(/not on the board/);
  });

  it('gc drops the retired leases/dev.json', () => {
    mkdirSync(join(tmp, 'board/leases/heavy'), { recursive: true });
    writeFileSync(join(tmp, 'board/leases/dev.json'), '{"holderName":"flux"}');
    expect(board(['gc']).code).toBe(0);
    expect(existsSync(join(tmp, 'board/leases/dev.json'))).toBe(false);
  });
});

describe('board.sh gc', () => {
  it('drops heavy slots whose wrapper died (pid gone or reused) and keeps live ones', () => {
    const live = liveSession();
    const start = readFileSync(`/proc/${live}/stat`, 'utf8').split(') ')[1]!.split(' ')[19];
    const dir = join(tmp, 'board/leases/heavy');
    mkdirSync(dir, { recursive: true });
    const slot = (name: string, wrapperPid: number, wrapperStart: string) =>
      writeFileSync(
        join(dir, `${name}.json`),
        JSON.stringify({ v: 1, pid: 1, class: 'test', wrapperPid, wrapperStart }),
      );
    slot('live', live, start!);
    slot('dead', 4194303, '1');
    slot('reused', live, 'not-its-start-time');
    expect(board(['gc']).out).toMatch(/removed 2 stale entries/);
    expect(readdirSync(dir)).toEqual(['live.json']);
  });

  it('a zombie wrapper is dead: its slot goes too', async () => {
    const z = await zombie();
    expect(stateOf(z)).toBe('Z');
    const dir = join(tmp, 'board/leases/heavy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'z.json'),
      JSON.stringify({ v: 1, pid: 1, class: 'test', wrapperPid: z, wrapperStart: startOf(z) }),
    );
    expect(board(['gc']).out).toMatch(/removed 1 stale entry/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('live slots', () => {
  it('status, json and the sampler count only slots whose wrapper is alive — and delete none', () => {
    const live = liveSession();
    const dir = join(tmp, 'board/leases/heavy');
    mkdirSync(dir, { recursive: true });
    const slot = (name: string, label: string, wrapperPid: number, wrapperStart: string) =>
      writeFileSync(
        join(dir, `${name}.json`),
        JSON.stringify({
          v: 1,
          pid: 1,
          class: 'test',
          label,
          wrapperPid,
          wrapperStart,
          startedAt: new Date().toISOString(),
        }),
      );
    slot('live', 'suite', live, startOf(live));
    slot('dead', 'gone', 4194303, '1');
    const j = JSON.parse(board(['json']).out);
    expect(j.heavy.map((h: { label: string }) => h.label)).toEqual(['suite']);
    expect(j.sample.mix.heavy).toBe(1);
    const status = spawnSync('bash', [join(boardDir, 'board.sh'), 'status'], {
      env: { ...env, APERTURE_DEVLOCK_SOURCE: `file:${join(tmp, 'gh-lock')}` }, // no peek at GitHub
      cwd: tmp,
      encoding: 'utf8',
    });
    const cap = JSON.parse(readFileSync(join(boardDir, 'limits.json'), 'utf8')).concurrency.test;
    expect(status.stdout).toContain(`heavy: 1 slot(s) · test 1/${cap}`);
    expect(readdirSync(dir).sort()).toEqual(['dead.json', 'live.json']); // readers never delete
  });
});

describe('board.sh sampler', () => {
  it('starts under probe load — status/json probes take its lock for microseconds — three restarts in a row', async () => {
    const lock = join(tmp, 'sampler.lock');
    const senv = {
      ...env,
      APERTURE_SAMPLER_LOCK: lock,
      APERTURE_SAMPLER_PID: join(tmp, 'sampler.pid'),
      APERTURE_SAMPLER_PREV: join(tmp, 'sampler.prev'),
      APERTURE_DEVLOCK_SOURCE: `file:${join(tmp, 'gh-lock')}`, // its devlock refresh never asks GitHub
      SAMPLER_INTERVAL: '1',
    };
    const sampler = (...args: string[]) =>
      spawnSync('bash', [join(boardDir, 'board.sh'), 'sampler', ...args], {
        env: senv,
        cwd: tmp,
        encoding: 'utf8',
      });
    // `flock -n` in a tight loop: what status, json and SessionStart do, all at once.
    const prober = spawn('bash', ['-c', 'while :; do flock -n "$1" true; done', '_', lock], {
      stdio: 'ignore',
    });
    children.push(prober);
    try {
      for (let i = 0; i < 3; i++) {
        const r = sampler('restart');
        expect(r.stdout + r.stderr).toMatch(/sampler: started/);
        expect(sampler('status').stdout).toMatch(/^sampler: running/);
      }
    } finally {
      sampler('stop');
      prober.kill();
    }
    expect(sampler('status').stdout).toMatch(/^sampler: stopped/);
  });
});

describe('the main sync (sync.sh, board.sh sync)', () => {
  // A copy of the scripts over a fake `cli.ts sync-main` (its git side is sync-main.test.ts's): the round's shell —
  // heartbeat, log, failure, the singleton, the re-exec — without moving any real checkout or touching the repo's files.
  function copy() {
    const root = join(tmp, 'repo');
    const scripts = join(root, 'scripts/board');
    mkdirSync(join(root, 'scripts/src/board'), { recursive: true });
    mkdirSync(scripts, { recursive: true });
    for (const f of ['sync.sh', 'lib.sh', 'board.sh'])
      writeFileSync(join(scripts, f), readFileSync(join(boardDir, f)));
    // what sync-main was given: the checkout (INIT_CWD), the lock fd 8 (never inherited), the main-lock wait, GIT_DIR
    writeFileSync(
      join(root, 'scripts/src/board/cli.ts'),
      [
        "const fs = process.getBuiltinModule('node:fs');",
        "let fd8 = 'no-lock'; try { if (fs.readlinkSync('/proc/self/fd/8') === process.env.APERTURE_SYNC_LOCK) fd8 = 'lock'; } catch {}",
        "const env = process.env.FAKE_ENV ? `init=${process.env.INIT_CWD} fd8=${fd8} wait=${process.env.APERTURE_MAIN_LOCK_WAIT} gitdir=${process.env.GIT_DIR ?? '-'}\\n` : '';",
        "process.stdout.write(env + (process.env.FAKE_OUT ?? '')); process.exit(Number(process.env.FAKE_RC ?? 0));",
        '',
      ].join('\n'),
    );
    return scripts;
  }
  // a condition that a background loop makes true, polled (a round is a node cold start: seconds under load)
  async function until(ok: () => boolean, ms = 20000) {
    for (
      const end = Date.now() + ms;
      Date.now() < end;
      await new Promise((r) => setTimeout(r, 200))
    )
      if (ok()) return true;
    return ok();
  }
  const senv = (o: NodeJS.ProcessEnv = {}) => ({
    ...env,
    APERTURE_SYNC_LOCK: join(tmp, 'sync.lock'),
    APERTURE_SYNC_PID: join(tmp, 'sync.pid'),
    APERTURE_SYNC_TOWER: 'off',
    INIT_CWD: '/somewhere/else', // a pnpm parent's: the round must not pass it on
    GIT_DIR: '/somewhere/else/.git', // nor an inherited git target
    ...o,
  });
  const beat = () => JSON.parse(readFileSync(join(tmp, 'board/main-sync.json'), 'utf8'));
  const log = () => {
    try {
      return readFileSync(join(tmp, 'board/main-sync.log'), 'utf8');
    } catch {
      return '';
    }
  };

  it('a round: the heartbeat with ok and what sync-main said; only a round that did something is logged', () => {
    const s = copy();
    const once = (o: NodeJS.ProcessEnv) =>
      spawnSync('bash', [join(s, 'sync.sh'), '--once'], { env: senv(o), encoding: 'utf8' });
    expect(
      once({ FAKE_OUT: 'main checkout: already at aaaaaaa\ntower: restart not needed\n' }).status,
    ).toBe(0);
    expect(beat()).toMatchObject({
      v: 1,
      ok: true,
      pid: expect.any(Number),
      msg: 'main checkout: already at aaaaaaa · tower: restart not needed',
    });
    expect(log()).toBe('');
    expect(
      once({
        FAKE_OUT:
          'main checkout: moved aaaaaaa → bbbbbbb\ntower: restarted (2 tower files changed)\n',
      }).status,
    ).toBe(0);
    expect(log()).toMatch(
      /^\d\d-\d\d \d\d:\d\d main checkout: moved aaaaaaa → bbbbbbb\n.* tower: restarted/,
    );
    // sync-main refused (a dirty checkout): the round fails, and says why
    const r = once({
      FAKE_OUT: 'board cli: the main checkout has tracked changes — nothing moved',
      FAKE_RC: '2',
    });
    expect(r.status).not.toBe(0);
    expect(beat()).toMatchObject({ ok: false, msg: expect.stringMatching(/tracked changes/) });
    expect(log()).toMatch(/tracked changes/);
    // sync-main runs in its own checkout, with the loop's short main-lock wait and no inherited git target
    expect(once({ FAKE_ENV: '1' }).status).toBe(0);
    expect(beat().msg).toBe(`init=${join(tmp, 'repo')} fd8=no-lock wait=20 gitdir=-`);
    // a busy main checkout (75) is no failure: ok, says why, logs nothing
    const before = log();
    expect(once({ FAKE_OUT: 'board cli: main checkout busy', FAKE_RC: '75' }).status).toBe(0);
    expect(beat()).toMatchObject({ ok: true, msg: 'main checkout busy: next round' });
    expect(log()).toBe(before);
    // any other failure that says "busy" is still a logged failure
    expect(once({ FAKE_OUT: 'git: Device or resource busy', FAKE_RC: '2' }).status).not.toBe(0);
    expect(log()).toMatch(/Device or resource busy/);
    // a stray argument is refused, never a forever loop
    const bad = spawnSync('bash', [join(s, 'sync.sh'), '--help'], {
      env: senv(),
      encoding: 'utf8',
    });
    expect([bad.status, bad.stderr]).toEqual([2, 'usage: bash sync.sh [--once]\n']);
  });

  it('board.sh tower start brings the loop up for the real board only (even when the tower fails to start)', async () => {
    const s = copy(); // no tower-web.sh in the copy: the tower can't start, so nothing binds a port
    const e = senv({
      SYNC_INTERVAL: '60',
      APERTURE_SYNC_SCRIPT: join(s, 'sync.sh'),
      APERTURE_TOWER_PID: join(tmp, 'tower.pid'),
      APERTURE_TOWER_PORT: '1',
    });
    const board = (o: NodeJS.ProcessEnv, ...a: string[]) =>
      spawnSync('bash', [join(s, 'board.sh'), ...a], { env: { ...e, ...o }, encoding: 'utf8' });
    try {
      // a temp board isn't the real one: tower start (and the tower's tick, `sync ensure`) leave the loop alone
      expect(board({}, 'tower', 'start').status).toBe(1);
      expect(board({}, 'sync', 'status').status).toBe(1);
      expect(board({}, 'sync', 'ensure').status).toBe(0);
      expect(board({}, 'sync', 'status').status).toBe(1);
      // no sync.sh in the main checkout (the copy is no git checkout): nothing to start, never a worktree's copy
      const none = board({ APERTURE_SYNC_SCRIPT: '' }, 'sync', 'start');
      expect([none.status, none.stderr]).toEqual([1, expect.stringMatching(/nothing to start/)]);
      expect(
        board({ APERTURE_SYNC_SCRIPT: '', APERTURE_SYNC: 'on' }, 'sync', 'ensure').status,
      ).toBe(0);
      expect(board({}, 'sync', 'start', 'extra').status).toBe(2);
      // on (the real board's case, forced here): it comes up (tower start waits only 1 s for it: poll)
      expect(board({ APERTURE_SYNC: 'on' }, 'tower', 'start').status).toBe(1);
      expect(await until(() => board({}, 'sync', 'status').status === 0)).toBe(true);
      expect(board({}, 'sync', 'stop').stdout).toMatch(/sync: stopped/);
      board({ APERTURE_SYNC: 'off' }, 'sync', 'ensure');
      expect(board({}, 'sync', 'status').status).toBe(1);
    } finally {
      board({}, 'sync', 'stop');
    }
  }, 30_000);

  it('one loop per container; stop kills only its pid; a code change re-execs it in place', async () => {
    const s = copy();
    const e = senv({ SYNC_INTERVAL: '1', APERTURE_SYNC_SCRIPT: join(s, 'sync.sh'), FAKE_ENV: '1' });
    const sync = (...a: string[]) =>
      spawnSync('bash', [join(s, 'board.sh'), 'sync', ...a], { env: e, encoding: 'utf8' });
    let pid = '';
    try {
      expect(sync('start').stdout).toMatch(/sync: started/);
      pid = readFileSync(join(tmp, 'sync.pid'), 'utf8').trim();
      // the round's sync-main never holds the loop's lock fd
      expect(
        await until(() => {
          try {
            return /fd8=/.test(beat().msg);
          } catch {
            return false;
          }
        }),
      ).toBe(true);
      expect(beat().msg).toMatch(/^init=.* fd8=no-lock wait=20 gitdir=-/);
      expect(sync('start').stdout).toMatch(`already running (pid ${pid})`);
      // a second loop started by hand gives up (after its 5 s wait) and leaves the pidfile alone
      const second = spawnSync('bash', [join(s, 'sync.sh')], { env: e, timeout: 15000 });
      expect(second.status).toBe(0);
      expect(readFileSync(join(tmp, 'sync.pid'), 'utf8').trim()).toBe(pid);
      expect(sync('status').stdout).toMatch(`sync: running (pid ${pid}), last round`);
      // lib.sh changes on disk: the next round re-execs, same pid, still holding the lock
      // a loop that reopened the lock file on re-exec (instead of keeping fd 8) can't now: it would exit
      chmodSync(join(tmp, 'sync.lock'), 0o000);
      writeFileSync(join(s, 'lib.sh'), readFileSync(join(s, 'lib.sh'), 'utf8') + '\n# moved\n');
      expect(
        await until(() => log().includes(`re-exec (pid ${pid}): sync.sh or lib.sh changed`)),
      ).toBe(true);
      await new Promise((r) => setTimeout(r, 1500)); // a reopening loop would have exited by now
      expect(process.kill(+pid, 0)).toBe(true); // still alive, past the re-exec, on its kept fd
      chmodSync(join(tmp, 'sync.lock'), 0o644);
      expect(sync('status').stdout).toMatch(`sync: running (pid ${pid})`);
      // a pidfile naming some other live process (this worker) while the loop runs: neither is killed
      writeFileSync(join(tmp, 'sync.pid'), `${process.pid}\n`);
      const foreign = sync('stop');
      expect([foreign.status, foreign.stderr]).toEqual([
        1,
        expect.stringMatching(/doesn't name the loop/),
      ]);
      expect(sync('status').status).toBe(0);
      writeFileSync(join(tmp, 'sync.pid'), `${pid}\n`);
    } finally {
      // the re-exec'd loop still holds the lock on its fd 8: stop knows it (and kills it by pid if a check failed)
      const r = sync('stop');
      if (r.status !== 0 && /^\d+$/.test(pid)) process.kill(+pid);
      expect(r.stdout).toMatch(/sync: stopped/);
    }
    expect(sync('status').status).toBe(1);
  }, 60_000);
});

describe('statusline-board.sh', () => {
  // no loadavg unless a case gives one, so the vm segment shows only where a case asks for it
  const run = (line: string | null, extra: NodeJS.ProcessEnv = {}, sub = 'sl') => {
    const dir = join(tmp, sub);
    mkdirSync(dir, { recursive: true });
    if (line !== null) writeFileSync(join(dir, 'board.line'), line);
    const r = spawnSync('bash', ['-u', join(boardDir, 'statusline-board.sh')], {
      env: { ...env, APERTURE_BOARD_DIR: dir, APERTURE_LOADAVG: join(dir, 'no-loadavg'), ...extra },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const now = () => Math.floor(Date.now() / 1000);
  it('a fresh board: dim, its age; usage first and the next merge last; "?" once the merge time passed', () => {
    const t = now();
    const r = run(
      `${t} ${t - 720} 0 dim\nmerge ${t + 600} 19:40 Merge coach-fixes (PR 210)\nusage ${t - 60} usage 13% · 9.0%/h\n`,
    );
    expect(r).toMatchObject({ code: 0, err: '' });
    expect(r.out).toBe(
      ' \x1b[2m· usage 13% · 9.0%/h\x1b[0m \x1b[2m· board 12m\x1b[0m \x1b[2m· next ~19:40 coach-fixes (PR 210)\x1b[0m',
    );
    expect(run(`${t} ${t - 60} 0 dim\nmerge ${t - 60} 19:40 x\n`).out).toContain('next ?19:40 x');
  });
  it('stale items: amber or red with the count; an old usage line is left off', () => {
    const t = now();
    expect(run(`${t} ${t - 7200} 3? warn\nusage ${t - 3600} usage 1%\n`).out).toBe(
      ' \x1b[33m· board 2h · 3? stale\x1b[0m',
    );
    expect(run(`${t} - 6 bad\n`).out).toBe(' \x1b[31m· board ? · 6 stale\x1b[0m');
  });
  it('context (F240): red with the names at 50 %, amber with a count at 40 %, before the board', () => {
    const t = now();
    expect(run(`${t} ${t - 60} 0 dim\nctx 4 1 lc-catalog\n`).out).toBe(
      ' \x1b[31m· ctx ≥50 lc-catalog · 3 ≥40\x1b[0m \x1b[2m· board 1m\x1b[0m',
    );
    expect(run(`${t} ${t - 60} 0 dim\nctx 2 2 a,b\n`).out).toContain('· ctx ≥50 a, b\x1b[0m');
    expect(run(`${t} ${t - 60} 0 dim\nctx 2 0 -\n`).out).toContain('\x1b[33m· ctx 2 ≥40\x1b[0m');
    expect(run(`${t} ${t - 60} 0 dim\nctx x y z\n`).out).toBe(' \x1b[2m· board 1m\x1b[0m');
  });
  it('the tower silent 3 min: red "tower down", nothing else it said', () => {
    const t = now();
    expect(run(`${t - 600} ${t - 700} 0 dim\nmerge ${t + 60} 19:40 x\n`).out).toBe(
      ' \x1b[31m· tower down (board.line 10 min old)\x1b[0m',
    );
  });
  it('missing, empty or garbled: silent but the live load, exit 0, nothing leaked under set -u', () => {
    const avg = join(tmp, 'loadavg-ok');
    writeFileSync(avg, '1.59 5.26 8.59 3/900 12345\n');
    for (const l of [null, '', 'garbage here\n', '\n\nmerge x y\n']) {
      rmSync(join(tmp, 'sl', 'board.line'), { force: true });
      expect(run(l)).toMatchObject({ code: 0, out: '', err: '' });
      expect(run(l, { APERTURE_LOADAVG: avg })).toMatchObject({
        code: 0,
        out: ' \x1b[2m· vm 2 5 9\x1b[0m',
        err: '',
      });
    }
  });
  it('sourced, as the status line does: no _bl_ variable survives, whatever the file said', () => {
    const avg = join(tmp, 'loadavg-ok');
    writeFileSync(avg, '1.59 5.26 8.59 3/900 12345\n');
    const t = now();
    const lines = [
      null,
      `${t} ${t - 60} 0 dim\nslow warn slow 30m tc×1.6\nmac 1 2 3 12\nvm 9\nctx 2 1 a\nmerge ${t} 19:40 x\nusage ${t} u\n`,
      `${t - 600} ${t - 700} 0 dim\n`,
    ];
    for (const l of lines) {
      const dir = join(tmp, 'sl-src');
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      if (l !== null) writeFileSync(join(dir, 'board.line'), l);
      const r = spawnSync(
        'bash',
        ['-uc', '. "$1" >/dev/null; compgen -v _bl_', '_', join(boardDir, 'statusline-board.sh')],
        {
          env: { ...env, APERTURE_BOARD_DIR: dir, APERTURE_LOADAVG: avg },
          encoding: 'utf8',
        },
      );
      expect(r).toMatchObject({ stdout: '', stderr: '' });
    }
  });
  describe('the load and slowdown segments (F293)', () => {
    const avg = () => join(tmp, 'loadavg'); // tmp is set in beforeAll
    const dim = (s: string) => ` \x1b[2m· ${s}\x1b[0m`;
    const rows = (t: number, more = '') =>
      `${t} ${t - 60} 0 dim\nslow ok slow 30m tc×1.2 gn– gw×1.1\nmac 6 8 12 12\nvm 9\nusage ${t - 60} usage 13%\n${more}`;
    it('mac, vm and slow first, then usage and the board', () => {
      writeFileSync(avg(), '1.59 5.26 8.59 3/900 12345\n');
      const t = now();
      const r = run(rows(t), { APERTURE_LOADAVG: avg() });
      expect(r).toMatchObject({ code: 0, err: '' });
      expect(r.out).toBe(
        dim('mac 6 8 12/12') +
          dim('vm 2 5 9/9') +
          dim('slow 30m tc×1.2 gn– gw×1.1') +
          dim('usage 13%') +
          dim('board 1m'),
      );
    });
    it('the slow tone: dim, amber, red; a malformed row is left off, the rest intact', () => {
      const t = now();
      const slow = (row: string) => run(`${t} ${t - 60} 0 dim\n${row}\n`).out;
      expect(slow('slow warn slow 30m gl×1.6')).toBe(
        ` \x1b[33m· slow 30m gl×1.6\x1b[0m${dim('board 1m')}`,
      );
      expect(slow('slow bad slow: no data since 19:02')).toBe(
        ` \x1b[31m· slow: no data since 19:02\x1b[0m${dim('board 1m')}`,
      );
      for (const row of [
        'slow',
        'slow ok',
        'slow ok ',
        'slow purple x',
        'mac 1 2',
        'mac a b c d',
        'vm x',
      ])
        expect(run(`${t} ${t - 60} 0 dim\n${row}\n`)).toMatchObject({
          code: 0,
          err: '',
          out: dim('board 1m'),
        });
    });
    it('vm: no core count without its row; a garbled loadavg is no segment', () => {
      const t = now();
      writeFileSync(avg(), '0.4 2.5 9\n');
      expect(run(`${t} ${t - 60} 0 dim\n`, { APERTURE_LOADAVG: avg() }).out).toBe(
        dim('vm 0 2 9') + dim('board 1m'),
      );
      writeFileSync(avg(), 'x y z\n');
      expect(run(`${t} ${t - 60} 0 dim\nvm 9\n`, { APERTURE_LOADAVG: avg() })).toMatchObject({
        err: '',
        out: dim('board 1m'),
      });
    });
    it('the tower down: the live vm load, then red, no mac or slow', () => {
      writeFileSync(avg(), '1.59 5.26 8.59 3/900 12345\n');
      const t = now();
      expect(run(rows(t - 600), { APERTURE_LOADAVG: avg() }).out).toBe(
        `${dim('vm 2 5 9/9')} \x1b[31m· tower down (board.line 10 min old)\x1b[0m`,
      );
    });
    it("a tower not yet restarted: no rows, only the live vm load beside today's line", () => {
      writeFileSync(avg(), '1.59 5.26 8.59 3/900 12345\n');
      const t = now();
      expect(run(`${t} ${t - 60} 0 dim\n`, { APERTURE_LOADAVG: avg() }).out).toBe(
        dim('vm 2 5 9') + dim('board 1m'),
      );
    });
    it("reads what the tower's boardLine writes", () => {
      writeFileSync(avg(), '1.59 5.26 8.59 3/900 12345\n');
      const t = Date.now();
      const b = { items: [], unsure: null, tone: 'dim' as const, why: null, updatedAt: t - 60_000 };
      const line = boardLine(b, [], t, () => '00:00', null, null, {
        slow: { tone: 'bad', short: 'slow 30m tc×2.1 gl×0.7 · lint no data since 22:02' },
        mac: { load: [6.31, 7.86, 12.36], cpus: 12 },
        cores: 9,
      });
      expect(run(line, { APERTURE_LOADAVG: avg() }).out).toBe(
        dim('mac 6 8 12/12') +
          dim('vm 2 5 9/9') +
          ' \x1b[31m· slow 30m tc×2.1 gl×0.7 · lint no data since 22:02\x1b[0m' +
          dim('board 1m'),
      );
    });
    it("while localNotes' slowdown-line.sh is still there, it prints these itself: none of the three here", () => {
      writeFileSync(avg(), '1.59 5.26 8.59 3/900 12345\n');
      const t = now();
      const dir = join(tmp, 'sl-old');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'slowdown-line.sh'), '# the old one\n');
      expect(run(rows(t), { APERTURE_LOADAVG: avg() }, 'sl-old').out).toBe(
        dim('usage 13%') + dim('board 1m'),
      );
      expect(run(rows(t - 600), { APERTURE_LOADAVG: avg() }, 'sl-old').out).toBe(
        ' \x1b[31m· tower down (board.line 10 min old)\x1b[0m',
      );
    });
  });
});

describe('heavy.sh', () => {
  it('passes the exit code through and logs a job event, slot released', () => {
    const r = heavy(['--', 'bash', '-c', 'exit 3'], {
      HEAVY_CLASS: 'typecheck',
      HEAVY_LABEL: 'gate',
    });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/heavy: gate exit 3/);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({
      class: 'typecheck',
      label: 'gate',
      exit: 3,
      verdict: 'clean',
    });
    expect(readdirSync(join(tmp, 'board/leases/heavy'))).toEqual([]);
  });

  it('runs anyway past hard when enforce is off, logging wouldWait', () => {
    cgroup(3700, 2 * GiB);
    limits({ enforce: false });
    const r = heavy(['--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/past the measured edge .* running \(enforce off/);
    expect(events().find((e) => e.kind === 'lease')).toMatchObject({
      action: 'wouldWait',
      class: 'test',
    });
  });

  it('waits past hard when enforce is on, then exits 75 telling Claude to tell the user', () => {
    cgroup(3700, 2 * GiB);
    limits({ enforce: true });
    const r = heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(75);
    expect(r.err).toMatch(/tell the user/);
    expect(events().filter((e) => e.kind === 'job')).toEqual([]);
  });

  it('keeps the command’s exit code when limits.json is unreadable', () => {
    writeFileSync(join(tmp, 'limits.json'), '{');
    const r = heavy(['--', 'bash', '-c', 'exit 3'], { HEAVY_CLASS: 'typecheck' });
    expect(r.code).toBe(3);
  });

  it('stops its whole subtree on TERM and exits 128+15', async () => {
    const marker = join(tmp, 'kid.pid');
    const c = spawn(
      'bash',
      [join(boardDir, 'heavy.sh'), '--', 'bash', '-c', `sleep 300 & echo $! >${marker}; wait`],
      { env: { ...env, HEAVY_CLASS: 'build' }, cwd: tmp, stdio: 'ignore' },
    );
    for (let i = 0; i < 100 && !existsSync(marker); i++)
      await new Promise((r) => setTimeout(r, 50));
    const kid = Number(readFileSync(marker, 'utf8'));
    const exited = new Promise<number | null>((r) => c.on('exit', (code) => r(code)));
    c.kill('SIGTERM');
    expect(await exited).toBe(143);
    const state = () => {
      try {
        return readFileSync(`/proc/${kid}/stat`, 'utf8').split(') ')[1]![0];
      } catch {
        return 'gone';
      }
    };
    expect(['gone', 'Z']).toContain(state());
    expect(readdirSync(join(tmp, 'board/leases/heavy'))).toEqual([]);
  }, 20000);

  it('stops its whole subtree on HUP and exits 128+1', async () => {
    const marker = join(tmp, 'kid.pid');
    const c = spawn(
      'bash',
      [join(boardDir, 'heavy.sh'), '--', 'bash', '-c', `sleep 300 & echo $! >${marker}; wait`],
      { env: { ...env, HEAVY_CLASS: 'build' }, cwd: tmp, stdio: 'ignore' },
    );
    for (let i = 0; i < 100 && !existsSync(marker); i++)
      await new Promise((r) => setTimeout(r, 50));
    const kid = Number(readFileSync(marker, 'utf8'));
    const exited = new Promise<number | null>((r) => c.on('exit', (code) => r(code)));
    c.kill('SIGHUP');
    expect(await exited).toBe(129);
    const state = () => {
      try {
        return readFileSync(`/proc/${kid}/stat`, 'utf8').split(') ')[1]![0];
      } catch {
        return 'gone';
      }
    };
    expect(['gone', 'Z']).toContain(state());
    expect(readdirSync(join(tmp, 'board/leases/heavy'))).toEqual([]);
  }, 20000);

  it('escalates to KILL for a child that ignores TERM', async () => {
    const marker = join(tmp, 'kid.pid');
    // the stubborn sleep ignores TERM, so only the KILL passes can end it
    // the marker is written only once TERM is ignored, so the signal can't land before the trap does
    const script = `( trap "" TERM; echo $BASHPID >${marker}; exec sleep 300 ) & wait`;
    const c = spawn('bash', [join(boardDir, 'heavy.sh'), '--', 'bash', '-c', script], {
      env: { ...env, HEAVY_CLASS: 'build' },
      cwd: tmp,
      stdio: 'ignore',
    });
    for (let i = 0; i < 100 && !existsSync(marker); i++)
      await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300)); // let the subshell exec sleep
    const kid = Number(readFileSync(marker, 'utf8'));
    const exited = new Promise<number | null>((r) => c.on('exit', (code) => r(code)));
    c.kill('SIGTERM');
    expect(await exited).toBe(143);
    let state = 'gone';
    try {
      state = readFileSync(`/proc/${kid}/stat`, 'utf8').split(') ')[1]![0]!;
    } catch {
      // gone
    }
    expect(['gone', 'Z']).toContain(state);
  }, 30000);

  it('exports tuning.test maxWorkers as VITEST_MAX_WORKERS for a suite, in a coi container only', () => {
    const seen = join(tmp, 'workers');
    const run = (host: string) => {
      const bin = join(tmp, `bin-${host}`); // sb_in_container reads `hostname`
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'hostname'), `#!/bin/sh\necho ${host}\n`, { mode: 0o755 });
      rmSync(seen, { force: true });
      const cmd = `printf %s "$VITEST_MAX_WORKERS" >${seen}`;
      const r = heavy(['--', 'bash', '-c', cmd], {
        HEAVY_CLASS: 'test',
        PATH: `${bin}:${env.PATH}`,
      });
      expect(r.code).toBe(0);
      return readFileSync(seen, 'utf8');
    };
    limits({});
    const shipped = JSON.parse(readFileSync(join(tmp, 'limits.json'), 'utf8')).tuning.test
      .maxWorkers;
    expect(run('coi-test')).toBe(String(shipped));
    expect(run('macbook')).toBe(''); // never on the Mac (or CI)
    limits({ tuning: { test: null } });
    expect(run('coi-test')).toBe(''); // read from the file, not built in
  });

  it('never takes a slot or waits for a single-file test run', () => {
    cgroup(3700, 2 * GiB);
    limits({ enforce: true });
    const r = heavy(['--', 'true'], { HEAVY_CLASS: 'test-file' });
    expect(r.code).toBe(0);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({ class: 'test-file' });
  });
});

describe('heavy.sh test cap', () => {
  // the shipped cap (limits.json `concurrency.test`), so a policy change moves no test
  const cap: number = JSON.parse(readFileSync(join(boardDir, 'limits.json'), 'utf8')).concurrency
    .test;
  const full = `${cap}\\/${cap}`;
  // n live `test` slots held by `pid`'s process (so gc keeps them), as other sessions' suites would be
  function testSlots(n: number, pid = liveSession()) {
    const start = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19];
    const dir = join(tmp, 'board/leases/heavy');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++)
      writeFileSync(
        join(dir, `${pid}-${i}.json`),
        JSON.stringify({
          v: 1,
          pid,
          class: 'test',
          label: `suite-${i}`,
          wrapperPid: pid,
          wrapperStart: start,
          startedAt: new Date().toISOString(),
        }),
      );
  }
  const leases = () => events().filter((e) => e.kind === 'lease');
  const slotFiles = () => readdirSync(join(tmp, 'board/leases/heavy'));

  it('cap full: waits, gives up with 75 naming the holders, and records the barrier', () => {
    limits({ enforce: true });
    testSlots(cap);
    const r = heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test', HEAVY_LABEL: 'gate' });
    expect(r.code).toBe(75);
    expect(r.err).toMatch(new RegExp(`test cap full \\(${full}`));
    expect(r.err).toMatch(/tell the user/);
    expect(leases()).toEqual([
      expect.objectContaining({
        lease: 'heavy',
        action: 'gaveUp',
        reason: 'cap',
        class: 'test',
        label: 'gate',
        cap: { max: cap, running: cap, full: true },
        waitedSec: 0,
      }),
    ]);
    expect(leases()[0].holders).toHaveLength(cap);
    expect(events().filter((e) => e.kind === 'job')).toEqual([]);
    expect(slotFiles()).toHaveLength(cap); // no extra slot
  });

  it('a freed slot lets it run, and the wait is recorded', async () => {
    limits({ enforce: true });
    testSlots(cap - 1);
    // an orphan (its bash parent exits at once), so init reaps it the moment it ends — like a real wrapper's
    // shell would; a direct child of this blocked test runner would linger as a zombie and keep its slot
    const brief = spawnSync('bash', ['-c', 'sleep 5 >/dev/null 2>&1 & echo $!'], {
      encoding: 'utf8',
    });
    testSlots(1, Number(brief.stdout.trim()));
    const r = heavy(['--wait', '20', '--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(0);
    const waited = leases().find((e) => e.action === 'waited');
    expect(waited).toMatchObject({ reason: 'cap', class: 'test', cap: { running: cap } });
    expect(waited.waitedSec).toBeGreaterThanOrEqual(1);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({ class: 'test', exit: 0 });
  }, 30000);

  it('a wait killed before it ends is still recorded: gaveUp, interrupted, the real wait', async () => {
    limits({ enforce: true });
    testSlots(cap);
    const c = spawn('bash', [join(boardDir, 'heavy.sh'), '--wait', '60', '--', 'true'], {
      env: { ...env, HEAVY_CLASS: 'test', HEAVY_LABEL: 'gate' },
      cwd: tmp,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    c.stderr!.on('data', (d) => (err += d));
    for (let i = 0; i < 200 && !/waiting up to/.test(err); i++)
      await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1100)); // a whole second of waiting
    const exited = new Promise<number | null>((r) => c.on('exit', (code) => r(code)));
    c.kill('SIGTERM');
    expect(await exited).toBe(143);
    expect(leases()).toEqual([
      expect.objectContaining({
        action: 'gaveUp',
        reason: 'cap',
        class: 'test',
        label: 'gate',
        interrupted: true,
      }),
    ]);
    expect(leases()[0].waitedSec).toBeGreaterThanOrEqual(1);
    expect(leases()[0].waitedSec).toBeLessThan(60);
    expect(slotFiles()).toHaveLength(cap);
  }, 30000);

  it('below the cap nothing changes: no wait, no barrier', () => {
    limits({ enforce: true });
    testSlots(cap - 1);
    const r = heavy(['--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/cap/);
    expect(leases()).toEqual([]);
  });

  it('HEAVY_SLOT_CLASS: the slot and the cap take its class, the job event keeps HEAVY_CLASS', () => {
    limits({ enforce: true });
    const seen = join(tmp, 'slot.json');
    const dir = join(tmp, 'board/leases/heavy');
    const r = heavy(['--', 'bash', '-c', `cat ${dir}/*.json >${seen}`], {
      HEAVY_CLASS: 'gate-wide',
      HEAVY_SLOT_CLASS: 'test',
      HEAVY_LABEL: 'gate:wide',
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toMatchObject({
      class: 'test',
      label: 'gate:wide',
    });
    expect(events().find((e) => e.kind === 'job')).toMatchObject({
      class: 'gate-wide',
      label: 'gate:wide',
    });
    expect(slotFiles()).toEqual([]);
    testSlots(cap);
    const held = heavy(['--wait', '0', '--', 'true'], {
      HEAVY_CLASS: 'gate-wide',
      HEAVY_SLOT_CLASS: 'test',
      HEAVY_LABEL: 'gate:wide',
    });
    expect(held.code).toBe(75);
    expect(leases()).toEqual([
      expect.objectContaining({
        action: 'gaveUp',
        reason: 'cap',
        class: 'test',
        label: 'gate:wide',
      }),
    ]);
  });

  it('HEAVY_NOSLOT inside a slotted run: no second slot, even at a full cap; the step is measured and logged', () => {
    limits({ enforce: true });
    testSlots(cap - 1); // the outer run takes the last place
    const seen = join(tmp, 'slots');
    const dir = join(tmp, 'board/leases/heavy');
    const step = `HEAVY_NOSLOT=$HEAVY_WRAPPER HEAVY_CLASS=gate-test-fast HEAVY_LABEL=step bash ${join(boardDir, 'heavy.sh')} --wait 0 -- bash -c 'ls ${dir} | wc -l >${seen}'`;
    const r = heavy(['--wait', '0', '--', 'bash', '-c', step], {
      HEAVY_CLASS: 'gate-wide',
      HEAVY_SLOT_CLASS: 'test',
      HEAVY_LABEL: 'gate:wide',
    });
    expect(r.code).toBe(0);
    expect(readFileSync(seen, 'utf8').trim()).toBe(String(cap)); // the outer's slot, none of the step's own
    expect(
      events()
        .filter((e) => e.kind === 'job')
        .map((e) => [e.label, e.class]),
    ).toEqual([
      ['step', 'gate-test-fast'],
      ['gate:wide', 'gate-wide'],
    ]);
    expect(leases()).toEqual([]);
  });

  it('HEAVY_NOSLOT from outside a slotted run is no way past the cap: it takes a slot, and waits', () => {
    limits({ enforce: true });
    const holder = liveSession();
    testSlots(cap, holder); // a live slot's wrapper, but not an ancestor of the run
    for (const v of ['1', String(process.pid), 'x', String(holder)]) {
      const r = heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test', HEAVY_NOSLOT: v });
      expect(r.code, v).toBe(75);
      expect(r.err).toMatch(/is no live slot above this run — taking a slot/);
    }
    expect(events().filter((e) => e.kind === 'job')).toEqual([]);
  });

  it('a `test` job inside a non-`test` slot (a narrow gate, a typecheck) still takes its own `test` slot', () => {
    limits({ enforce: true });
    testSlots(cap - 1); // the outer test-fast run takes no `test` place; the step finds the cap full only with it
    testSlots(1, liveSession());
    const step = `HEAVY_NOSLOT=$HEAVY_WRAPPER HEAVY_CLASS=test bash ${join(boardDir, 'heavy.sh')} --wait 0 -- true`;
    const r = heavy(['--', 'bash', '-c', step], {
      HEAVY_CLASS: 'gate-narrow',
      HEAVY_SLOT_CLASS: 'test-fast',
    });
    expect(r.code).toBe(75);
    expect(r.err).toMatch(/is no live slot above this run — taking a slot/);
  });

  it('HEAVY_SLOT_CLASS only raises a slot: anything but test/test-fast is ignored, a test job stays test', () => {
    limits({ enforce: true });
    testSlots(cap);
    for (const sc of ['other', 'test-file', 'test-fast']) {
      const r = heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test', HEAVY_SLOT_CLASS: sc });
      expect(r.code, sc).toBe(75);
    }
    expect(
      heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test', HEAVY_SLOT_CLASS: 'other' }).err,
    ).toMatch(/HEAVY_SLOT_CLASS=other ignored/);
  });

  it('is per class, and never touches single-file runs', () => {
    limits({ enforce: true });
    testSlots(cap);
    expect(heavy(['--', 'true'], { HEAVY_CLASS: 'typecheck' }).code).toBe(0);
    expect(heavy(['--', 'true'], { HEAVY_CLASS: 'test-file' }).code).toBe(0);
    expect(leases()).toEqual([]);
  });

  it('never holds a load test', () => {
    limits({ enforce: true });
    testSlots(cap);
    const r = heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test', HEAVY_LOADTEST: '1' });
    expect(r.code).toBe(0);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({ loadTest: true });
    expect(leases()).toEqual([]);
  });

  it('the guard denies a raw suite past the cap, records `denied`, and `cli.ts barriers` counts the holds', () => {
    limits({ enforce: true });
    testSlots(cap);
    const guard = fileURLToPath(
      new URL('../../../.claude/hooks/board-heavy-guard.sh', import.meta.url),
    );
    // Same cwd as heavy() below — one session. Without a claude ancestor (CI) both log pid 0 and the board tells
    // sessions apart by name (branch, else cwd), so a different cwd would read as a second session.
    const g = spawnSync('bash', [guard], {
      env,
      cwd: tmp,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pnpm test' } }),
      encoding: 'utf8',
    });
    const out = JSON.parse(g.stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toMatch(
      new RegExp(`the test cap is full \\(${full} running`),
    );
    expect(leases()).toEqual([
      expect.objectContaining({ action: 'denied', reason: 'cap', label: 'guard' }),
    ]);
    expect(heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test' }).code).toBe(75); // then held: gave up
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const r = spawnSync('node', [cli, 'barriers', join(tmp, 'board/history'), '7'], {
      env,
      encoding: 'utf8',
    });
    const j = spawnSync('node', [cli, 'barriers', join(tmp, 'board/history'), '--json'], {
      env,
      encoding: 'utf8',
    });
    expect(JSON.parse(j.stdout)).toMatchObject({
      days: 7,
      blocks: 1,
      denied: 1,
      gaveUp: 1,
      merged: 1,
    }); // --json isn't the days
    expect(r.stdout).toMatch(
      /1 block \(0\.1\/day\) · 0 waited · 1 gave up · 1 denied \(1 re-run, counted once\)/,
    );
  });

  // The board lock held by someone else for the whole test (e.g. a slow guard or a stuck waiter).
  async function holdLock(sec: number) {
    const c = spawn('flock', [join(tmp, 'lock'), 'sleep', String(sec)], { stdio: 'ignore' });
    children.push(c);
    await new Promise((r) => setTimeout(r, 300));
    return c;
  }
  const heavyAsync = (args: string[], extra: NodeJS.ProcessEnv) =>
    new Promise<number | null>((r) =>
      spawn('bash', [join(boardDir, 'heavy.sh'), ...args], {
        env: { ...env, ...extra },
        cwd: tmp,
        stdio: 'ignore',
      }).on('exit', (code) => r(code)),
    );

  it('lock busy and no decision ever: fails open at the deadline, logged as lockBusy (not a block)', async () => {
    limits({ enforce: true });
    await holdLock(15);
    expect(await heavyAsync(['--wait', '3', '--', 'true'], { HEAVY_CLASS: 'test' })).toBe(0);
    expect(leases()).toEqual([expect.objectContaining({ action: 'lockBusy', reason: 'lock' })]);
  }, 30000);

  it('held at the cap, then the lock stays busy: still gives up with 75 — never an unslotted suite past the cap', async () => {
    limits({ enforce: true });
    testSlots(cap);
    const run = heavyAsync(['--wait', '6', '--', 'true'], { HEAVY_CLASS: 'test' });
    await new Promise((r) => setTimeout(r, 1000)); // after its first (blocking) decision
    await holdLock(20);
    expect(await run).toBe(75);
    expect(leases()).toEqual([expect.objectContaining({ action: 'gaveUp', reason: 'cap' })]);
    expect(events().filter((e) => e.kind === 'job')).toEqual([]);
  }, 40000);

  it('enforce off: a busy lock never makes it wait on board plumbing', async () => {
    limits({ enforce: false });
    await holdLock(30);
    const t = Date.now();
    expect(await heavyAsync(['--wait', '60', '--', 'true'], { HEAVY_CLASS: 'test' })).toBe(0);
    expect(Date.now() - t).toBeLessThan(15000); // one 5 s lock attempt, not the 60 s wait
    expect(leases()).toEqual([]);
  }, 40000);

  it('with enforce off it runs at a full cap and logs wouldWait', () => {
    limits({ enforce: false });
    testSlots(cap);
    const r = heavy(['--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(new RegExp(`cap full \\(${full}\\) — running \\(enforce off`));
    expect(leases()).toEqual([expect.objectContaining({ action: 'wouldWait', reason: 'cap' })]);
  });
});

describe('warm.sh (the cache warm at lanes start)', () => {
  // A stub pnpm on PATH: records each call, and `typecheck` sleeps WARM_TC_SLEEP s (a slow cold tsc).
  function stub() {
    const bin = join(tmp, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/bash\necho "$*" >>"${join(tmp, 'pnpm.calls')}"\ncase "$*" in *typecheck*) sleep "\${WARM_TC_SLEEP:-0}" ;; esac\nexit 0\n`,
    );
    chmodSync(join(bin, 'pnpm'), 0o755);
    return { ...env, PATH: `${bin}:${env.PATH}` };
  }
  const calls = () => readFileSync(join(tmp, 'pnpm.calls'), 'utf8').trim().split('\n');
  const log = () => readFileSync(join(tmp, 'warm.log'), 'utf8');
  // a live heavy slot whose wrapper runs in `cwd` (a lane's gate, or another checkout's)
  function slotIn(cwd: string, label: string) {
    const c = spawn('sleep', ['300'], { cwd, stdio: 'ignore' });
    children.push(c);
    const dir = join(tmp, 'board/leases/heavy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `1-${c.pid}.json`),
      JSON.stringify({
        v: 1,
        pid: 1,
        class: 'test',
        label,
        wrapperPid: c.pid,
        wrapperStart: startOf(c.pid!),
        startedAt: new Date().toISOString(),
      }),
    );
  }

  it('runs typecheck then lint in one warm slot, logged as the cwd branch with no owner', () => {
    const wt = repo('lane-x');
    slotIn(tmp, 'gate:other-lane'); // another checkout's job: no yield
    const r = spawnSync('bash', [join(boardDir, 'warm.sh'), join(tmp, 'warm.log')], {
      env: { ...stub(), HEAVY_CLASS: 'test', HEAVY_NOSLOT: '1' }, // a caller's HEAVY_* never reaches it
      cwd: wt,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe(''); // all of it goes to the log
    expect(calls()).toEqual(['--silent typecheck', '--silent lint']);
    expect(log()).toMatch(/^warm: \S+ typecheck \+ lint in .*lane-x\n/);
    expect(log()).toMatch(/warm: typecheck exit 0 · \d+\.\d s\nwarm: lint exit 0 · \d+\.\d s\n/);
    expect(events().filter((e) => e.kind === 'job')).toEqual([
      expect.objectContaining({
        pid: 0,
        class: 'warm',
        label: 'warm:lane-x',
        branch: 'lane-x',
        exit: 0,
      }),
    ]);
    expect(readdirSync(join(tmp, 'board/leases/heavy'))).toHaveLength(1); // its own slot released
  });

  it('yields to a heavy job of its own worktree: stops before lint, exit 143, slot freed', async () => {
    const wt = repo('lane-y');
    const c = spawn('bash', [join(boardDir, 'warm.sh'), join(tmp, 'warm.log')], {
      env: { ...stub(), WARM_TC_SLEEP: '30' },
      cwd: wt,
      stdio: 'ignore',
    });
    children.push(c);
    const heavyDir = join(tmp, 'board/leases/heavy');
    // typecheck is running (so the slot is there too): the yield must cut a step short, not just skip one
    for (let i = 0; i < 100 && !existsSync(join(tmp, 'pnpm.calls')); i++)
      await new Promise((r) => setTimeout(r, 100));
    const own = JSON.parse(readFileSync(join(heavyDir, readdirSync(heavyDir)[0]!), 'utf8'));
    const cost = JSON.parse(readFileSync(join(boardDir, 'limits.json'), 'utf8')).classes.warm;
    expect(own).toMatchObject({ pid: 0, class: 'warm', label: 'warm:lane-y' });
    expect(own.cost).toEqual({ pids: cost.pids, anonMiB: cost.anonMiB });
    slotIn(wt, 'gate:lane-y');
    const code = await new Promise<number | null>((r) => c.on('exit', (n) => r(n)));
    expect(code).toBe(143);
    expect(log()).toMatch(/warm: yielding to gate:lane-y \(pid \d+\)/);
    expect(calls()).toEqual(['--silent typecheck']);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({
      class: 'warm',
      exit: 143,
      signal: 15,
    });
    expect(readdirSync(heavyDir)).toHaveLength(1); // only the lane's slot is left
  }, 30000);

  it('a box past the hard line skips it at once: exit 75, a gaveUp barrier, no run', () => {
    const wt = repo('lane-z');
    cgroup(3760, 2 * GiB); // + the warm class's 30 pids: past the 3768 hard line
    limits({ enforce: true });
    const r = spawnSync('bash', [join(boardDir, 'warm.sh'), join(tmp, 'warm.log')], {
      env: stub(),
      cwd: wt,
      encoding: 'utf8',
    });
    expect(r.status).toBe(75);
    expect(existsSync(join(tmp, 'pnpm.calls'))).toBe(false);
    expect(events().filter((e) => e.kind === 'job')).toEqual([]);
    expect(events().find((e) => e.kind === 'lease')).toMatchObject({
      action: 'gaveUp',
      class: 'warm',
    });
    expect(log()).toMatch(/tell the user|hard/);
  });
});

describe('board.sh status: conflicts and overlaps', () => {
  it('prints merge-tree conflicts above the overlaps, then the landed and stale lanes', () => {
    mkdirSync(join(tmp, 'board'), { recursive: true });
    writeFileSync(
      join(tmp, 'board/overlap.json'),
      JSON.stringify({
        v: 1,
        pairs: [
          { a: 'a', b: 'b', files: ['x.ts'], git: 'conflict' },
          { a: 'a', b: 'c', files: ['y.ts'], git: 'clean' },
        ],
        conflicts: [
          { a: 'a', b: 'main', files: ['z.ts'] },
          { a: 'a', b: 'b', files: ['x.ts', 'w.ts'] },
        ],
        landed: ['done'],
        stale: ['old'],
        messages: {},
      }),
    );
    const r = spawnSync('bash', [join(boardDir, 'board.sh'), 'status'], {
      env,
      cwd: tmp,
      encoding: 'utf8',
    });
    const lines = r.stdout.split('\n');
    const from = lines.indexOf('conflicts:');
    expect(lines.slice(from, from + 9)).toEqual([
      'conflicts:',
      '  a ✗ main: z.ts',
      '  a ✗ b: x.ts, w.ts',
      'overlaps:',
      '  a ↔ b: x.ts',
      '  a ↔ c: y.ts — merges clean',
      'landed, worktree not cleaned up: done',
      'stale (no commit in 7 days): old',
      expect.stringMatching(/^sampler: /),
    ]);
  });

  it('says how old the conflicts are once the last overlap run is 10 minutes back', () => {
    mkdirSync(join(tmp, 'board'), { recursive: true });
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const status = (t: string) => {
      writeFileSync(
        join(tmp, 'board/overlap.json'),
        JSON.stringify({ v: 1, t, pairs: [], conflicts: [{ a: 'a', b: 'main', files: ['z.ts'] }] }),
      );
      return spawnSync('bash', [join(boardDir, 'board.sh'), 'status'], {
        env,
        cwd: tmp,
        encoding: 'utf8',
      })
        .stdout.split('\n')
        .find((l) => l.startsWith('conflicts'));
    };
    expect(status(at(2))).toBe('conflicts:');
    expect(status(at(25))).toBe('conflicts (25 min old: is the sampler running?):');
  });
});

// The log-only budget (SESSION-BOARD.md → Budget): logged once per admission beside the decision, never changing it.
describe('the log-only budget', () => {
  const budgets = () => events().filter((e) => e.kind === 'budget');
  // a live slot held by a stand-in session's process, so gc keeps it
  function slotFile(cls: string, cmd?: string, pid = liveSession(), name = `${pid}-${cls}`) {
    const dir = join(tmp, 'board/leases/heavy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({
        v: 1,
        pid,
        class: cls,
        label: cls,
        wrapperPid: pid,
        wrapperStart: startOf(pid),
        startedAt: new Date().toISOString(),
        ...(cmd && { cmd }),
      }),
    );
    return pid;
  }
  // the outcome a caller can see: exit code, stderr without the timing line, and the lease (barrier) events
  const outcome = (r: { code: number | null; err: string }) => ({
    code: r.code,
    err: r.err.replace(/^heavy: \S+ exit .*$/m, ''),
    leases: events()
      .filter((e) => e.kind === 'lease')
      .map((e) => ({ ...e, t: null })),
  });

  it('a slotted run logs one budget event: its units, the held slots split by command, the live verdict', () => {
    const holder = slotFile('ui', 'pnpm devcheck --tier full');
    const r = heavy(
      [
        '--',
        'bash',
        '-c',
        'cat "$APERTURE_BOARD_DIR"/leases/heavy/*-*.json > "$0"',
        join(tmp, 'slots'),
      ],
      {
        HEAVY_CLASS: 'lint',
        HEAVY_LABEL: 'lint',
      },
    );
    expect(r.code).toBe(0);
    expect(budgets()).toEqual([
      expect.objectContaining({
        scope: 'job',
        class: 'lint',
        label: 'lint',
        unit: { as: 'lint', units: 1 },
        committed: expect.objectContaining({
          base: 0.5,
          slots: 0.5,
          held: [{ pid: holder, class: 'ui', as: 'ui-dev', units: 0.5 }],
        }),
        k: 1.3, // no mac-stats.json in the test board: the slow guess
        kWhy: 'unknown',
        allowed: 5,
        would: 'admit',
        actual: { verdict: 'grant', wait: false },
        enforce: false,
      }),
    ]);
    // the run's own slot file carries its command (the ui split needs it), cut to 160 chars
    expect(readFileSync(join(tmp, 'slots'), 'utf8')).toMatch(/"cmd":"bash -c cat /);
  });

  it('a run held and then granted logs once, at its first decision', async () => {
    limits({ enforce: true });
    const cap = JSON.parse(readFileSync(join(boardDir, 'limits.json'), 'utf8')).concurrency.test;
    for (let i = 0; i < cap - 1; i++) slotFile('test');
    const brief = spawnSync('bash', ['-c', 'sleep 5 >/dev/null 2>&1 & echo $!'], {
      encoding: 'utf8',
    });
    slotFile('test', undefined, Number(brief.stdout.trim()));
    const r = heavy(['--wait', '20', '--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(0);
    expect(budgets()).toHaveLength(1);
    expect(budgets()[0]).toMatchObject({
      actual: { verdict: 'cap-full', wait: true },
      would: 'wait',
    });
  }, 30000);

  it('changes no outcome: over budget, enforcing, missing or malformed, the run goes as it did without one', () => {
    const shippedLimits = JSON.parse(readFileSync(join(boardDir, 'limits.json'), 'utf8'));
    slotFile('test');
    const run = (budget: unknown) => {
      rmSync(join(tmp, 'board/history'), { recursive: true, force: true });
      limits({ enforce: true, budget });
      cgroup(3700, 2 * GiB); // past the hard line: the live rules hold it
      return heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'typecheck' });
    };
    const none = run(undefined);
    expect(none.code).toBe(75);
    const want = outcome(none);
    expect(budgets()).toEqual([]);
    for (const [budget, logs] of [
      [{ ...shippedLimits.budget, jobUnits: 1 }, true],
      [{ ...shippedLimits.budget, enforce: true }, true],
      [{ ...shippedLimits.budget, units: 'x' }, false],
      ['garbage', false],
    ] as const) {
      expect(outcome(run(budget))).toEqual(want);
      expect(budgets()).toHaveLength(logs ? 1 : 0);
    }
  });

  it('an unwritable events file costs the log line, never the hold: a job past the hard line still waits', () => {
    const day = new Date().toISOString().slice(0, 10);
    mkdirSync(join(tmp, `board/history/events-${day}.jsonl`), { recursive: true }); // a directory: every append fails
    limits({ enforce: true });
    cgroup(3700, 2 * GiB);
    // a throw out of decide-heavy would be lease.sh's fail-open grant: exit 0, not the hold's 75
    const r = heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(75);
    expect(r.err).toMatch(/still past the measured edge/);
  });

  it('a load test’s admission is logged and marked, for the report to leave out', () => {
    expect(heavy(['--', 'true'], { HEAVY_CLASS: 'lint', HEAVY_LOADTEST: '1' }).code).toBe(0);
    expect(budgets()).toEqual([expect.objectContaining({ class: 'lint', loadTest: true })]);
  });

  it('the guard’s decide-only call and an unslotted run log nothing', () => {
    const g = spawnSync(
      'bash',
      [
        '-c',
        `. "${join(boardDir, 'lib.sh')}"; . "${join(boardDir, 'lease.sh')}"; eval "$(sb_thresholds)"; sb_locked _heavy_try "" 0 test guard 0 0`,
      ],
      { env, cwd: tmp, encoding: 'utf8' },
    );
    expect(JSON.parse(g.stdout)).toMatchObject({ verdict: 'grant' });
    expect(heavy(['--', 'true'], { HEAVY_CLASS: 'test-file' }).code).toBe(0);
    expect(budgets()).toEqual([]);
  });

  it('board.sh status prints the units next to the old count, and nothing without a budget block', () => {
    slotFile('test');
    const status = () =>
      spawnSync('bash', [join(boardDir, 'board.sh'), 'status'], {
        env: { ...env, APERTURE_DEVLOCK_SOURCE: `file:${join(tmp, 'gh-lock')}` },
        cwd: tmp,
        encoding: 'utf8',
      }).stdout.split('\n');
    const lines = status();
    const at = lines.findIndex((l) => l.startsWith('heavy: 1 slot(s)'));
    expect(lines[at + 1]).toMatch(
      /^budget \(log-only\): jobs 3\.5\/5 · lanes 0\.5\/3\.46 · sessions \d+\/14 · k 1\.3 unknown$/,
    );
    limits({ budget: undefined });
    expect(status().some((l) => l.startsWith('budget'))).toBe(false);
  });

  it('off the container (no cgroup, the Mac): status prints no budget line, since it has no /proc to judge by', () => {
    slotFile('test');
    const tick = spawnSync('bash', [join(boardDir, 'sampler.sh'), '--print'], {
      env,
      encoding: 'utf8',
    }).stdout;
    const day = new Date().toISOString().slice(0, 10);
    mkdirSync(join(tmp, 'board/history'), { recursive: true });
    writeFileSync(join(tmp, `board/history/samples-${day}.jsonl`), tick);
    const r = spawnSync('bash', [join(boardDir, 'board.sh'), 'status'], {
      env: {
        ...env,
        APERTURE_CGROUP_DIR: join(tmp, 'no-cgroup'),
        APERTURE_DEVLOCK_SOURCE: `file:${join(tmp, 'gh-lock')}`,
      },
      cwd: tmp,
      encoding: 'utf8',
    });
    expect(r.stdout).toMatch(/^heavy: 1 slot\(s\)/m); // the Mac path ran
    expect(r.stdout).not.toMatch(/^budget/m);
  });
});

describe('sampler.sh lane phases', () => {
  // a process whose comm is `claude` (a copy of sleep), registered on `branch`: a session row for the sampler
  function claude(branch: string) {
    const bin = join(tmp, 'claude');
    if (!existsSync(bin)) {
      writeFileSync(bin, readFileSync('/bin/sleep'));
      chmodSync(bin, 0o755);
    }
    const c = spawn(bin, ['300'], { stdio: 'ignore' });
    children.push(c);
    mkdirSync(join(tmp, 'board/sessions'), { recursive: true });
    writeFileSync(
      join(tmp, 'board/sessions', `${c.pid}.json`),
      JSON.stringify({
        v: 1,
        pid: c.pid,
        pidStart: startOf(c.pid!),
        name: branch,
        branch,
        state: 'idle',
      }),
    );
    return c.pid!;
  }
  const lane = (branch: string, text: string) => {
    mkdirSync(join(tmp, 'board/lanes'), { recursive: true });
    writeFileSync(join(tmp, 'board/lanes', `${branch}.json`), text);
  };
  const phases = () => {
    const r = spawnSync('bash', [join(boardDir, 'sampler.sh'), '--print'], {
      env,
      encoding: 'utf8',
    });
    return Object.fromEntries(
      JSON.parse(r.stdout).sessions.map((s: { pid: number; phase: string | null }) => [
        s.pid,
        s.phase,
      ]),
    );
  };

  it('tags each session with its lane file’s phase; a torn lane file or none is null for that lane alone', () => {
    const a = claude('aa');
    const bb = claude('bb');
    const c = claude('cc');
    // the torn file sorts first: one jq over all of them stops there, so only the per-file fallback reads bb
    lane('aa', '{"v":1,"branch":"aa","pha');
    lane('bb', JSON.stringify({ v: 1, branch: 'bb', phase: 'gate' }, null, 2));
    expect(phases()).toMatchObject({ [a]: null, [bb]: 'gate', [c]: null });
  });

  it('a sampler.sh from before the phase field (no F5) still reads every row, phase null', () => {
    // sample.awk alone, fed a registered session on `aa` and a lanes file saying `gate`: with F5 the row says gate;
    // without it (the file list and -v set an old sampler.sh passes) the same row reads null
    const x = join(tmp, 'x');
    writeFileSync(`${x}.e`, '');
    writeFileSync(`${x}.sess`, '123\t\taa\taa\t\n');
    writeFileSync(`${x}.lanes`, 'aa\tgate\n');
    const tick = (f5: boolean) => {
      const files = [`${x}.e`, `${x}.sess`, `${x}.e`, `${x}.e`, ...(f5 ? [`${x}.lanes`] : []), '-'];
      const v = {
        F1: `${x}.e`,
        F2: `${x}.sess`,
        F3: `${x}.e`,
        F4: `${x}.e`,
        ...(f5 && { F5: `${x}.lanes` }),
      };
      const r = spawnSync(
        'awk',
        [
          '-f',
          join(boardDir, 'sample.awk'),
          ...Object.entries({
            ...v,
            page: 4096,
            hz: 100,
            interval: 30,
            prevOut: '/dev/null',
            statusOut: '/dev/null',
          }).flatMap(([k, val]) => ['-v', `${k}=${val}`]),
          ...files,
        ],
        { input: '123\t1\tclaude\t1\t1\t1\targs\n', encoding: 'utf8' },
      );
      return JSON.parse(r.stdout).sessions;
    };
    expect(tick(true)).toEqual([
      expect.objectContaining({ pid: 123, branch: 'aa', phase: 'gate' }),
    ]);
    expect(tick(false)).toEqual([expect.objectContaining({ pid: 123, branch: 'aa', phase: null })]);
  });
});
