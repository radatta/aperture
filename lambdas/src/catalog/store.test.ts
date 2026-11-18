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
import { CatalogStore, catalogState, catalogStatus, CLAIM_MS, StageOrderError } from './store';
import type { CatalogMeta } from './store';

const rows = buildCatalog(trimSourceRows(FIXTURE_SOURCE).rows, new Map());
const ok = (costUsd = 0) => ({
  ok: true as const,
  packed: packCatalog(rows),
  classes: '9001\theap\t-\t-',
  sha: 'f'.repeat(40),
  counts: catalogCounts(rows),
  costUsd,
  modelError: null,
  badClasses: null,
});
const setup = (chunkChars?: number) => {
  const doc = new InMemoryDoc();
  return { doc, store: new CatalogStore(doc, liveWrites(doc), chunkChars) };
};

describe('CatalogStore — the upload', () => {
  it('takes parts in order, joins them as sent (a split mid-line is fine), and a part 1 starts over', async () => {
    const { store } = setup();
    await store.stagePart(1, 2, '9001\th', 1);
    const half = await store.stage();
    expect(half).toMatchObject({ of: 2, have: 1 });
    expect(await store.stageText(half!)).toBeNull();
    const done = await store.stagePart(2, 2, 'eap\t-\t-', 2);
    expect(await store.stageText(done)).toBe('9001\theap\t-\t-');
    const again = await store.stagePart(1, 3, 'x', 3);
    expect(again).toMatchObject({ of: 3, have: 1 });
  });

  it('refuses a part out of order, of another size, already in, or with no upload under way — with why', async () => {
    const { store } = setup();
    await expect(store.stagePart(2, 2, 'b', 1)).rejects.toThrow(/send part 1 of 2 first/);
    await store.stagePart(1, 3, 'a', 2);
    await expect(store.stagePart(3, 3, 'c', 3)).rejects.toThrow(/Send part 2 next/);
    await expect(store.stagePart(2, 4, 'b', 3)).rejects.toThrow(/has 3 parts, not 4/);
    await store.stagePart(2, 3, 'b', 4);
    await expect(store.stagePart(2, 3, 'b', 5)).rejects.toBeInstanceOf(StageOrderError);
    expect(await store.stage()).toMatchObject({ of: 3, have: 2 });
  });

  it('a complete upload left from an earlier import never takes a stray part 2', async () => {
    const { store } = setup();
    await store.stagePart(1, 2, 'a', 1);
    await store.stagePart(2, 2, 'b', 2);
    await expect(store.stagePart(2, 2, 'c', 3)).rejects.toThrow(/already in/);
  });

  it('a concurrent part loses with a refusal, never a mixed file', async () => {
    const { store, doc } = setup();
    await store.stagePart(1, 2, 'a', 1);
    doc.interceptNextPutIf(CATALOG_PK, catalogSk.stage(), () =>
      doc.putNow({ PK: CATALOG_PK, SK: catalogSk.stage(), of: 2, have: 1, updatedAt: 99 }),
    );
    await expect(store.stagePart(2, 2, 'b', 2)).rejects.toThrow(/same time/);
  });

  it('clears an upload only if no new one began since it was read', async () => {
    const { store } = setup();
    const first = await store.stagePart(1, 1, 'a', 1);
    await store.stagePart(1, 2, 'new', 2); // a new upload begins
    expect(await store.clearStage(first, 3)).toBe(false);
    expect(await store.stage()).toMatchObject({ of: 2, have: 1 });
    const now = (await store.stage())!;
    expect(await store.clearStage(now, 4)).toBe(true);
    expect(await store.stage()).toMatchObject({ of: 0, have: 0 });
    expect((await store.stagePart(1, 1, 'after', 5)).have).toBe(1);
  });
});

describe('CatalogStore — the job', () => {
  it('claims once while a claim is young, again once it lapses (a queued plus running job’s lifetime)', async () => {
    const { store } = setup();
    expect(CLAIM_MS).toBeGreaterThanOrEqual(60_000 + 90_000);
    expect(await store.claim('run-1', 1000)).toMatchObject({ job: { runId: 'run-1' } });
    expect(await store.claim('run-2', 1000 + CLAIM_MS - 1)).toBeNull();
    expect(await store.claim('run-3', 1000 + CLAIM_MS)).toMatchObject({
      job: { runId: 'run-3' },
    });
  });

  it('a claim that loses the race reads as not claimed', async () => {
    const { store, doc } = setup();
    doc.interceptNextPutIf(CATALOG_PK, catalogSk.meta(), () =>
      doc.putNow({ PK: CATALOG_PK, SK: catalogSk.meta(), meta: {}, updatedAt: 5 }),
    );
    expect(await store.claim('run-1', 1000)).toBeNull();
  });

  it('publishes into the idle slot, flips meta, keeps the classes, and reads the live catalog back', async () => {
    const { store, doc } = setup(200); // small chunks: the catalog spans several items
    await store.claim('run-1', 1000);
    const m1 = await store.finish('run-1', 2000, ok());
    expect(m1).toMatchObject({ live: 'a', job: null, count: rows.length, sha: 'f'.repeat(40) });
    expect((await doc.query(CATALOG_PK, catalogSk.slotPrefix('a'))).length).toBeGreaterThan(1);
    expect(unpackCatalog(await store.loadLive(m1))).toEqual(rows);
    expect(await store.classesText()).toBe('9001\theap\t-\t-');

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

describe('catalogState / catalogStatus', () => {
  const base: CatalogMeta = {
    live: null,
    rev: null,
    sha: null,
    count: 0,
    premium: 0,
    by: null,
    importedAt: null,
    costUsd: 0,
    lastError: null,
    modelError: null,
    badClasses: 0,
    job: null,
    updatedAt: 1,
  };
  const by = (tags: number) => ({ neetcode: 1, rule: 0, model: 1, tags });
  const live = { ...base, live: 'a' as const, rev: 'r', by: by(0) };
  const upload = { of: 2, have: 1, updatedAt: 1 };

  it('reads each state', () => {
    expect(catalogState(null, null, 0)).toBe('absent');
    expect(catalogState({ ...base, job: { runId: 'r', claimedAt: 0 } }, null, 1)).toBe('running');
    expect(catalogState(base, upload, 0)).toBe('staging');
    expect(catalogState({ ...base, lastError: 'boom' }, null, 0)).toBe('failed');
    expect(catalogState(live, null, 0)).toBe('ready');
    expect(catalogState({ ...live, by: by(3) }, null, 0)).toBe('partial');
    expect(catalogState({ ...base, job: { runId: 'r', claimedAt: 0 } }, null, CLAIM_MS)).toBe(
      'absent',
    );
  });

  it('never lets an abandoned upload hide a live catalog: it shows only in `staged`', () => {
    expect(catalogStatus(live, upload, 0)).toMatchObject({
      state: 'ready',
      staged: { have: 1, of: 2 },
    });
    expect(catalogStatus(live, { of: 0, have: 0, updatedAt: 1 }, 0).staged).toBeNull();
  });
});
