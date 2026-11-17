// @aperture/scripts — `pnpm gate:fast`'s decision, pure: a branch's changed paths + rules.ts → which packages run
// their whole suite, and which run `vitest related` on the changed modules plus named test files. Every choice carries
// its reason, printed by cli.ts. Unknown means run more: an empty diff, a path no rule or graph can judge, or a deleted
// source file widens the run, never narrows it (docs/ops/GATE.md).
import { touchesFixtureInputs, FIXTURE_SUITE } from '../fixture-inputs.ts';
import {
  ALWAYS_RUN,
  INPUT_RULES,
  MAX_CHANGED,
  MODULE_EXT,
  PACKAGE_FULL,
  PACKAGES,
  REPO_FULL,
  type Pkg,
} from './rules.ts';

export interface Change {
  path: string; // repo-relative
  deleted: boolean;
}

export interface PkgPlan {
  full: string[]; // why the whole suite runs; empty = fast
  related: string[]; // changed modules for `vitest related` (repo-relative; any package's)
  tests: string[]; // named test files in this package (repo-relative)
  why: Record<string, string>; // test file → the rule that named it
}

export interface Plan {
  full: string[]; // why everything runs; empty = per package
  packages: Record<string, PkgPlan>;
  notes: string[];
}

const TEST_FILE = /\.test\.(?:ts|tsx|mts|js)$/;
export const isTest = (p: string) => TEST_FILE.test(p);

// `dir/` prefix, `*` within a segment, `**/` any directories, else exact.
export function matches(pattern: string, path: string): boolean {
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (!pattern.includes('*')) return path === pattern;
  const re = pattern
    .split(/(\*\*\/|\*)/)
    .map((t) =>
      t === '**/' ? '(?:[^/]+/)*' : t === '*' ? '[^/]*' : t.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${re}$`).test(path);
}

const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export const pkgOf = (path: string): Pkg | undefined =>
  PACKAGES.find((p) => path.startsWith(`${p.dir}/`));

// A rule's `tests` entry: a file, or every test file under a `dir/`.
const expand = (entry: string, testFiles: string[]) =>
  entry.endsWith('/') ? testFiles.filter((t) => t.startsWith(entry)) : [entry];

// The test vitest pairs with a source file by name, if there is one (`x.ts` → `x.test.ts`/`.tsx`).
const siblingTest = (path: string, testFiles: Set<string>) => {
  const stem = path.replace(/\.(?:ts|tsx|mts|js|jsx|mjs)$/, '');
  if (stem === path) return undefined;
  return [`${stem}.test.ts`, `${stem}.test.tsx`].find((t) => testFiles.has(t));
};

// `__snapshots__/x.test.ts.snap` belongs to exactly one test: `x.test.ts` beside the folder.
const snapshotOwner = (path: string) => {
  const m = /^(.*\/)__snapshots__\/([^/]+)\.snap$/.exec(path);
  return m ? `${m[1]}${m[2]}` : undefined;
};

export function plan(changes: Change[], testFiles: string[]): Plan {
  const tests = new Set(testFiles);
  const out: Plan = {
    full: [],
    notes: [],
    packages: Object.fromEntries(
      PACKAGES.map((p) => [p.dir, { full: [], related: [], tests: [], why: {} } as PkgPlan]),
    ),
  };
  const fullPkg = (dir: string, why: string) => out.packages[dir]!.full.push(why);
  const addTest = (t: string, why: string) => {
    const pkg = pkgOf(t);
    if (!pkg) return out.notes.push(`${t}: not in a test package (rules.ts)`);
    const p = out.packages[pkg.dir]!;
    if (!p.tests.includes(t)) p.tests.push(t);
    p.why[t] ??= why;
  };

  const paths = changes.map((c) => c.path);
  if (!paths.length) out.full.push('empty diff: nothing to judge, so everything runs');
  if (paths.length > MAX_CHANGED)
    out.full.push(
      `${paths.length} changed paths (over ${MAX_CHANGED}): the selection would be most of the suite`,
    );

  const unknownOutside: string[] = [];
  for (const { path, deleted } of changes) {
    let claimed = false; // a rule decided what this path runs
    for (const r of REPO_FULL)
      if (r.match.some((m) => matches(m, path))) {
        claimed = true;
        out.full.push(`${path}: ${r.why}`);
      }
    // A `<pkg>/…` pattern is tried once per package; any other names one package's path, and runs that package.
    const owning = pkgOf(path);
    for (const r of PACKAGE_FULL)
      for (const p of PACKAGES)
        if (
          r.match.some(
            (m) =>
              matches(m.replace('<pkg>', p.dir), path) && (m.includes('<pkg>') || p === owning),
          )
        ) {
          claimed = true;
          fullPkg(p.dir, `${path}: ${r.why}`);
        }

    const owner = snapshotOwner(path);
    if (owner) {
      claimed = true;
      if (tests.has(owner)) addTest(owner, `its snapshot ${path} changed`);
      else if (pkgOf(path)) fullPkg(pkgOf(path)!.dir, `${path}: a snapshot with no test beside it`);
    }
    for (const r of INPUT_RULES)
      if (r.inputs.some((m) => matches(m, path))) {
        claimed = true;
        for (const e of r.tests)
          for (const t of expand(e, testFiles)) addTest(t, `${path} → ${r.why}`);
      }

    const pkg = pkgOf(path);
    if (!pkg) {
      if (!claimed) unknownOutside.push(path);
      continue;
    }
    if (isTest(path)) {
      if (!deleted) addTest(path, 'changed');
    } else if (deleted) {
      // A deleted code module's importers either changed (so they're in `related`) or no longer typecheck (tsc -b runs
      // in full every gate). Not so a deleted .css/.json: an ambient declaration can still type its import. A deleted
      // file something reads from disk is a rule's input, so `claimed` ran its tests.
      if (!claimed && !CODE_EXT.test(path))
        fullPkg(pkg.dir, `${path}: deleted, and no rule or import graph sees it`);
    } else if (owner) {
      // handled above
    } else if (MODULE_EXT.test(path)) {
      out.packages[pkg.dir]!.related.push(path);
      const sib = siblingTest(path, tests);
      if (sib) addTest(sib, `sibling of ${path}`);
    } else if (!claimed) fullPkg(pkg.dir, `${path}: no rule or import graph sees it`);
  }

  if (unknownOutside.length) {
    out.notes.push(`no rule names ${unknownOutside.join(', ')}: running every file-reading test`);
    for (const r of INPUT_RULES)
      for (const e of r.tests)
        if (!e.endsWith('/')) addTest(e, `unknown path ${unknownOutside[0]}`);
  }
  if (paths.length && touchesFixtureInputs(paths).run)
    addTest(FIXTURE_SUITE, 'fixture-inputs.ts: an input changed');
  for (const t of ALWAYS_RUN) addTest(t, 'always runs');

  // A changed module can select tests in its own package and in every package that reaches it.
  const related = PACKAGES.flatMap((p) => out.packages[p.dir]!.related);
  for (const p of PACKAGES) {
    const reach = [p.dir, ...p.reaches];
    out.packages[p.dir]!.related = related.filter((r) => reach.some((d) => r.startsWith(`${d}/`)));
  }
  return out;
}

// What a package runs: `full`, `fast` (related and/or named tests) or `skip`.
export const modeOf = (plan: Plan, dir: string): 'full' | 'fast' | 'skip' => {
  const p = plan.packages[dir]!;
  if (plan.full.length || p.full.length) return 'full';
  return p.related.length || p.tests.length ? 'fast' : 'skip';
};
