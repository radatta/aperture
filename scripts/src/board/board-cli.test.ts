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

describe('board.sh dev lease', () => {
  it('grants, makes a second session wait, releases only for the holder', () => {
    const a = liveSession();
    const b = liveSession();
    expect(board(['register', '--pid', `${a}`, '--sid', 'sa', '--cwd', repo('feat-a')]).code).toBe(
      0,
    );
    expect(board(['register', '--pid', `${b}`, '--sid', 'sb', '--cwd', repo('feat-b')]).code).toBe(
      0,
    );

    const got = board(['--pid', `${a}`, 'lease', 'acquire', 'dev', '--note', 'round 1']);
    expect(got.code).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp, 'board/leases/dev.json'), 'utf8'))).toMatchObject({
      holderPid: a,
      branch: 'feat-a',
      ttlSec: 2700,
      note: 'round 1',
    });

    const blocked = board(['--pid', `${b}`, 'lease', 'acquire', 'dev']);
    expect(blocked.code).toBe(3);
    expect(blocked.err).toMatch(/dev held by feat-a \(feat-a\)/);
    expect(board(['--pid', `${b}`, 'lease', 'release', 'dev']).code).toBe(3);

    expect(board(['--pid', `${a}`, 'lease', 'release', 'dev']).code).toBe(0);
    expect(existsSync(join(tmp, 'board/leases/dev.json'))).toBe(false);
    expect(board(['--pid', `${b}`, 'lease', 'acquire', 'dev']).code).toBe(0);
  });

  it('takes over from a dead holder and prints the message to send', () => {
    const b = liveSession();
    board(['register', '--pid', `${b}`, '--cwd', repo('feat-b')]);
    mkdirSync(join(tmp, 'board/leases'), { recursive: true });
    const deadLease = {
      v: 1,
      holderPid: 4194303,
      holderStart: '1',
      holderName: 'flux',
      branch: 'flux',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      ttlSec: 2700,
    };
    writeFileSync(join(tmp, 'board/leases/dev.json'), JSON.stringify(deadLease));
    const r = board(['--pid', `${b}`, 'lease', 'acquire', 'dev']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/took over from flux \(flux\) — dead\. SendMessage `flux`/);
    expect(events().find((e) => e.kind === 'lease')).toMatchObject({
      action: 'takeover',
      reason: 'dead',
    });
  });

  it('keeps a gone holder’s lease until TTL and renews on the holder’s heartbeat', () => {
    const a = liveSession();
    board(['register', '--pid', `${a}`, '--cwd', repo('feat-a')]);
    board(['--pid', `${a}`, 'lease', 'acquire', 'dev', '--ttl', '60']);
    const before = JSON.parse(readFileSync(join(tmp, 'board/leases/dev.json'), 'utf8'));
    expect(board(['--pid', `${a}`, 'end']).code).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp, 'board/leases/dev.json'), 'utf8')).holderGone).toBe(
      true,
    );
    expect(board(['--pid', `${a}`, 'heartbeat', 'working']).code).toBe(0);
    const after = JSON.parse(readFileSync(join(tmp, 'board/leases/dev.json'), 'utf8'));
    expect(after.holderGone).toBeUndefined();
    expect(Date.parse(after.expiresAt)).toBeGreaterThanOrEqual(Date.parse(before.expiresAt));
  });
});

describe('board.sh dev lease after a restart', () => {
  it('hands a gone holder’s lease to the restarted session on its branch, not to another branch', () => {
    const a = liveSession();
    const dir = repo('feat-a');
    board(['register', '--pid', `${a}`, '--cwd', dir]);
    board(['--pid', `${a}`, 'lease', 'acquire', 'dev', '--note', 'dev-test round 1']);
    const granted = JSON.parse(readFileSync(join(tmp, 'board/leases/dev.json'), 'utf8'));
    board(['--pid', `${a}`, 'end']);
    const other = liveSession();
    board(['--pid', `${other}`, 'heartbeat', 'working', '--cwd', repo('feat-b')]);
    expect(JSON.parse(readFileSync(join(tmp, 'board/leases/dev.json'), 'utf8')).holderPid).toBe(a);
    const b = liveSession(); // the same branch, restarted: a new pid
    expect(board(['--pid', `${b}`, 'heartbeat', 'working', '--cwd', dir]).code).toBe(0);
    const lease = JSON.parse(readFileSync(join(tmp, 'board/leases/dev.json'), 'utf8'));
    expect(lease).toMatchObject({
      holderPid: b,
      branch: 'feat-a',
      acquiredAt: granted.acquiredAt, // the same dev test continuing
      note: 'dev-test round 1',
    });
    expect(lease.holderGone).toBeUndefined();
    expect(events().find((e) => e.reason === 'resumed')).toMatchObject({
      lease: 'dev',
      action: 'takeover',
    });
  });
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

describe('board.sh lease renew / register repair', () => {
  it('renew only renews your own lease: it never grants a free one or takes over another’s', () => {
    const a = liveSession();
    const b = liveSession();
    board(['register', '--pid', `${a}`, '--cwd', repo('feat-a')]);
    board(['register', '--pid', `${b}`, '--cwd', repo('feat-b')]);
    expect(board(['--pid', `${a}`, 'lease', 'renew', 'dev']).code).toBe(3); // free: no grant
    expect(existsSync(join(tmp, 'board/leases/dev.json'))).toBe(false);
    board(['--pid', `${a}`, 'lease', 'acquire', 'dev', '--ttl', '1']);
    spawnSync('sleep', ['1.2']); // a's lease expires
    expect(board(['--pid', `${b}`, 'lease', 'renew', 'dev']).code).toBe(3); // expired, but not b's
    expect(JSON.parse(readFileSync(join(tmp, 'board/leases/dev.json'), 'utf8')).holderPid).toBe(a);
    expect(board(['--pid', `${b}`, 'lease', 'acquire', 'dev']).code).toBe(0); // acquire may take it over
  });

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
    const g = spawnSync('bash', [guard], {
      env,
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
