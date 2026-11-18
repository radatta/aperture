// rules.ts against the real tree: every named path exists, PACKAGES matches the workspace, `reaches` matches the
// packages' imports, and every test or module that reads files, imports by a computed path or spawns is registered
// (so a new one can't slip past the fast gate unnoticed). Untracked files count: a lane's new test is caught before
// its first commit.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTest } from './plan.ts';
import { BLIND, CODE, checkRegistry, formatProblems, type Problem } from './registry.ts';
import {
  ALWAYS_RUN,
  INPUT_RULES,
  MODULE_READERS,
  PACKAGE_FULL,
  PACKAGES,
  REPO_FULL,
  SELF_CONTAINED,
} from './rules.ts';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tracked = [
  ...new Set(
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\0') // -z: a non-ASCII path unquoted, so it isn't dropped from the scan
      .filter((f) => f && existsSync(join(ROOT, f))), // a deleted-but-staged path is listed, not readable
  ),
];
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const literal = (p: string) => !p.includes('*') && !p.includes('<pkg>');
const exists = (p: string) => existsSync(join(ROOT, p));
// The gate's own pre-check (registry.ts) on the real tree: what `pnpm gate:fast` refuses up front, CI refuses too.
const problems = checkRegistry(tracked, read);
const only = (kind: Problem['kind']) => formatProblems(problems.filter((p) => p.kind === kind));

describe('gate rules', () => {
  it('every literal path a rule names exists', () => {
    const named = [
      ...REPO_FULL.flatMap((r) => [...r.match, ...(r.except ?? [])]),
      ...PACKAGE_FULL.flatMap((r) => [...r.match, ...(r.except ?? [])]),
      ...INPUT_RULES.flatMap((r) => [...r.inputs, ...r.tests]),
      ...ALWAYS_RUN,
      ...Object.keys(SELF_CONTAINED),
      ...Object.keys(MODULE_READERS),
    ].filter(literal);
    expect(named.filter((p) => !exists(p))).toEqual([]);
  });

  // The gate dir's whole-suite rule: only these leave it. A new name here narrows what a gate change runs, so it is a
  // reviewed edit to this list too.
  it('only the classed gate files leave the selection-code rule; no PACKAGE_FULL rule has an except', () => {
    const gate = REPO_FULL.find((r) => r.match.includes('scripts/src/gate/'))!;
    expect(gate.except).toEqual([
      'scripts/src/gate/rules.ts',
      'scripts/src/gate/ci.ts',
      'scripts/src/gate/miss.ts',
      'scripts/src/gate/related.ts',
      'scripts/src/gate/*.test.ts',
    ]);
    expect(REPO_FULL.filter((r) => r.except).length).toBe(1);
    expect(PACKAGE_FULL.filter((r) => r.except)).toEqual([]);
  });

  // No test imports a setupFile, so the graph never sees one or what it imports, yet both run around every test of
  // the package: each setupFile sits under <pkg>/src/test/, and each repo module it imports from outside that dir is
  // a PACKAGE_FULL path whose rule runs the package whole. One level deep: what those modules import is graph-visible
  // through their own tests only.
  it('every setupFile, and every module one imports, runs its package whole', () => {
    const sharedExports = JSON.parse(read('packages/shared/package.json')).exports as Record<
      string,
      string
    >;
    const resolve = (from: string, spec: string): string | null => {
      if (spec === '@aperture/shared' || spec.startsWith('@aperture/shared/')) {
        const target = sharedExports[`.${spec.slice('@aperture/shared'.length)}`];
        return target ? join('packages/shared', target) : null;
      }
      if (!spec.startsWith('.')) return null; // a dependency
      const base = join(dirname(from), spec);
      return (
        ['', '.ts', '.tsx', '/index.ts']
          .map((e) => base + e)
          .find((c) => CODE.test(c) && exists(c)) ?? null
      );
    };
    const runsWhole = (dep: string, pkg: string) =>
      PACKAGE_FULL.some(
        (r) => r.match.includes(dep) && (r.pkgs ? r.pkgs.includes(pkg) : dep.startsWith(`${pkg}/`)),
      );
    const gaps: string[] = [];
    const guardedPkgs: string[] = [];
    for (const { dir } of PACKAGES) {
      const config = ['vitest.config.ts', 'vitest.config.mts']
        .map((f) => `${dir}/${f}`)
        .find(exists);
      const lists = config ? [...read(config).matchAll(/setupFiles:\s*\[([^\]]*)\]/g)] : [];
      const files = lists.flatMap((l) =>
        [...l[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => join(dir, m[1]!)),
      );
      if (lists.length && !files.length) gaps.push(`${config}: setupFiles found but none read`);
      for (const file of files) {
        if (!file.startsWith(`${dir}/src/test/`)) gaps.push(`${file}: not under ${dir}/src/test/`);
        const text = read(file);
        for (const [, spec] of text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
          const dep = resolve(file, spec!);
          if (!dep && (spec!.startsWith('.') || spec!.startsWith('@aperture/')))
            gaps.push(`${file}: can't resolve ${spec}`);
          else if (dep && !dep.startsWith(`${dir}/src/test/`) && !runsWhole(dep, dir))
            gaps.push(`${file} imports ${dep}`);
        }
      }
      // The guard goes in first, before any other setup module loads (it could keep the unguarded console), and a
      // package that installs it also fails on what it records.
      const guarded = files.filter((f) => read(f).includes('installConsoleGuard('));
      if (guarded.length) guardedPkgs.push(dir);
      if (guarded.length && guarded[0] !== files[0])
        gaps.push(`${dir}: the guard's setupFile isn't first`);
      if (guarded.length && !files.some((f) => /afterEach\([^]*failOnConsoleNoise\(/.test(read(f))))
        gaps.push(`${dir}: installs the guard but no afterEach calls failOnConsoleNoise`);
    }
    expect(guardedPkgs.sort()).toEqual(['app', 'lambdas']); // the scan read the setupFiles at all
    expect(gaps).toEqual([]);
  });

  it('PACKAGES is every workspace package with a vitest suite', () => {
    const withVitest = tracked
      .filter((f) => /^(?:[^/]+|packages\/[^/]+)\/vitest\.config\.[cm]?[jt]s$/.test(f))
      .map((f) => f.slice(0, f.lastIndexOf('/')))
      .sort();
    expect(PACKAGES.map((p) => p.dir).sort()).toEqual(withVitest);
    for (const p of PACKAGES)
      expect(JSON.parse(read(`${p.dir}/package.json`)).name, p.dir).toBe(p.name);
  });

  it("each package's `reaches` covers every other package its code imports", () => {
    const byName = new Map(PACKAGES.map((p) => [p.name, p.dir]));
    for (const p of PACKAGES) {
      const found = new Set<string>();
      for (const f of tracked.filter(
        (t) => t.startsWith(`${p.dir}/`) && /\.(?:ts|tsx|mts|js|mjs)$/.test(t),
      )) {
        for (const [, spec] of read(f).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
          const scoped = /^(@aperture\/[^/]+)/.exec(spec!)?.[1];
          if (scoped && byName.has(scoped)) found.add(byName.get(scoped)!);
          if (spec!.startsWith('.')) {
            const abs = join(f, '..', spec!);
            const other = PACKAGES.find((q) => abs.startsWith(`${q.dir}/`));
            if (other) found.add(other.dir);
          }
        }
      }
      found.delete(p.dir);
      expect(
        [...found].filter((d) => !p.reaches.includes(d)),
        p.dir,
      ).toEqual([]);
    }
  });

  it('every graph-blind test file and module is registered', () => {
    expect(only('blind')).toBe('');
  });

  it('every test-named file runs in exactly one vitest project, through globs the check can read', () => {
    expect(only('glob')).toBe('');
    expect(only('include')).toBe('');
  });

  it('SELF_CONTAINED and MODULE_READERS entries are still graph-blind (a stale entry rots the list)', () => {
    const stale = [...Object.keys(SELF_CONTAINED), ...Object.keys(MODULE_READERS)].filter(
      (f) => !BLIND.test(read(f)),
    );
    expect(stale).toEqual([]);
  });

  it('the Lambda entry-file rule names every lambdas path cdk names, and the module that names it', () => {
    const rule = INPUT_RULES.find((r) => r.inputs.includes('lambdas/src/coachWorker.ts'))!;
    const named = tracked
      .filter((f) => f.startsWith('cdk/src/') && CODE.test(f) && !isTest(f))
      .flatMap((f) =>
        [...read(f).matchAll(/new URL\(\s*'((?:\.\.\/)+lambdas\/[^']+)'/g)].map(
          (m) => [f, join(f, '..', m[1]!)] as const,
        ),
      );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(([, p]) => !rule.inputs.includes(p))).toEqual([]);
    expect(named.filter(([f]) => !rule.tests.includes(f))).toEqual([]); // naming it runs its importers
  });

  it('every snapshot has its owning test beside its folder', () => {
    expect(only('snapshot')).toBe('');
  });

  it('every fixtures/testdata folder in a package is some rule’s input', () => {
    expect(only('fixtures')).toBe('');
  });
});
