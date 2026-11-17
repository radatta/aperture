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
import { ensureCatalog, RECHECK_MS, recheckCatalogSoon } from './loader';
import { CatalogStore } from './store';

const rows = buildCatalog(trimSourceRows(FIXTURE_SOURCE).rows, new Map());
const publish = async (store: CatalogStore, runId: string, at: number) => {
  await store.claim(runId, at);
  return store.finish(runId, at, {
    ok: true,
    packed: packCatalog(rows),
    sha: 'a'.repeat(40),
    counts: catalogCounts(rows),
    costUsd: 0,
  });
};
const setup = () => {
  const doc = new InMemoryDoc();
  return { doc, store: new CatalogStore(doc, liveWrites(doc)) };
};

describe('ensureCatalog', () => {
  afterEach(() => {
    unloadCatalog();
    recheckCatalogSoon();
    vi.restoreAllMocks();
  });

  it('leaves NeetCode alone while nothing is imported', async () => {
    await ensureCatalog(setup().store, 0);
    expect(catalogLoaded()).toBeNull();
  });

  it('loads the live catalog, re-reading meta only after RECHECK_MS, the chunks only on a new rev', async () => {
    const { store, doc } = setup();
    const m1 = await publish(store, 'run-1', 1000);
    await ensureCatalog(store, 1000);
    expect(catalogLoaded()).toEqual({ rev: m1.rev, count: rows.length });
    expect(catalogProblem('synthetic-heap-merge')?.pattern).toBe('heap');

    const m2 = await publish(store, 'run-2', 2000);
    const queries = doc.queries.length;
    await ensureCatalog(store, 2000); // within RECHECK_MS of the last check: no read at all
    expect(catalogLoaded()?.rev).toBe(m1.rev);
    await ensureCatalog(store, 1000 + RECHECK_MS);
    expect(catalogLoaded()?.rev).toBe(m2.rev);
    expect(doc.queries.length).toBe(queries + 1);
    await ensureCatalog(store, 1000 + 2 * RECHECK_MS); // same rev: meta read, no chunk query
    expect(doc.queries.length).toBe(queries + 1);
  });

  it('keeps what it had and logs when the new rev won’t load, never throwing', async () => {
    const { store, doc } = setup();
    const m1 = await publish(store, 'run-1', 1000);
    await ensureCatalog(store, 1000);
    await publish(store, 'run-2', 2000);
    await doc.delete(CATALOG_PK, catalogSk.chunk('b', 0));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    recheckCatalogSoon();
    await ensureCatalog(store, 2000);
    expect(catalogLoaded()?.rev).toBe(m1.rev);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('catalog load failed'));
  });
});
