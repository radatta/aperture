import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  catalogCounts,
  packCatalog,
  trimSourceRows,
  unpackCatalog,
} from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { CATALOG_PK, catalogSk } from '../ddb/keys';
import { liveWrites } from '../ddb/writes';
import { FIXTURE_SOURCE } from './fixture';
import { CatalogStore, catalogState, CLAIM_MS, stageComplete, stageText } from './store';

const rows = buildCatalog(trimSourceRows(FIXTURE_SOURCE).rows, new Map());
const ok = (costUsd = 0) => ({
  ok: true as const,
  packed: packCatalog(rows),
  sha: 'f'.repeat(40),
  counts: catalogCounts(rows),
  costUsd,
});
const setup = (chunkChars?: number) => {
  const doc = new InMemoryDoc();
  return { doc, store: new CatalogStore(doc, liveWrites(doc), chunkChars) };
};

describe('CatalogStore', () => {
  it('stages an upload’s parts in any order, a part 1 or a new size starting over', async () => {
    const { store } = setup();
    await store.stagePart(2, 2, 'b', 1);
    expect(stageComplete(await store.stage())).toBe(false);
    const done = await store.stagePart(1, 2, 'a', 2);
    expect(done.parts).toEqual({ '1': 'a' }); // a part 1 starts a new upload
    const full = await store.stagePart(2, 2, 'b', 3);
    expect(stageComplete(full)).toBe(true);
    expect(stageText(full)).toBe('a\nb');
    expect((await store.stagePart(2, 3, 'x', 4)).parts).toEqual({ '2': 'x' });
    await store.clearStage();
    expect(await store.stage()).toBeNull();
  });

  it('claims once while a claim is young, again once it lapses', async () => {
    const { store } = setup();
    expect(await store.claim('run-1', 1000)).toMatchObject({ job: { runId: 'run-1' } });
    expect(await store.claim('run-2', 1000 + CLAIM_MS - 1)).toBeNull();
    expect(await store.claim('run-3', 1000 + CLAIM_MS)).toMatchObject({ job: { runId: 'run-3' } });
  });

  it('publishes into the idle slot, flips meta, and reads the live catalog back', async () => {
    const { store, doc } = setup(200); // small chunks: the catalog spans several items
    await store.claim('run-1', 1000);
    const m1 = await store.finish('run-1', 2000, ok());
    expect(m1).toMatchObject({ live: 'a', job: null, count: rows.length, sha: 'f'.repeat(40) });
    expect((await doc.query(CATALOG_PK, catalogSk.slotPrefix('a'))).length).toBeGreaterThan(1);
    expect(unpackCatalog(await store.loadLive(m1))).toEqual(rows);

    await store.claim('run-2', 3000);
    const m2 = await store.finish('run-2', 4000, ok(0.01));
    expect(m2).toMatchObject({ live: 'b', costUsd: 0.01 });
    expect(unpackCatalog(await store.loadLive(m2))).toEqual(rows);
  });

  it('keeps the live catalog on a failed job and sets the error; a lapsed claim can’t finish', async () => {
    const { store } = setup();
    await store.claim('run-1', 1000);
    await store.finish('run-1', 2000, ok());
    await store.claim('run-2', 3000);
    const failed = await store.finish('run-2', 4000, {
      ok: false,
      error: 'upstream 503',
      costUsd: 0,
    });
    expect(failed).toMatchObject({ live: 'a', lastError: 'upstream 503', job: null });
    await store.claim('run-3', 5000);
    await store.claim('run-4', 5000 + CLAIM_MS);
    await expect(store.finish('run-3', 5000 + CLAIM_MS + 1, ok())).rejects.toThrow(
      /lost its claim/,
    );
  });

  it('reads a slot whose chunks don’t match its rev as missing', async () => {
    const { store, doc } = setup(200);
    await store.claim('run-1', 1000);
    const meta = await store.finish('run-1', 2000, ok());
    await doc.delete(CATALOG_PK, catalogSk.chunk('a', 0));
    expect(await store.loadLive(meta)).toBeNull();
  });
});

describe('catalogState', () => {
  const base = {
    live: null,
    rev: null,
    sha: null,
    count: 0,
    premium: 0,
    by: null,
    importedAt: null,
    costUsd: 0,
    lastError: null,
    job: null,
    updatedAt: 1,
  };
  const by = (tags: number) => ({ neetcode: 1, rule: 0, model: 1, tags });
  it('reads each state', () => {
    expect(catalogState(null, null, 0)).toBe('absent');
    expect(catalogState({ ...base, job: { runId: 'r', claimedAt: 0 } }, null, 1)).toBe('running');
    expect(catalogState(base, { of: 2, parts: { '1': 'x' }, updatedAt: 1 }, 0)).toBe('staging');
    expect(catalogState({ ...base, lastError: 'boom' }, null, 0)).toBe('failed');
    expect(catalogState({ ...base, live: 'a', rev: 'r', by: by(0) }, null, 0)).toBe('ready');
    expect(catalogState({ ...base, live: 'a', rev: 'r', by: by(3) }, null, 0)).toBe('partial');
    expect(catalogState({ ...base, job: { runId: 'r', claimedAt: 0 } }, null, CLAIM_MS)).toBe(
      'absent',
    );
  });
});
