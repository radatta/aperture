import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCatalog,
  catalogCounts,
  catalogLoaded,
  catalogProblem,
  packCatalog,
  trimSourceRows,
  unloadCatalog,
} from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { CATALOG_PK, catalogSk } from '../ddb/keys';
import { liveWrites } from '../ddb/writes';
import { FIXTURE_SOURCE } from './fixture';
import { ensureCatalog } from './loader';
import { CatalogStore } from './store';

const rows = buildCatalog(trimSourceRows(FIXTURE_SOURCE).rows, new Map());
const publish = async (store: CatalogStore, runId: string, at: number) => {
  await store.claim(runId, at);
  return store.finish(runId, at, {
    ok: true,
    packed: packCatalog(rows),
    classes: '',
    sha: 'a'.repeat(40),
    counts: catalogCounts(rows),
    costUsd: 0,
    modelError: null,
    badClasses: null,
  });
};
const setup = () => {
  const doc = new InMemoryDoc();
  return { doc, store: new CatalogStore(doc, liveWrites(doc)) };
};

describe('ensureCatalog', () => {
  afterEach(() => {
    unloadCatalog();
    vi.restoreAllMocks();
  });

  it('leaves NeetCode alone while nothing is imported', async () => {
    await ensureCatalog(setup().store);
    expect(catalogLoaded()).toBeNull();
  });

  it('reads meta strongly on every call, the chunks only on a new rev — so a new import shows at once', async () => {
    const { store, doc } = setup();
    await ensureCatalog(store); // nothing yet: a container that read "absent" a moment ago
    const m1 = await publish(store, 'run-1', 1000);
    await ensureCatalog(store); // the very next read sees it, whatever container ran the import
    expect(catalogLoaded()).toEqual({ rev: m1.rev, count: rows.length });
    expect(catalogProblem('synthetic-heap-merge')?.pattern).toBe('heap');
    expect(doc.gets.filter((g) => g.key.includes('meta')).every((g) => g.consistent)).toBe(true);

    const queries = doc.queries.length;
    await ensureCatalog(store); // same rev: meta read, no chunk query
    expect(doc.queries.length).toBe(queries);
    const m2 = await publish(store, 'run-2', 2000);
    await ensureCatalog(store);
    expect(catalogLoaded()?.rev).toBe(m2.rev);
    expect(doc.queries.length).toBe(queries + 1);
  });

  it('keeps what it had and logs when the new rev won’t load, never throwing', async () => {
    const { store, doc } = setup();
    const m1 = await publish(store, 'run-1', 1000);
    await ensureCatalog(store);
    await publish(store, 'run-2', 2000);
    await doc.delete(CATALOG_PK, catalogSk.chunk('b', 0));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await ensureCatalog(store);
    expect(catalogLoaded()?.rev).toBe(m1.rev);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('catalog load failed'));
  });
});
