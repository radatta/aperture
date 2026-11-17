// The coach's problem lists (docs/areas/recruiting/coach.md → The catalog), each a public list labelled by its
// source. Today one: NeetCode 150. A later list (NeetCode 250, a company list) adds a member here; a problem in
// several lists carries the same facts in each (catalogs.test.ts). The plan picks from DEFAULT_CATALOG until a
// per-user list choice exists.

import { NEETCODE_150 } from './neetcode150';
import type { CatalogProblem } from './neetcode150';

export type CatalogId = 'neetcode150';
export interface Catalog {
  id: CatalogId;
  label: string;
  source: string;
  problems: readonly CatalogProblem[];
}
export const CATALOGS: Record<CatalogId, Catalog> = {
  neetcode150: {
    id: 'neetcode150',
    label: 'NeetCode 150',
    source: 'neetcode.io roadmap',
    problems: NEETCODE_150,
  },
};
export const DEFAULT_CATALOG: CatalogId = 'neetcode150';
export const CATALOG_IDS = Object.keys(CATALOGS) as CatalogId[];

// Every list's problems by slug (the first list's facts win; the test pins that they agree).
const BY_SLUG = new Map<string, CatalogProblem>();
const LISTS_BY_SLUG = new Map<string, CatalogId[]>();
for (const id of CATALOG_IDS)
  for (const p of CATALOGS[id].problems) {
    if (!BY_SLUG.has(p.slug)) BY_SLUG.set(p.slug, p);
    LISTS_BY_SLUG.set(p.slug, [...(LISTS_BY_SLUG.get(p.slug) ?? []), id]);
  }
export const catalogProblem = (slug: string): CatalogProblem | null => BY_SLUG.get(slug) ?? null;
export const listsOf = (slug: string): CatalogId[] => [...(LISTS_BY_SLUG.get(slug) ?? [])];
