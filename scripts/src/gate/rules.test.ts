// rules.ts against the real tree: every named path exists, PACKAGES matches the workspace, `reaches` matches the
// packages' imports, and every test or module that reads files, imports by a computed path or spawns is registered
// (so a new one can't slip past the fast gate unnoticed). Untracked files count: a lane's new test is caught before
// its first commit.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_SUITE } from '../fixture-inputs.ts';
import { isTest } from './plan.ts';
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

// File reads, raw imports, spawns, imports by a computed specifier and any `new URL(…, import.meta.url)` (a path
// built from this file's location): what vitest's import graph can't follow.
const BLIND =
  /\b(?:readFileSync|readdirSync|existsSync|statSync|cpSync|execFileSync|execSync|spawnSync|spawn|execFile|createRequire)\(|import\.meta\.glob|\?raw['"]|\bimport\((?!\s*(?:(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*[,)]|\)))|new URL\([^;]*?\bimport\.meta\.url/;
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// The gate's own files: any change to them is REPO_FULL, and they name the API in their rules and strings.
const GATE_DIR = 'scripts/src/gate/';
// Directories whose every test is graph-blind through a shared loader, named whole by a rule.
const DIR_CLAIMS = ['extension/test/'];

describe('gate rules', () => {
  it('every literal path a rule names exists', () => {
    const named = [
      ...REPO_FULL.flatMap((r) => r.match),
      ...PACKAGE_FULL.flatMap((r) => r.match),
      ...INPUT_RULES.flatMap((r) => [...r.inputs, ...r.tests]),
      ...ALWAYS_RUN,
      ...Object.keys(SELF_CONTAINED),
      ...Object.keys(MODULE_READERS),
    ].filter(literal);
    expect(named.filter((p) => !exists(p))).toEqual([]);
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
    const explicit = new Set([
      ...ALWAYS_RUN,
      ...INPUT_RULES.flatMap((r) => r.tests.filter((t) => !t.endsWith('/'))),
      ...Object.keys(SELF_CONTAINED),
      ...Object.keys(MODULE_READERS),
      FIXTURE_SUITE,
    ]);
    const candidates = tracked.filter(
      (f) =>
        CODE.test(f) &&
        !f.startsWith(GATE_DIR) &&
        !f.includes('/node_modules/') &&
        PACKAGES.some((p) => f.startsWith(`${p.dir}/`)),
    );
    const unregistered = candidates.filter(
      (f) => BLIND.test(read(f)) && !explicit.has(f) && !DIR_CLAIMS.some((d) => f.startsWith(d)),
    );
    expect(
      unregistered,
      'a test: add it to an INPUT_RULES entry (what it reads), ALWAYS_RUN or SELF_CONTAINED; a module: to MODULE_READERS, with a rule for any tracked input',
    ).toEqual([]);
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
    const snaps = tracked.filter((f) => /\/__snapshots__\/[^/]+\.snap$/.test(f));
    const orphans = snaps.filter(
      (s) => !tracked.includes(s.replace(/__snapshots__\/([^/]+)\.snap$/, '$1')),
    );
    expect(orphans).toEqual([]);
  });

  it('every fixtures/testdata folder in a package is some rule’s input', () => {
    const dirs = [
      ...new Set(
        tracked
          .map((f) => /^(.*\/(?:fixtures|testdata|__fixtures__)\/)/.exec(f)?.[1])
          .filter((d): d is string => !!d && PACKAGES.some((p) => d.startsWith(`${p.dir}/`))),
      ),
    ];
    const inputs = INPUT_RULES.flatMap((r) => r.inputs);
    const unclaimed = dirs.filter((d) => !inputs.some((i) => i.endsWith('/') && d.startsWith(i)));
    expect(unclaimed).toEqual([]);
  });
});
