// rules.ts against the real tree: every named path exists, PACKAGES matches the workspace, `reaches` matches the
// packages' imports, and every test that reads files, raw-imports or spawns is registered (so a new one can't slip
// past the fast gate unnoticed).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_SUITE } from '../fixture-inputs.ts';
import { isTest } from './plan.ts';
import {
  ALWAYS_RUN,
  INPUT_RULES,
  PACKAGE_FULL,
  PACKAGES,
  REPO_FULL,
  SELF_CONTAINED,
} from './rules.ts';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const literal = (p: string) => !p.includes('*') && !p.includes('<pkg>');
const exists = (p: string) => existsSync(join(ROOT, p));

// File reads, raw imports and spawns: what vitest's import graph can't follow.
const BLIND =
  /\b(?:readFileSync|readdirSync|existsSync|statSync|cpSync|execFileSync|execSync|spawnSync|spawn|execFile|createRequire)\(|import\.meta\.glob|\?raw['"]/;
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

  it('every graph-blind test file is registered', () => {
    const explicit = new Set([
      ...ALWAYS_RUN,
      ...INPUT_RULES.flatMap((r) => r.tests.filter((t) => !t.endsWith('/'))),
      ...Object.keys(SELF_CONTAINED),
      FIXTURE_SUITE,
    ]);
    const candidates = tracked.filter(
      (f) =>
        (isTest(f) || /^extension\/test\/[^/]+\.ts$/.test(f)) &&
        PACKAGES.some((p) => f.startsWith(`${p.dir}/`)),
    );
    const unregistered = candidates.filter(
      (f) => BLIND.test(read(f)) && !explicit.has(f) && !DIR_CLAIMS.some((d) => f.startsWith(d)),
    );
    expect(
      unregistered,
      'add each to an INPUT_RULES entry (what it reads), ALWAYS_RUN or SELF_CONTAINED',
    ).toEqual([]);
  });

  it('SELF_CONTAINED entries are still graph-blind (a stale entry hides nothing, but rots the list)', () => {
    const stale = Object.keys(SELF_CONTAINED).filter((f) => !BLIND.test(read(f)));
    expect(stale).toEqual([]);
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
