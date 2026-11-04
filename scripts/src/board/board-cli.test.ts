// End-to-end over the bash layer: board.sh / heavy.sh against a temp board, a fake cgroup, and real pids.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const boardDir = fileURLToPath(new URL('../../board/', import.meta.url));
const GiB = 1073741824;
const children: ChildProcess[] = [];
afterAll(() => children.forEach((c) => c.kill()));

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

  it('never takes a slot or waits for a single-file test run', () => {
    cgroup(3700, 2 * GiB);
    limits({ enforce: true });
    const r = heavy(['--', 'true'], { HEAVY_CLASS: 'test-file' });
    expect(r.code).toBe(0);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({ class: 'test-file' });
  });
});

describe('heavy.sh test cap', () => {
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
    testSlots(4);
    const r = heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test', HEAVY_LABEL: 'gate' });
    expect(r.code).toBe(75);
    expect(r.err).toMatch(/test cap full \(4\/4/);
    expect(r.err).toMatch(/tell the user/);
    expect(leases()).toEqual([
      expect.objectContaining({
        lease: 'heavy',
        action: 'gaveUp',
        reason: 'cap',
        class: 'test',
        label: 'gate',
        cap: { max: 4, running: 4, full: true },
        waitedSec: 0,
      }),
    ]);
    expect(leases()[0].holders).toHaveLength(4);
    expect(events().filter((e) => e.kind === 'job')).toEqual([]);
    expect(slotFiles()).toHaveLength(4); // no 5th slot
  });

  it('a freed slot lets it run, and the wait is recorded', async () => {
    limits({ enforce: true });
    testSlots(3);
    // an orphan (its bash parent exits at once), so init reaps it the moment it ends — like a real wrapper's
    // shell would; a direct child of this blocked test runner would linger as a zombie and keep its slot
    const brief = spawnSync('bash', ['-c', 'sleep 1.5 >/dev/null 2>&1 & echo $!'], {
      encoding: 'utf8',
    });
    testSlots(1, Number(brief.stdout.trim()));
    const r = heavy(['--wait', '20', '--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(0);
    const waited = leases().find((e) => e.action === 'waited');
    expect(waited).toMatchObject({ reason: 'cap', class: 'test', cap: { running: 4 } });
    expect(waited.waitedSec).toBeGreaterThanOrEqual(1);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({ class: 'test', exit: 0 });
  }, 30000);

  it('below the cap nothing changes: no wait, no barrier', () => {
    limits({ enforce: true });
    testSlots(3);
    const r = heavy(['--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/cap/);
    expect(leases()).toEqual([]);
  });

  it('is per class, and never touches single-file runs', () => {
    limits({ enforce: true });
    testSlots(4);
    expect(heavy(['--', 'true'], { HEAVY_CLASS: 'typecheck' }).code).toBe(0);
    expect(heavy(['--', 'true'], { HEAVY_CLASS: 'test-file' }).code).toBe(0);
    expect(leases()).toEqual([]);
  });

  it('never holds a load test', () => {
    limits({ enforce: true });
    testSlots(4);
    const r = heavy(['--wait', '0', '--', 'true'], { HEAVY_CLASS: 'test', HEAVY_LOADTEST: '1' });
    expect(r.code).toBe(0);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({ loadTest: true });
    expect(leases()).toEqual([]);
  });

  it('the guard denies a raw 5th suite, records `denied`, and `cli.ts barriers` counts the holds', () => {
    limits({ enforce: true });
    testSlots(4);
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
    expect(out.permissionDecisionReason).toMatch(/the test cap is full \(4\/4 running/);
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

  it('held at the cap, then the lock stays busy: still gives up with 75 — never a 5th unslotted suite', async () => {
    limits({ enforce: true });
    testSlots(4);
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
    testSlots(4);
    const r = heavy(['--', 'true'], { HEAVY_CLASS: 'test' });
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/cap full \(4\/4\) — running \(enforce off/);
    expect(leases()).toEqual([expect.objectContaining({ action: 'wouldWait', reason: 'cap' })]);
  });
});
