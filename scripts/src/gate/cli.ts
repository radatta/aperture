// @aperture/scripts — `pnpm gate:fast` (docs/ops/GATE.md): a lane's inner-loop gate. Full `tsc -b` and full cached
// `eslint .` every time; tests only where the branch's diff can reach (plan.ts), each package's whole suite when a rule
// says so. The full suite runs on GitHub on every push (the Branch workflow), which gates the all-clear.
// The steps run at once, each under scripts/board/heavy.sh (measured and logged), inside one outer heavy.sh slot for the
// whole gate: a wide one counts as a full suite (docs/ops/GATE.md → What gate:fast runs).
// Plain `node` (Node 22 strips types): erasable syntax, node: builtins only.
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { modeOf, plan, isTest, type Change, type Plan } from './plan.ts';
import { PACKAGES } from './rules.ts';
import { run as execRun, type Run } from '../bot/sh.ts';

export const USAGE = `pnpm gate:fast [--full] [--dry-run] [--base <ref>]
  typecheck + lint in full and the tests the branch's diff can reach (vs the merge-base with <ref>, default
  origin/main: committed, staged, unstaged and untracked), all at once under one scripts/board/heavy.sh slot —
  a full-suite (\`test\`) slot when 3+ packages' tests or a whole suite run.
  --full     every package's whole suite (what CI runs), e.g. to reproduce a red Branch run
  --dry-run  print the plan; run nothing
  Exit: the first failing step's code in the order printed (75 = heavy.sh's cap gave up); every step still runs;
  128+n when interrupted.`;

export interface Opts {
  full: boolean;
  dryRun: boolean;
  base: string;
}

export function parseArgs(argv: string[]): Opts | string {
  const o: Opts = { full: false, dryRun: false, base: 'origin/main' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--full') o.full = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--base' && argv[i + 1] && !argv[i + 1]!.startsWith('-')) o.base = argv[++i]!;
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
// A wide run's vitest workers per package, app the long pole. A narrow run keeps heavy.sh's container cap (4).
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
const NARROW_WORKERS = 4; // limits.json tuning.test.maxWorkers
// Start order, longest first (measured 2026-11-18), so the long pole starts at once and short steps fill the gaps.
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

// Wide: 3+ packages' tests, or any whole suite (`test` class): the outer run takes one of the 2 full-suite slots.
export const isWide = (todo: Step[]) =>
  todo.filter((s) => s.label.startsWith('test')).length >= 3 ||
  todo.some((s) => s.env.HEAVY_CLASS === 'test');

export function steps(p: Plan, root: string, opts: Pick<Opts, 'full'>): Step[] {
  const step = (label: string, argv: string[], cls: string, cost: number): Step => ({
    label,
    argv,
    env: { HEAVY_CLASS: cls, HEAVY_LABEL: label, HEAVY_NOSLOT: '1' },
    cost,
  });
  // tsc and eslint log as gate-* classes: run beside the tests they're slower, and their solo baselines stay clean.
  const out: Step[] = [
    step('typecheck', ['pnpm', 'typecheck'], 'gate-typecheck', 1),
    step('lint', ['pnpm', 'lint'], 'gate-lint', 1),
  ];
  // The whole suite costs the whole budget: it starts once tsc and eslint are done, and runs alone.
  if (opts.full || p.full.length) return [...out, step('test', ['pnpm', 'test'], 'test', BUDGET)];
  const tests: { dir: string; s: Step }[] = [];
  for (const pkg of PACKAGES) {
    const mode = modeOf(p, pkg.dir);
    const pp = p.packages[pkg.dir]!;
    if (mode === 'full')
      tests.push({
        dir: pkg.dir,
        s: step(`test:${pkg.dir}`, ['pnpm', '--filter', pkg.name, 'test'], 'test', 0),
      });
    else if (mode === 'fast') {
      const files = [...pp.related, ...pp.tests].map((f) => `${root}/${f}`);
      const argv = ['pnpm', '--filter', pkg.name, 'exec', 'vitest', 'related', '--run'];
      // A named test always matches itself, so zero files then means a path or include drift: fail loudly.
      // Changed modules alone may reach no test, which is fine.
      argv.push(`--passWithNoTests=${pp.tests.length ? 'false' : 'true'}`, ...files);
      tests.push({ dir: pkg.dir, s: step(`test-fast:${pkg.dir}`, argv, 'test-fast', 0) });
    }
  }
  const wide = isWide([...out, ...tests.map((t) => t.s)]);
  for (const { dir, s } of tests) {
    const w = wide ? WIDE_WORKERS[dir]! : (PINNED[dir] ?? NARROW_WORKERS);
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

// What a step's heavy.sh gets: the caller's HEAVY_* (the outer run's own class and label), GATE_INNER and
// VITEST_MAX_WORKERS are dropped, so only the step's own reach it; colour on when the gate's output is a terminal.
export const stepEnv = (
  inherited: NodeJS.ProcessEnv,
  step: Step,
  tty = false,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(inherited))
    if (!k.startsWith('HEAVY_') && k !== 'GATE_INNER' && k !== 'VITEST_MAX_WORKERS') env[k] = v;
  if (tty) env.FORCE_COLOR = '1';
  return { ...env, ...step.env };
};

// The outer run: one heavy.sh slot for the whole gate. Wide holds a `test` slot (the 2-suite cap, its wait and its
// 75); narrow a `test-fast` one, uncapped. The event logs its own class, so the `test` history stays the suite's.
export const outerEnv = (wide: boolean): Record<string, string> => ({
  GATE_INNER: '1',
  HEAVY_CLASS: wide ? 'gate-wide' : 'gate-narrow',
  HEAVY_SLOT_CLASS: wide ? 'test' : 'test-fast',
  HEAVY_LABEL: wide ? 'gate:wide' : 'gate:narrow',
});

export interface Child {
  done: Promise<{ code: number; out: string }>; // stdout and stderr together, in arrival order
  stop: () => void; // TERM: heavy.sh stops its whole subtree
}
export type Exec = (step: Step, heavy: string, root: string) => Child;
export type Outer = (heavy: string, root: string, argv: string[], env: NodeJS.ProcessEnv) => number;
// Registers a handler for INT/TERM/HUP; returns its removal.
export type OnSignal = (fn: (code: number) => void) => () => void;

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
      const c = start(s);
      live.set(i, c);
      void c.done.then(({ code, out }) => {
        const sec = Math.round((now() - t0) / 100) / 10;
        results[i] = { code, out, sec };
        live.delete(i);
        free += cost(i);
        log(`── ${s.label} · ${code === 0 ? 'ok' : `exit ${code}`} · ${sec} s ──`);
        if (out.trim()) log(out.trimEnd());
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

const spawnExec: Exec = (step, heavy, root) => {
  const c = spawn(heavy, ['--', ...step.argv], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: stepEnv(process.env, step, !!process.stdout.isTTY),
  });
  const chunks: Buffer[] = [];
  c.stdout.on('data', (b: Buffer) => chunks.push(b));
  c.stderr.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<{ code: number; out: string }>((resolve) => {
    c.on('error', (err) => resolve({ code: 127, out: `couldn't start heavy.sh: ${err.message}` }));
    c.on('close', (code, sig) =>
      resolve({
        code: code ?? 128 + (sig ? (constants.signals[sig] ?? 15) : 15),
        out: Buffer.concat(chunks).toString('utf8'),
      }),
    );
  });
  return { done, stop: () => void c.kill('SIGTERM') };
};

const CLI = fileURLToPath(import.meta.url);
const spawnOuter: Outer = (heavy, root, argv, env) =>
  spawnSync(heavy, ['--', process.execPath, CLI, ...argv], { cwd: root, stdio: 'inherit', env })
    .status ?? 128 + 15;

const onProcessSignal: OnSignal = (fn) => {
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const hs = sigs.map((s) => [s, () => fn(128 + constants.signals[s])] as const);
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
// argv); that inner run re-plans quietly and runs the steps at once.
export async function main(argv: string[], deps: Partial<Deps> = {}): Promise<number> {
  const { run, exec, outer, onSignal, env } = { ...DEFAULTS, ...deps };
  const inner = env.GATE_INNER === '1';
  const log = inner ? () => {} : (deps.log ?? DEFAULTS.log);
  const out = deps.log ?? DEFAULTS.log;
  if (argv.some((a) => a === '-h' || a === '--help')) return (out(USAGE), 0);
  const opts = parseArgs(argv);
  if (typeof opts === 'string') return (out(`${opts}\n${USAGE}`), 2);
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
  log(
    wide
      ? `  at once, as a full suite: one \`test\` slot (the 2-suite cap), up to ${BUDGET} workers`
      : '  at once: one `test-fast` slot, uncapped',
  );
  if (opts.dryRun) {
    for (const s of todo) log(`  would run: ${s.label}`);
    return 0;
  }
  const heavy = `${root}/scripts/board/heavy.sh`;
  if (!inner) {
    const outerCaller: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env)) if (!k.startsWith('HEAVY_')) outerCaller[k] = v;
    return outer(heavy, root, argv, { ...outerCaller, ...outerEnv(wide) });
  }
  const t0 = Date.now();
  const h = schedule(todo, (s) => exec(s, heavy, root), out);
  let interrupted = 0;
  const off = onSignal((code) => {
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
