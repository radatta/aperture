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

  it('never takes a slot or waits for a single-file test run', () => {
    cgroup(3700, 2 * GiB);
    limits({ enforce: true });
    const r = heavy(['--', 'true'], { HEAVY_CLASS: 'test-file' });
    expect(r.code).toBe(0);
    expect(events().find((e) => e.kind === 'job')).toMatchObject({ class: 'test-file' });
  });
});
