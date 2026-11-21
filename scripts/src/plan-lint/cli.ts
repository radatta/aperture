// @aperture/scripts — `pnpm plan-lint [<file>] [--root <dir>]` (docs/ops/PLAN.md → _After Plan_): a lane's plan
// against the template's shape. Reads the plan and stats the paths it names; never runs or spawns anything.
// Plain `node`: erasable syntax, node: builtins only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint, type Tree } from './lint.ts';

export const USAGE = `pnpm plan-lint [<file>] [--root <dir>]
  checks a plan against docs/ops/PLAN.md: sections, census searches and counts, Unknowns evidence, invariant and
  pre-mortem counts, "fails when:" rows, placeholders, and that every backticked repo path (and :line) exists.
  <file>     default localNotes/plan.md under the root
  --root     the checkout the plan's paths are relative to (default: the nearest ancestor holding .git)
  Exit: 0 clean · 1 problems (one "<file>:<line>: <check>: <message>" line each) · 2 a bad argument or unreadable file`;

// The nearest ancestor of `from` with a .git entry (a worktree's is a file): no git spawn.
export function findRoot(from: string): string | undefined {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return undefined;
  }
}

export function fsTree(root: string): Tree {
  const lines = new Map<string, number | undefined>();
  return {
    root,
    topLevel: new Set(readdirSync(root)),
    exists: (p) => existsSync(join(root, p)),
    lineCount(p) {
      if (!lines.has(p))
        try {
          const f = join(root, p);
          lines.set(
            p,
            statSync(f).isFile()
              ? readFileSync(f, 'utf8').replace(/\n$/, '').split('\n').length
              : undefined,
          );
        } catch {
          lines.set(p, undefined);
        }
      return lines.get(p);
    },
  };
}

export function main(argv: string[], log = console.log, cwd = process.cwd()): number {
  if (argv.some((a) => a === '-h' || a === '--help')) return (log(USAGE), 0);
  let file: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--root' && argv[i + 1] && !argv[i + 1]!.startsWith('-'))
      root = resolve(cwd, argv[++i]!);
    else if (!a.startsWith('-') && file === undefined) file = a;
    else return (log(`plan-lint — unknown argument ${JSON.stringify(a)}\n${USAGE}`), 2);
  }
  root ??= findRoot(cwd);
  if (!root || !existsSync(root) || !statSync(root).isDirectory())
    return (log(`plan-lint — no checkout root (pass --root <dir>)`), 2);
  const path = file
    ? isAbsolute(file)
      ? file
      : resolve(cwd, file)
    : join(root, 'localNotes/plan.md');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return (log(`plan-lint — can't read ${path}: ${(err as Error).message.split('\n')[0]}`), 2);
  }
  const { mode, problems } = lint(text, fsTree(root));
  const shown = file ?? 'localNotes/plan.md';
  for (const p of problems) log(`${shown}:${p.line}: ${p.check}: ${p.message}`);
  log(
    `plan-lint: ${problems.length} problem${problems.length === 1 ? '' : 's'} (${mode ?? 'no template line'})`,
  );
  return problems.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exit(main(process.argv.slice(2)));
