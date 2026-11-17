import { describe, expect, it } from 'vitest';
import { CATALOG_IDS, CATALOGS, catalogProblem, DEFAULT_CATALOG, listsOf } from './catalogs';
import { NEETCODE_150 } from './neetcode150';

describe('catalogs', () => {
  it('labels every list, its id matching its key, its slugs unique', () => {
    for (const id of CATALOG_IDS) {
      const c = CATALOGS[id];
      expect(c.id).toBe(id);
      expect(c.label).not.toBe('');
      expect(c.source).not.toBe('');
      expect(new Set(c.problems.map((p) => p.slug)).size).toBe(c.problems.length);
    }
  });

  it('gives a problem in several lists the same facts in each', () => {
    for (const id of CATALOG_IDS)
      for (const p of CATALOGS[id].problems) expect(catalogProblem(p.slug)).toEqual(p);
  });

  it('defaults to NeetCode 150, every one of its problems a member', () => {
    expect(DEFAULT_CATALOG).toBe('neetcode150');
    expect(CATALOGS.neetcode150.problems).toBe(NEETCODE_150);
    for (const p of NEETCODE_150) expect(listsOf(p.slug)).toContain('neetcode150');
  });

  it('knows nothing of a problem on no list', () => {
    expect(catalogProblem('not-a-real-problem')).toBeNull();
    expect(listsOf('not-a-real-problem')).toEqual([]);
  });
});
