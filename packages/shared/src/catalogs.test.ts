import { afterEach, describe, expect, it } from 'vitest';
import {
  CATALOG_IDS,
  CATALOGS,
  catalogDetail,
  catalogLoaded,
  catalogProblem,
  DEFAULT_CATALOG,
  listsOf,
  loadCatalog,
  onPlanList,
  unloadCatalog,
} from './catalogs';
import { buildCatalog } from './lcCatalog';
import type { LcSourceRow } from './lcCatalog';
import { NEETCODE_150 } from './neetcode150';

// Synthetic rows: one NeetCode problem, with made-up facts that differ from NeetCode's, plus two off-list ones.
const SOURCE: LcSourceRow[] = [
  {
    id: 1,
    slug: 'two-sum',
    title: 'Two Sum (dataset)',
    difficulty: 'Medium',
    premium: true,
    acRate: 50,
    tags: ['Array'],
    algorithms: true,
  },
  {
    id: 9001,
    slug: 'synthetic-window',
    title: 'Synthetic Window',
    difficulty: 'Medium',
    premium: false,
    acRate: 40.5,
    tags: ['Sliding Window'],
    algorithms: true,
  },
  {
    id: 9002,
    slug: 'synthetic-query',
    title: 'Synthetic Query',
    difficulty: 'Easy',
    premium: false,
    acRate: null,
    tags: ['Database'],
    algorithms: false,
  },
];
const load = () => loadCatalog(buildCatalog(SOURCE, new Map()), 'rev-1');

describe('catalogs', () => {
  afterEach(() => unloadCatalog());

  it('labels every list, its id matching its key, its slugs unique', () => {
    load();
    for (const id of CATALOG_IDS) {
      const c = CATALOGS[id];
      expect(c.id).toBe(id);
      expect(c.label).not.toBe('');
      expect(c.source).not.toBe('');
      expect(new Set(c.problems.map((p) => p.slug)).size).toBe(c.problems.length);
    }
  });

  it('gives a problem in several lists the static list’s facts, the full catalog agreeing', () => {
    load();
    for (const p of NEETCODE_150) expect(catalogProblem(p.slug)).toBe(p);
    const full = catalogDetail('two-sum')!;
    const nc = NEETCODE_150.find((p) => p.slug === 'two-sum')!;
    expect([full.title, full.pattern, full.difficulty, full.premium]).toEqual([
      nc.title,
      nc.pattern,
      nc.difficulty,
      nc.premium,
    ]);
    expect(listsOf('two-sum')).toEqual(['neetcode150', 'leetcode']);
  });

  it('defaults to NeetCode 150, every one of its problems a member and on the plan list', () => {
    expect(DEFAULT_CATALOG).toBe('neetcode150');
    expect(CATALOGS.neetcode150.problems).toBe(NEETCODE_150);
    for (const p of NEETCODE_150) {
      expect(listsOf(p.slug)).toContain('neetcode150');
      expect(onPlanList(p.slug)).toBe(true);
    }
  });

  it('knows nothing of a problem on no list', () => {
    expect(catalogProblem('not-a-real-problem')).toBeNull();
    expect(listsOf('not-a-real-problem')).toEqual([]);
    expect(onPlanList('not-a-real-problem')).toBe(false);
  });

  it('answers exactly as NeetCode 150 alone until the full catalog is loaded', () => {
    expect(catalogLoaded()).toBeNull();
    expect(CATALOGS.leetcode.problems).toEqual([]);
    expect(catalogProblem('synthetic-window')).toBeNull();
    expect(catalogDetail('two-sum')).toBeNull();
    expect(listsOf('two-sum')).toEqual(['neetcode150']);
  });

  it('once loaded, knows an off-list problem by its catalog facts, never as on the plan list', () => {
    load();
    expect(catalogLoaded()).toEqual({ rev: 'rev-1', count: 3 });
    expect(catalogProblem('synthetic-window')).toMatchObject({
      title: 'Synthetic Window',
      pattern: 'sliding-window',
      difficulty: 'Medium',
    });
    expect(listsOf('synthetic-window')).toEqual(['leetcode']);
    expect(onPlanList('synthetic-window')).toBe(false);
    expect(catalogProblem('synthetic-query')?.pattern).toBe('other');
  });

  it('forgets the loaded catalog on unload, and a reload replaces it', () => {
    load();
    loadCatalog(buildCatalog(SOURCE.slice(0, 2), new Map()), 'rev-2');
    expect(catalogLoaded()).toEqual({ rev: 'rev-2', count: 2 });
    expect(catalogProblem('synthetic-query')).toBeNull();
    unloadCatalog();
    expect(catalogProblem('synthetic-window')).toBeNull();
  });
});
