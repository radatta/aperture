// @aperture/scripts — deploy change classifier. Given the list of changed paths, decide how much of
// the pipeline must run: none (docs), app (frontend only), or full (infra/lambda/anything else).
//
// This replaces a docs-only grep that lived inline in deploy.yml and was silently broken for weeks:
// `grep -qvE '^(docs/|[^/]*\.md)$'` — the `$` closed the whole alternation, so the `docs/` branch
// matched only a path literally equal to `docs/`, and nothing UNDER docs/ ever took the fast path.
// The rule only ever executed in a real deploy, so nothing caught it. Living here, `pnpm test`
// exercises it on every PR.
//
// Run: `node scripts/src/classify-changes.ts` (what CI does — the runner's Node 22 strips types natively,
// no install) or `tsx src/classify-changes.ts`. Reads newline-separated paths on stdin, prints the tier.
// Because CI runs it without tsx: erasable syntax only (enforced by `erasableSyntaxOnly` in
// scripts/tsconfig.json) and node: builtins only — no workspace or npm imports.
import { readFileSync } from 'node:fs';

export type Tier = 'none' | 'app' | 'full';

// Default-to-full is deliberate: a path we didn't anticipate returns 'full', because a wrong 'none'
// silently leaves a deployed stack stale while a wrong 'full' just costs a few CI minutes.
export function classifyPath(path: string): Tier {
  if (path.startsWith('docs/')) return 'none';
  if (/^[^/]*\.md$/.test(path)) return 'none'; // top-level *.md (README.md, CLAUDE.md, …)
  if (path.startsWith('app/')) return 'app'; // frontend artifact only — no CDK, no Lambda
  return 'full'; // lambdas/, cdk/, packages/shared, scripts/, root config, .github/, extension/, …
}

const RANK: Record<Tier, number> = { none: 0, app: 1, full: 2 };

// The changeset's tier is the max over its files: docs + app = app; anything full = full.
export function classify(files: string[]): Tier {
  const paths = files.map((f) => f.trim()).filter(Boolean);
  if (paths.length === 0) return 'full'; // empty/unknown changeset → full (can't prove it's safe to skip)
  return paths.reduce<Tier>((max, p) => {
    const t = classifyPath(p);
    return RANK[t] > RANK[max] ? t : max;
  }, 'none');
}

if (process.argv[1]?.endsWith('classify-changes.ts')) {
  process.stdout.write(classify(readFileSync(0, 'utf8').split('\n')));
}
