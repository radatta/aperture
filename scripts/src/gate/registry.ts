// @aperture/scripts — the gate's registry check, pure: given every tracked and untracked file, which test files the
// gate can't pick up. `pnpm gate:fast` runs it first (~1–2 s), so a lane's unregistered test fails before tsc, eslint
// and the tests, not after them; rules.test.ts runs it on the real tree, so CI still catches what a gate skipped.
// Each problem names the file, why, and the rules.ts list or config to edit (docs/ops/GATE.md → The rules).
// Plain `node` (cli.ts imports it): erasable syntax, node: builtins only.
import { FIXTURE_SUITE } from '../fixture-inputs.ts';
import { isTest, matches, pkgOf } from './plan.ts';
import {
  ALWAYS_RUN,
  INPUT_RULES,
  MODULE_READERS,
  PACKAGES,
  SELF_CONTAINED,
  type Project,
} from './rules.ts';

export interface Problem {
  kind: 'include' | 'blind' | 'snapshot' | 'fixtures' | 'glob';
  file: string; // repo-relative
  why: string;
  fix: string;
}

// File reads, raw imports, spawns, imports by a computed specifier and any `new URL(…, import.meta.url)` (a path
// built from this file's location): what vitest's import graph can't follow.
export const BLIND =
  /\b(?:readFileSync|readdirSync|existsSync|statSync|cpSync|execFileSync|execSync|spawnSync|spawn|execFile|createRequire)\(|import\.meta\.glob|\?raw['"]|\bimport\((?!\s*(?:(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*[,)]|\)))|new URL\([^;]*?\bimport\.meta\.url/;
export const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// Anything vitest's default include would call a test, wider than plan.ts's isTest: a `.spec.ts` or `.test.mjs` no
// include here matches is a test that silently never runs.
export const TEST_NAMED = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// The gate's own files: they name the API in their rules and strings, and any change to them runs every gate test (the
// gate same-area rule; the selection code is REPO_FULL).
export const GATE_DIR = 'scripts/src/gate/';
// Directories whose every test is graph-blind through a shared loader, named whole by a rule.
export const DIR_CLAIMS = ['extension/test/'];

// What `matches` can't do: braces (`{ts,tsx}`, no nesting) expand here. Any other syntax is refused, so a glob the
// check would read differently from vitest fails loudly: extglobs, a `**` not followed by `/` (`matches` takes it as
// one segment, tinyglobby as any depth), and a one-option brace (literal to picomatch, expanded here).
const UNSUPPORTED = /[?[\]()!+@]|\{[^}]*\{|\*\*(?!\/)|\{[^,}]*\}/;
export const braces = (g: string): string[] => {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m) return [g];
  return m[1]!
    .split(',')
    .flatMap((alt) => braces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
};
export const globMatch = (glob: string, path: string) => braces(glob).some((g) => matches(g, path));

// The projects of `dir` whose include takes `rel` (package-relative) and whose exclude doesn't.
export const projectsFor = (projects: Project[], rel: string) =>
  projects.filter(
    (p) => p.include.some((g) => globMatch(g, rel)) && !p.exclude?.some((g) => globMatch(g, rel)),
  );

const label = (p: Project) => p.name ?? '-';
const REGISTER =
  'add it to an INPUT_RULES entry (what it reads), ALWAYS_RUN or SELF_CONTAINED (temp dirs or same-area only, with why) in scripts/src/gate/rules.ts';
const REGISTER_MODULE =
  'add it to MODULE_READERS in scripts/src/gate/rules.ts with what it reads, plus a rule for any tracked input';

// `files`: repo-relative, every one present on disk. `read`: a file's text by repo-relative path.
export function checkRegistry(files: string[], read: (path: string) => string): Problem[] {
  const out: Problem[] = [];
  const has = new Set(files);

  for (const pkg of PACKAGES)
    for (const p of pkg.projects)
      for (const g of [...p.include, ...(p.exclude ?? [])])
        if (UNSUPPORTED.test(g))
          out.push({
            kind: 'glob',
            file: 'scripts/src/gate/rules.ts',
            why: `${pkg.dir}${p.name ? ` (project ${p.name})` : ''}: the glob ${g} uses syntax the registry check can't match`,
            fix: 'use `*`, `**/` and one level of `{a,b,…}` only, in the vitest config and PACKAGES[].projects alike',
          });

  // Every test-named file runs in exactly one vitest project: none, and the gate names a test vitest drops (a fast
  // run with other named tests still passes); two, and it runs twice.
  for (const f of files.filter((x) => TEST_NAMED.test(x) && !x.includes('/node_modules/'))) {
    const pkg = pkgOf(f);
    if (!pkg) {
      out.push({
        kind: 'include',
        file: f,
        why: 'outside every vitest package, so no test run ever reaches it',
        fix: `move it under a package's include (${PACKAGES.map((p) => p.dir).join(', ')})`,
      });
      continue;
    }
    const hits = projectsFor(pkg.projects, f.slice(pkg.dir.length + 1));
    const globs = pkg.projects.map((p) => p.include.join(' ')).join(' | ');
    if (!hits.length)
      out.push({
        kind: 'include',
        file: f,
        why: `no vitest project in ${pkg.dir} includes it (include: ${globs}), so it never runs`,
        fix: `move or rename it to match, or widen the include in ${pkg.dir}/vitest.config.* and PACKAGES[].projects in scripts/src/gate/rules.ts`,
      });
    if (hits.length && !isTest(f))
      out.push({
        kind: 'include',
        file: f,
        why: 'vitest runs it, but plan.ts’s isTest doesn’t call it a test, so the gate never names it when it changes',
        fix: 'rename it to .test.ts/.tsx, or widen isTest in scripts/src/gate/plan.ts with the include',
      });
    if (hits.length > 1)
      out.push({
        kind: 'include',
        file: f,
        why: `included by ${hits.length} vitest projects in ${pkg.dir} (${hits.map(label).join(', ')}), so it runs once in each`,
        fix: `exclude it from all but one, in ${pkg.dir}/vitest.config.* and PACKAGES[].projects in scripts/src/gate/rules.ts`,
      });
  }

  // A test or module that reads files, imports by a computed path or spawns: the import graph can't see its inputs,
  // so a rule must name it, or a change to what it reads runs nothing.
  const explicit = new Set([
    ...ALWAYS_RUN,
    ...INPUT_RULES.flatMap((r) => r.tests.filter((t) => !t.endsWith('/'))),
    ...Object.keys(SELF_CONTAINED),
    ...Object.keys(MODULE_READERS),
    FIXTURE_SUITE,
  ]);
  for (const f of files)
    if (
      CODE.test(f) &&
      !f.startsWith(GATE_DIR) &&
      !f.includes('/node_modules/') &&
      pkgOf(f) &&
      !explicit.has(f) &&
      !DIR_CLAIMS.some((d) => f.startsWith(d)) &&
      BLIND.test(read(f))
    ) {
      const test = TEST_NAMED.test(f);
      out.push({
        kind: 'blind',
        file: f,
        why: `${test ? 'a test' : 'a module'} that reads files, imports by a computed path or spawns, and no rule names it`,
        fix: test ? REGISTER : REGISTER_MODULE,
      });
    }

  for (const s of files.filter((f) => /\/__snapshots__\/[^/]+\.snap$/.test(f))) {
    const owner = s.replace(/__snapshots__\/([^/]+)\.snap$/, '$1');
    if (!has.has(owner))
      out.push({
        kind: 'snapshot',
        file: s,
        why: `no ${owner} beside its folder owns it`,
        fix: 'delete the orphan snapshot, or move it beside its test',
      });
  }

  const inputs = INPUT_RULES.flatMap((r) => r.inputs).filter((i) => i.endsWith('/'));
  const dirs = new Set(
    files
      .map((f) => /^(.*\/(?:fixtures|testdata|__fixtures__)\/)/.exec(f)?.[1])
      .filter((d): d is string => !!d && !!pkgOf(d)),
  );
  for (const d of dirs)
    if (!inputs.some((i) => d.startsWith(i)))
      out.push({
        kind: 'fixtures',
        file: d,
        why: 'a fixtures folder no rule names as an input, so changing a fixture runs nothing',
        fix: 'add an INPUT_RULES entry in scripts/src/gate/rules.ts with the folder as an input and its readers as tests',
      });
  return out;
}

// For the gate's output: one problem a block.
export const formatProblems = (ps: Problem[]) =>
  ps.map((p) => `  ${p.file}: ${p.why}\n    fix: ${p.fix}`).join('\n');
