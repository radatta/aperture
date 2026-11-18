// The coach's problem lists (docs/areas/recruiting/coach.md → The catalog), each a public list labelled by its
// source. NeetCode 150 is static, kept by hand. `leetcode` — the full LeetCode problem set, metadata only — is
// never tracked: it lives in the stage's own store (catalog#leetcode) and a Lambda loads it at run time
// (loadCatalog). Until it's loaded every answer here is NeetCode 150's alone, exactly as before it existed. A
// problem on several lists answers with the static list's facts (catalogs.test.ts). The plan picks from
// DEFAULT_CATALOG until a per-user list choice exists.

import { NEETCODE_150 } from './neetcode150';
import type { CatalogProblem } from './neetcode150';
import type { LcCatalogRow } from './lcCatalog';

export type CatalogId = 'neetcode150' | 'leetcode';
export interface Catalog {
  id: CatalogId;
  label: string;
  source: string;
  problems: readonly CatalogProblem[];
}

// The loaded full catalog: its rows, by slug, and the store revision they came from.
let loaded: {
  rows: readonly LcCatalogRow[];
  bySlug: Map<string, LcCatalogRow>;
  rev: string;
} | null = null;

export const CATALOGS: Record<CatalogId, Catalog> = {
  neetcode150: {
    id: 'neetcode150',
    label: 'NeetCode 150',
    source: 'neetcode.io roadmap',
    problems: NEETCODE_150,
  },
  leetcode: {
    id: 'leetcode',
    label: 'All LeetCode', // beside the page's “LeetCode ↗” link, a bare “LeetCode” read as a repeat
    source: 'github.com/noworneverev/leetcode-api (LeetCode metadata, MIT)',
    get problems() {
      return loaded?.rows ?? [];
    },
  },
};
export const DEFAULT_CATALOG: CatalogId = 'neetcode150';
export const CATALOG_IDS = Object.keys(CATALOGS) as CatalogId[];
const STATIC_IDS: CatalogId[] = ['neetcode150'];

// The static lists' problems by slug (the first list's facts win; the test pins that they agree).
const BY_SLUG = new Map<string, CatalogProblem>();
const LISTS_BY_SLUG = new Map<string, CatalogId[]>();
for (const id of STATIC_IDS)
  for (const p of CATALOGS[id].problems) {
    if (!BY_SLUG.has(p.slug)) BY_SLUG.set(p.slug, p);
    LISTS_BY_SLUG.set(p.slug, [...(LISTS_BY_SLUG.get(p.slug) ?? []), id]);
  }
const PLAN_SLUGS = new Set(CATALOGS[DEFAULT_CATALOG].problems.map((p) => p.slug));

export const catalogProblem = (slug: string): CatalogProblem | null =>
  BY_SLUG.get(slug) ?? loaded?.bySlug.get(slug) ?? null;
export const listsOf = (slug: string): CatalogId[] => [
  ...(LISTS_BY_SLUG.get(slug) ?? []),
  ...(loaded?.bySlug.has(slug) ? (['leetcode'] as const) : []),
];
// On the list the plan picks from — what swap targets and "on the roadmap" mean, whatever else is loaded.
export const onPlanList = (slug: string): boolean => PLAN_SLUGS.has(slug);
// The full catalog's own row: frontend id, tags, acceptance, related problems.
export const catalogDetail = (slug: string): LcCatalogRow | null =>
  loaded?.bySlug.get(slug) ?? null;

// The Lambda's hook: rows from the store (lcCatalog.unpackCatalog), replacing any loaded before.
export function loadCatalog(rows: readonly LcCatalogRow[], rev: string): void {
  loaded = { rows, bySlug: new Map(rows.map((r) => [r.slug, r])), rev };
}
export function unloadCatalog(): void {
  loaded = null;
}
export const catalogLoaded = (): { rev: string; count: number } | null =>
  loaded ? { rev: loaded.rev, count: loaded.rows.length } : null;
