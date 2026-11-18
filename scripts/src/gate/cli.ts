// @aperture/scripts — `pnpm gate:fast` (docs/ops/GATE.md): a lane's inner-loop gate. Full `tsc -b` and full cached
// `eslint .` every time; tests only where the branch's diff can reach (plan.ts), each package's whole suite when a rule
// says so. The full suite runs on GitHub on every push (the Branch workflow), which gates the all-clear.
// The steps run at once, each under scripts/board/heavy.sh (measured and logged), inside one outer heavy.sh slot for the
// whole gate: a wide one counts as a full suite (docs/ops/GATE.md → What gate:fast runs).
// Plain `node` (Node 22 strips types): erasable syntax, node: builtins only.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { modeOf, plan, isTest, type Change, type Plan } from './plan.ts';
import { PACKAGES } from './rules.ts';
import { run as execRun, type Run } from '../bot/sh.ts';

export const USAGE = `pnpm gate:fast [--full] [--dry-run] [--base <ref>] [--wait <sec>]
  typecheck + lint in full and the tests the branch's diff can reach (vs the merge-base with <ref>, default
  origin/main: committed, staged, unstaged and untracked), all at once under one scripts/board/heavy.sh slot —
  a full-suite (\`test\`) slot when 3+ packages' tests or a whole suite run.
  --full     every package's whole suite (what CI runs), e.g. to reproduce a red Branch run
  --dry-run  print the plan; run nothing
  --wait     how long heavy.sh waits for a slot before giving up with 75 (default 90 s)
  Exit: the first failing step's code in the order printed (75 = heavy.sh's cap gave up); every step still runs;
  128+n when interrupted.`;

export interface Opts {
  full: boolean;
  dryRun: boolean;
  base: string;
  wait?: string;
}

export function parseArgs(argv: string[]): Opts | string {
  const o: Opts = { full: false, dryRun: false, base: 'origin/main' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--full') o.full = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--base' && argv[i + 1] && !argv[i + 1]!.startsWith('-')) o.base = argv[++i]!;
    else if (a === '--wait' && /^\d+$/.test(argv[i + 1] ?? '')) o.wait = argv[++i]!;
    else return `unknown argument ${JSON.stringify(a)}`;
  }
  return o;
}

// -z everywhere: without it git quotes a non-ASCII path, which then matches no rule and no package.
const fields = (s: string) => s.split('\0').filter(Boolean);

// The branch's changes against the merge-base: committed + staged + unstaged in one diff (--no-renames: a move is a
// delete and an add), plus untracked files. Every test file the planner may name, tracked or new.
export function readDiff(run: Run, base: string): { changes: Change[]; testFiles: string[] } {
  const mb = run('git', ['merge-base', base, 'HEAD']);
  const diff = fields(run('git', ['diff', '--name-status', '--no-renames', '-z', mb]));
  const changes: Change[] = [];
  for (let i = 0; i + 1 < diff.length; i += 2)
    changes.push({ path: diff[i + 1]!, deleted: diff[i] === 'D' });
  const untracked = fields(run('git', ['ls-files', '-z', '--others', '--exclude-standard']));
  for (const path of untracked) changes.push({ path, deleted: false });
  const testFiles = [...fields(run('git', ['ls-files', '-z'])), ...untracked].filter(isTest);
  return { changes, testFiles };
}

export interface Step {
  label: string;
  argv: string[]; // run under heavy.sh, from the repo root
  env: Record<string, string>; // HEAVY_CLASS / HEAVY_LABEL / VITEST_MAX_WORKERS: env, never argv
  cost: number; // tokens out of BUDGET while it runs: its vitest workers, 1 for tsc or eslint (one core each)
}

// Every step runs at once under one outer heavy.sh slot (main), as many as BUDGET allows. A full `pnpm test` keeps
// ~8–9 cores busy (VITEST_MAX_WORKERS 4 per package, pnpm's 4 packages at once); a wide gate's steps together aim
// for about that: their workers plus tsc and eslint, single-threaded.
export const BUDGET = 10;
// Vitest workers per package when a gate runs 2+ packages besides scripts, app the long pole: a wide gate, or a narrow
// one that would otherwise run two 4-worker packages at once (a suite's load, uncapped). One package keeps 4.
export const WIDE_WORKERS: Record<string, number> = {
  app: 4,
  extension: 2,
  lambdas: 2,
  cdk: 2,
  scripts: 2,
  'packages/shared': 1,
};
// scripts pins 2 workers in its own test script (board-cli's deliberate waits); `exec vitest` bypasses that script.
const PINNED: Record<string, number> = { scripts: 2 };
export const NARROW_WORKERS = 4; // limits.json tuning.test.maxWorkers (a test pins it)
// Start order, longest first (measured 2026-11-17), so the long pole starts at once and short steps fill the gaps.
const RANK = [
  'app',
  'extension',
  'typecheck',
  'scripts',
  'lint',
  'cdk',
  'lambdas',
  'packages/shared',
];
export const rank = (s: Step) => {
  const i = RANK.indexOf(s.label.split(':').at(-1)!);
  return i < 0 ? RANK.length : i;
};

const isTestStep = (s: Step) => s.label === 'test' || /^test(-fast)?:/.test(s.label);
// Wide: 3+ packages' tests, or any whole suite: the outer run takes one of the 2 full-suite slots.
export const isWide = (todo: Step[]) =>
  todo.filter(isTestStep).length >= 3 ||
  todo.some((s) => s.label === 'test' || s.label.startsWith('test:'));

export function steps(p: Plan, root: string, opts: Pick<Opts, 'full'>): Step[] {
  const step = (label: string, argv: string[], cls: string, cost: number): Step => ({
    label,
    argv,
    env: { HEAVY_CLASS: cls, HEAVY_LABEL: label },
    cost,
  });
  // Every step logs a gate-* class: run beside each other they're slower, and the solo baselines (typecheck, lint,
  // test) and the board's slot-job counts stay clean. The outer run is the gate's one slot job.
  const out: Step[] = [
    step('typecheck', ['pnpm', 'typecheck'], 'gate-typecheck', 1),
    step('lint', ['pnpm', 'lint'], 'gate-lint', 1),
  ];
  // The whole suite costs the whole budget: it starts once tsc and eslint are done, and runs alone.
  if (opts.full || p.full.length) {
    const all = step('test', ['pnpm', 'test'], 'gate-test', BUDGET);
    all.env.VITEST_MAX_WORKERS = String(NARROW_WORKERS); // per package, as heavy.sh gives a plain suite
    return [...out, all];
  }
  const tests: { dir: string; s: Step }[] = [];
  for (const pkg of PACKAGES) {
    const mode = modeOf(p, pkg.dir);
    const pp = p.packages[pkg.dir]!;
    if (mode === 'full')
      tests.push({
        dir: pkg.dir,
        s: step(`test:${pkg.dir}`, ['pnpm', '--filter', pkg.name, 'test'], 'gate-test', 0),
      });
    else if (mode === 'fast') {
      const files = [...pp.related, ...pp.tests].map((f) => `${root}/${f}`);
      const argv = ['pnpm', '--filter', pkg.name, 'exec', 'vitest', 'related', '--run'];
      // A named test always matches itself, so zero files then means a path or include drift: fail loudly.
      // Changed modules alone may reach no test, which is fine.
      argv.push(`--passWithNoTests=${pp.tests.length ? 'false' : 'true'}`, ...files);
      tests.push({ dir: pkg.dir, s: step(`test-fast:${pkg.dir}`, argv, 'gate-test-fast', 0) });
    }
  }
  const split = tests.filter((t) => t.dir !== 'scripts').length > 1;
  for (const { dir, s } of tests) {
    const w = split ? WIDE_WORKERS[dir]! : (PINNED[dir] ?? NARROW_WORKERS);
    s.env.VITEST_MAX_WORKERS = String(w);
    s.cost = w;
    out.push(s);
  }
  return out;
}

export function describePlan(
  p: Plan,
  changes: Change[],
  base: string,
  opts: Pick<Opts, 'full'>,
): string {
  const out = [`gate:fast — ${changes.length} changed path(s) vs merge-base with ${base}`];
  if (opts.full) out.push('  --full: every package’s whole suite');
  else if (p.full.length)
    out.push(
      `  full suite: ${p.full.slice(0, 3).join('; ')}${p.full.length > 3 ? ` (+${p.full.length - 3})` : ''}`,
    );
  else
    for (const pkg of PACKAGES) {
      const mode = modeOf(p, pkg.dir);
      const pp = p.packages[pkg.dir]!;
      if (mode === 'full') out.push(`  ${pkg.dir}: whole suite — ${pp.full.join('; ')}`);
      else if (mode === 'skip') out.push(`  ${pkg.dir}: skipped — nothing in the diff reaches it`);
      else {
        out.push(
          `  ${pkg.dir}: tests related to ${pp.related.length} changed module(s), plus ${pp.tests.length} named:`,
        );
        for (const t of pp.tests) out.push(`    ${t} (${pp.why[t]})`);
      }
    }
  for (const n of p.notes) out.push(`  note: ${n}`);
  out.push(
    '  the full suite runs on GitHub on every push (Branch workflow); the all-clear needs it green',
  );
  return out.join('\n');
}

// What a step's heavy.sh gets: the caller's HEAVY_* (the outer run's own class and label), GATE_* and
// VITEST_MAX_WORKERS are dropped, so only the step's own reach it, plus HEAVY_NOSLOT naming the outer heavy.sh (its
// HEAVY_WRAPPER): the step runs inside that slot, not one of its own. Colour on when the output is a terminal.
export const stepEnv = (
  inherited: NodeJS.ProcessEnv,
  step: Step,
  tty = false,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(inherited))
    if (!k.startsWith('HEAVY_') && !k.startsWith('GATE_') && k !== 'VITEST_MAX_WORKERS') env[k] = v;
  if (inherited.HEAVY_WRAPPER) env.HEAVY_NOSLOT = inherited.HEAVY_WRAPPER;
  if (tty) env.FORCE_COLOR = '1';
  return { ...env, ...step.env };
};

// The outer run: one heavy.sh slot for the whole gate. Wide holds a `test` slot (the 2-suite cap, its wait and its
// 75); narrow a `test-fast` one, uncapped. The event logs its own class, so the `test` history stays the suite's.
// GATE_WIDE carries the caller's verdict to the inner pass, which refuses a plan wider than its slot.
export const outerEnv = (wide: boolean): Record<string, string> => ({
  GATE_INNER: '1',
  GATE_WIDE: wide ? '1' : '0',
  HEAVY_CLASS: wide ? 'gate-wide' : 'gate-narrow',
  HEAVY_SLOT_CLASS: wide ? 'test' : 'test-fast',
  HEAVY_LABEL: wide ? 'gate:wide' : 'gate:narrow',
});

export interface Child {
  done: Promise<{ code: number; out: string }>; // stdout and stderr together, in arrival order
  stop: () => void; // TERM: heavy.sh stops its whole subtree
}
export type Exec = (step: Step, heavy: string, root: string) => Child;
// Runs heavy.sh with `args` (its own, then `--` and the inner pass) and resolves its exit code.
export type Outer = (
  heavy: string,
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<number>;
// Registers a handler for INT/TERM/HUP (given the signal's name and 128+n); returns its removal.
export type OnSignal = (fn: (sig: NodeJS.Signals, code: number) => void) => () => void;

export interface Result {
  code: number;
  out: string;
  sec: number;
}

// Starts steps by rank while their cost fits in what's free (a later, smaller step may start ahead of one that
// doesn't fit); a step costing more than the budget runs alone. Each finished step prints as one block.
export function schedule(
  todo: Step[],
  start: (s: Step) => Child,
  log: (l: string) => void,
  budget = BUDGET,
  now = () => Date.now(),
): { done: Promise<Result[]>; stop: () => void } {
  const pending = [...todo.keys()].sort((a, b) => rank(todo[a]!) - rank(todo[b]!) || a - b);
  const results: Result[] = new Array(todo.length);
  const live = new Map<number, Child>();
  let free = budget;
  let stopped = false;
  let resolve!: (r: Result[]) => void;
  const done = new Promise<Result[]>((r) => (resolve = r));
  const cost = (i: number) => Math.min(todo[i]!.cost, budget);
  const finish = (i: number, t0: number, code: number, out: string) => {
    const s = todo[i]!;
    const sec = Math.round((now() - t0) / 100) / 10;
    results[i] = { code, out, sec };
    live.delete(i);
    free += cost(i);
    log(`── ${s.label} · ${code === 0 ? 'ok' : `exit ${code}`} · ${sec} s ──`);
    if (out.trim()) log(out.trimEnd());
  };
  const pump = () => {
    if (stopped)
      for (const i of pending.splice(0))
        results[i] = { code: 128 + 15, out: 'not started: interrupted', sec: 0 };
    for (let k = 0; k < pending.length;) {
      const i = pending[k]!;
      if (cost(i) > free) {
        k++;
        continue;
      }
      pending.splice(k, 1);
      free -= cost(i);
      const s = todo[i]!;
      const t0 = now();
      log(
        `▶ ${s.label}${s.env.VITEST_MAX_WORKERS ? ` (${s.env.VITEST_MAX_WORKERS} workers)` : ''}`,
      );
      let c: Child;
      try {
        c = start(s);
      } catch (err) {
        finish(i, t0, 127, `couldn't start: ${(err as Error).message}`); // e.g. EMFILE: never an orphaned run
        continue;
      }
      live.set(i, c);
      void c.done.then(({ code, out }) => {
        finish(i, t0, code, out);
        pump();
      });
    }
    if (!pending.length && !live.size) resolve(results);
  };
  pump();
  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const c of live.values()) c.stop();
      pump();
    },
  };
}

const sigCode = (sig: NodeJS.Signals | null) => 128 + (sig ? (constants.signals[sig] ?? 15) : 15);

// A step is done when heavy.sh exits; its pipes get 2 s to drain, so a leftover holder (a stray worker, the sampler's
// last `sleep 1`) can't hold the gate open.
export const spawnExec: Exec = (step, heavy, root) => {
  const c = spawn(heavy, ['--', ...step.argv], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: stepEnv(process.env, step, !!process.stdout.isTTY),
  });
  const chunks: Buffer[] = [];
  c.stdout.on('data', (b: Buffer) => chunks.push(b));
  c.stderr.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<{ code: number; out: string }>((resolve) => {
    const out = () => Buffer.concat(chunks).toString('utf8');
    c.on('error', (err) => resolve({ code: 127, out: `couldn't start heavy.sh: ${err.message}` }));
    c.on('exit', (code, sig) => {
      const r = code ?? sigCode(sig);
      const t = setTimeout(() => {
        c.stdout.destroy();
        c.stderr.destroy();
        resolve({ code: r, out: out() });
      }, 2000);
      c.on('close', () => (clearTimeout(t), resolve({ code: r, out: out() })));
    });
  });
  return { done, stop: () => void c.kill('SIGTERM') };
};

const CLI = fileURLToPath(import.meta.url);

// The caller pass waits on the outer heavy.sh and forwards INT/TERM/HUP to it (heavy.sh stops its whole subtree),
// so a signal to this pid alone never leaves the gate running unowned.
export const spawnOuter: Outer = (heavy, root, args, env) =>
  new Promise((resolve) => {
    const c = spawn(heavy, args, { cwd: root, stdio: 'inherit', env });
    let got = 0;
    const off = onProcessSignal((sig, code) => {
      got ||= code;
      c.kill(sig);
    });
    c.on('error', (err) => {
      off();
      console.error(`gate:fast — couldn't start heavy.sh: ${err.message}`);
      resolve(127);
    });
    c.on('exit', (code, sig) => {
      off();
      resolve(got || (code ?? sigCode(sig)));
    });
  });

const onProcessSignal: OnSignal = (fn) => {
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const hs = sigs.map((s) => [s, () => fn(s, 128 + constants.signals[s])] as const);
  for (const [s, h] of hs) process.on(s, h);
  return () => {
    for (const [s, h] of hs) process.off(s, h);
  };
};

export interface Deps {
  run: Run;
  exec: Exec;
  outer: Outer;
  onSignal: OnSignal;
  log: (l: string) => void;
  env: NodeJS.ProcessEnv;
}
const DEFAULTS: Deps = {
  run: execRun,
  exec: spawnExec,
  outer: spawnOuter,
  onSignal: onProcessSignal,
  log: console.log,
  env: process.env,
};

// Two passes: the caller plans, prints and re-runs this CLI under one heavy.sh slot (GATE_INNER=1, env, never
// argv); that inner pass re-plans quietly and runs the steps at once.
export async function main(argv: string[], deps: Partial<Deps> = {}): Promise<number> {
  const { run, exec, outer, onSignal, env } = { ...DEFAULTS, ...deps };
  const out = deps.log ?? DEFAULTS.log;
  const inner = env.GATE_INNER === '1';
  const log = inner ? () => {} : out;
  if (argv.some((a) => a === '-h' || a === '--help')) return (out(USAGE), 0);
  const opts = parseArgs(argv);
  if (typeof opts === 'string') return (out(`${opts}\n${USAGE}`), 2);
  if (inner && !env.HEAVY_WRAPPER)
    return (out('gate:fast — the inner pass runs only under heavy.sh: run `pnpm gate:fast`'), 2);
  const root = run('git', ['rev-parse', '--show-toplevel']);
  let diff: ReturnType<typeof readDiff>;
  try {
    diff = readDiff(run, opts.base);
  } catch (err) {
    // A diff we can't read is no reason to skip tests: run them all.
    log(
      `gate:fast — couldn't read the diff (${(err as Error).message.split('\n')[0]}): running the full suite`,
    );
    diff = { changes: [], testFiles: [] };
  }
  const p = plan(diff.changes, diff.testFiles);
  log(describePlan(p, diff.changes, opts.base, opts));
  const todo = steps(p, root, opts);
  const wide = isWide(todo);
  const whole = todo.some((s) => s.label === 'test');
  log(
    whole
      ? '  as a full suite: one `test` slot (the 2-suite cap); typecheck and lint at once, then the suite alone'
      : wide
        ? `  at once, as a full suite: one \`test\` slot (the 2-suite cap), up to ${BUDGET} tokens (workers + tsc + eslint)`
        : `  at once: one \`test-fast\` slot, uncapped, up to ${BUDGET} tokens`,
  );
  if (opts.dryRun) {
    for (const s of todo) log(`  would run: ${s.label}`);
    return 0;
  }
  const heavy = `${root}/scripts/board/heavy.sh`;
  if (!inner) {
    const caller: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env))
      if (!k.startsWith('HEAVY_') && !k.startsWith('GATE_')) caller[k] = v;
    const args = [
      ...(opts.wait ? ['--wait', opts.wait] : []),
      '--',
      process.execPath,
      CLI,
      ...argv,
    ];
    return outer(heavy, root, args, { ...caller, ...outerEnv(wide) });
  }
  // The diff can widen during the slot wait (a background gate, files still being written): never run a wide plan
  // inside a narrow slot.
  if (wide && env.GATE_WIDE !== '1')
    return (
      out(
        'gate:fast — the diff widened since the plan (now a full-suite run): run `pnpm gate:fast` again',
      ),
      2
    );
  const t0 = Date.now();
  const h = schedule(todo, (s) => exec(s, heavy, root), out);
  let interrupted = 0;
  const off = onSignal((_sig, code) => {
    interrupted ||= code;
    h.stop();
  });
  const results = await h.done;
  off();
  out(
    `gate:fast — ${todo.map((s, i) => `${s.label} ${results[i]!.code === 0 ? 'ok' : `exit ${results[i]!.code}`}`).join(' · ')} · ${Math.round((Date.now() - t0) / 1000)} s`,
  );
  if (interrupted) return interrupted;
  return results.find((r) => r.code !== 0)?.code ?? 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main(process.argv.slice(2)).then((code) => process.exit(code));
