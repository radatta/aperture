// @aperture/scripts — `pnpm gate:fast` (docs/ops/GATE.md): a lane's inner-loop gate. Full `tsc -b` and full cached
// `eslint .` every time; tests only where the branch's diff can reach (plan.ts), each package's whole suite when a rule
// says so. The full suite runs on GitHub on every push (the Branch workflow), which gates the all-clear.
// Each step runs under scripts/board/heavy.sh, so the board sees it, budgets it and logs its peaks.
// Plain `node` (Node 22 strips types): erasable syntax, node: builtins only.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modeOf, plan, isTest, type Change, type Plan } from './plan.ts';
import { PACKAGES } from './rules.ts';
import { run as execRun, type Run } from '../bot/sh.ts';

export const USAGE = `pnpm gate:fast [--full] [--dry-run] [--base <ref>]
  typecheck + lint in full, then the tests the branch's diff can reach (vs the merge-base with <ref>, default
  origin/main: committed, staged, unstaged and untracked), each step under scripts/board/heavy.sh.
  --full     every package's whole suite (what CI runs), e.g. to reproduce a red Branch run
  --dry-run  print the plan; run nothing
  Exit: the first failing step's code (75 = heavy.sh's cap gave up); later steps still run.`;

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
}

// scripts pins 2 workers in its own test script (board-cli's deliberate waits); `exec vitest` bypasses that script.
const WORKERS: Record<string, string> = { scripts: '2' };

export function steps(p: Plan, root: string, opts: Pick<Opts, 'full'>): Step[] {
  const out: Step[] = [
    { label: 'typecheck', argv: ['pnpm', 'typecheck'], env: {} },
    { label: 'lint', argv: ['pnpm', 'lint'], env: {} },
  ];
  if (opts.full || p.full.length)
    return [...out, { label: 'test', argv: ['pnpm', 'test'], env: {} }];
  for (const pkg of PACKAGES) {
    const mode = modeOf(p, pkg.dir);
    const pp = p.packages[pkg.dir]!;
    if (mode === 'full')
      out.push({
        label: `test:${pkg.dir}`,
        argv: ['pnpm', '--filter', pkg.name, 'test'],
        env: { HEAVY_CLASS: 'test', HEAVY_LABEL: `test:${pkg.dir}` },
      });
    else if (mode === 'fast') {
      const files = [...pp.related, ...pp.tests].map((f) => `${root}/${f}`);
      out.push({
        label: `test-fast:${pkg.dir}`,
        argv: [
          'pnpm',
          '--filter',
          pkg.name,
          'exec',
          'vitest',
          'related',
          '--run',
          // A named test always matches itself, so zero files then means a path or include drift: fail loudly.
          // Changed modules alone may reach no test, which is fine.
          `--passWithNoTests=${pp.tests.length ? 'false' : 'true'}`,
          ...files,
        ],
        env: {
          HEAVY_CLASS: 'test-fast',
          HEAVY_LABEL: `test-fast:${pkg.dir}`,
          ...(WORKERS[pkg.dir] ? { VITEST_MAX_WORKERS: WORKERS[pkg.dir]! } : {}),
        },
      });
    }
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

export type Exec = (step: Step, heavy: string, root: string) => number;

// The caller's VITEST_MAX_WORKERS is dropped: heavy.sh sets the container cap, and a step sets its own (scripts: 2).
export const stepEnv = (inherited: NodeJS.ProcessEnv, step: Step): NodeJS.ProcessEnv => {
  const env = { ...inherited, ...step.env };
  if (!('VITEST_MAX_WORKERS' in step.env)) delete env.VITEST_MAX_WORKERS;
  return env;
};

const spawnExec: Exec = (step, heavy, root) => {
  const r = spawnSync(heavy, ['--', ...step.argv], {
    cwd: root,
    stdio: 'inherit',
    env: stepEnv(process.env, step),
  });
  return r.status ?? 128 + 15;
};

export function main(
  argv: string[],
  run: Run = execRun,
  exec: Exec = spawnExec,
  log = console.log,
): number {
  if (argv.some((a) => a === '-h' || a === '--help')) return (log(USAGE), 0);
  const opts = parseArgs(argv);
  if (typeof opts === 'string') return (log(`${opts}\n${USAGE}`), 2);
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
  if (opts.dryRun) {
    for (const s of todo) log(`  would run: ${s.label}`);
    return 0;
  }
  const heavy = `${root}/scripts/board/heavy.sh`;
  let code = 0;
  const results: string[] = [];
  for (const s of todo) {
    const c = exec(s, heavy, root);
    results.push(`${s.label} ${c === 0 ? 'ok' : `exit ${c}`}`);
    if (c !== 0 && code === 0) code = c;
  }
  log(`gate:fast — ${results.join(' · ')}`);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exit(main(process.argv.slice(2)));
