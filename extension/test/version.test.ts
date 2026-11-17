// The version gate (README → Versions): a change to what ships in the extension bumps manifest.json's version,
// so the app's Settings can say when Safari's copy is behind. Checked against the branch's base: on a PR's
// merge commit in CI, HEAD^1 (main); anywhere else, the merge base with origin/main — which on a main push is
// HEAD itself, so main never fails it. Tests, the README and the package's config don't ship, so they need no bump.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SHIPPED = ['manifest.json', 'options.html', 'src/', 'icons/']; // what Safari's build copies and runs
const isShipped = (path: string) => {
  if (!path.startsWith('extension/')) return false;
  const rel = path.slice('extension/'.length);
  return SHIPPED.some((s) => (s.endsWith('/') ? rel.startsWith(s) : rel === s));
};
const parse = (v: unknown) => {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const greater = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
};
// Null when the change is fine; else what's wrong, in words.
function verdict(o: { changed: string[]; base: string | null; head: string }): string | null {
  const head = parse(o.head);
  if (!head) return `manifest.json's version "${o.head}" isn't x.y.z`;
  const shipped = o.changed.filter(isShipped);
  if (!shipped.length || o.base == null) return null; // nothing shipped changed, or a new extension
  const base = parse(o.base);
  if (base && greater(head, base)) return null;
  return (
    `extension/ changed what ships (${shipped.slice(0, 5).join(', ')}${shipped.length > 5 ? ', …' : ''}) ` +
    `but manifest.json's version ${o.head} isn't above the base's ${o.base} — bump it (extension/README.md → Versions)`
  );
}

describe('the version rule', () => {
  const src = ['extension/src/content.js'];
  it('a shipped change without a bump fails; with one it passes', () => {
    expect(verdict({ changed: src, base: '2.2.0', head: '2.2.0' })).toMatch(/bump it/);
    expect(verdict({ changed: src, base: '2.2.0', head: '2.2.1' })).toBeNull();
    expect(verdict({ changed: src, base: '2.2.0', head: '3.0.0' })).toBeNull();
    expect(verdict({ changed: src, base: '2.9.0', head: '2.10.0' })).toBeNull(); // numbers, not text
  });
  it('a lower or equal version fails, and a malformed one always fails', () => {
    expect(verdict({ changed: src, base: '2.2.0', head: '2.1.9' })).toMatch(/bump it/);
    expect(verdict({ changed: src, base: '2.10.0', head: '2.9.0' })).toMatch(/bump it/);
    expect(verdict({ changed: [], base: '2.2.0', head: '2.2' })).toMatch(/isn't x.y.z/);
    expect(verdict({ changed: src, base: '2.2.0', head: 'v2.3.0' })).toMatch(/isn't x.y.z/);
  });
  it('counts what ships — the manifest, Options, src and icons — and nothing else', () => {
    for (const f of [
      'extension/manifest.json',
      'extension/options.html',
      'extension/src/lib/coach.js',
      'extension/icons/dev/icon-48.png',
    ])
      expect(verdict({ changed: [f], base: '2.2.0', head: '2.2.0' }), f).not.toBeNull();
    for (const f of [
      'extension/test/overlay.test.ts',
      'extension/README.md',
      'extension/package.json',
      'extension/vitest.config.mts',
      'extension/srcx.js',
      'app/src/main.tsx',
    ])
      expect(verdict({ changed: [f], base: '2.2.0', head: '2.2.0' }), f).toBeNull();
  });
});

// This checkout, against its base.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const tryGit = (...args: string[]) => {
  try {
    return git(...args).trim();
  } catch {
    return null;
  }
};
function baseRef(): string | null {
  // A PR run checks out the merge commit: its first parent is main as the PR merges into it.
  if (process.env.GITHUB_ACTIONS && tryGit('rev-parse', '-q', '--verify', 'HEAD^2'))
    return tryGit('rev-parse', 'HEAD^1');
  return tryGit('merge-base', 'origin/main', 'HEAD');
}

describe('this checkout', () => {
  it('bumps manifest.json when what ships changed since its base', (ctx) => {
    const base = baseRef();
    if (!base) {
      // CI always has the history (ci.yml checks out with fetch-depth 0): there, no base is a failure.
      if (process.env.GITHUB_ACTIONS) throw new Error('version gate: no base to compare against');
      return ctx.skip('no origin/main to compare against');
    }
    // Committed, staged and unstaged changes since the base, plus files not yet added.
    const changed = [
      ...git('diff', '--name-only', '--no-renames', base, '--', 'extension').split('\n'),
      ...git('ls-files', '--others', '--exclude-standard', '--', 'extension').split('\n'),
    ].filter(Boolean);
    const atBase = tryGit('show', `${base}:extension/manifest.json`);
    const head = JSON.parse(readFileSync(join(repo, 'extension/manifest.json'), 'utf8')).version;
    const baseVersion = atBase ? (JSON.parse(atBase).version as string) : null;
    expect(verdict({ changed, base: baseVersion, head })).toBeNull();
  });
});
