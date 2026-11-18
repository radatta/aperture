import { afterEach, describe, expect, it } from 'vitest';
import { catalogLoaded, unloadCatalog } from '@aperture/shared';
import { legacyRow } from '@aperture/shared/contract';
import { BackendClient } from './backend';
import { FakeAnthropic } from './anthropic/gateway';
import { FIXTURE_CLASSES, FIXTURE_SOURCE } from './catalog/fixture';
import { runCatalogImport } from './catalog/import';
import { inlineCatalogInvoker } from './catalog/invoker';
import type { CatalogImportEvent } from './catalog/invoker';
import { FakeCatalogSource } from './catalog/source';
import { CatalogStore } from './catalog/store';
import { InMemoryDoc } from './ddb/DocClient';
import { entityItem } from './ddb/mapping';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';
import { handleRpc } from './handler';

// The full catalog through the BFF: a stage-wide import, and every user's records reading its facts. Synthetic
// fixture rows only (catalog/fixture.ts).
const NOW = Date.UTC(2026, 10, 16, 18);

function setup(opts: { invoke?: boolean; fail?: boolean } = {}) {
  const doc = new InMemoryDoc();
  const store = new CatalogStore(doc, liveWrites(doc));
  const anthropic = new FakeAnthropic(); // model off: rows without a class keep their tags
  const kicks: CatalogImportEvent[] = [];
  let t = NOW;
  const catalogInvoker = inlineCatalogInvoker(async (e) => {
    kicks.push(e);
    if (opts.fail) throw new Error('invoke refused');
    if (opts.invoke === false) return; // queued, not run yet
    await runCatalogImport(
      {
        store,
        source: new FakeCatalogSource({ ok: true, data: FIXTURE_SOURCE }),
        anthropic,
        now: () => t,
        log: () => {},
      },
      e,
    );
  });
  const client = (userId: string) =>
    new BackendClient(new Repo(doc, liveWrites(doc), userId), {
      userId,
      now: () => t,
      catalog: store,
      catalogInvoker,
    });
  return { doc, store, kicks, client, tick: (ms: number) => (t += ms) };
}

describe('the full catalog through the BFF', () => {
  afterEach(() => {
    unloadCatalog();
  });

  it('stages a two-part upload, kicks the import on the last part, and reads ready', async () => {
    const { client, kicks } = setup();
    const api = client('u1');
    const cut = FIXTURE_CLASSES.length - 7; // mid-line: parts are raw slices, joined as sent
    const [a, b] = [FIXTURE_CLASSES.slice(0, cut), FIXTURE_CLASSES.slice(cut)];
    const half = await api.startCatalogImport({ classes: a, part: 1, parts: 2 });
    expect(half).toMatchObject({ state: 'staging', staged: { have: 1, of: 2 } });
    expect(kicks).toHaveLength(0);
    const done = await api.startCatalogImport({ classes: b, part: 2, parts: 2 });
    expect(kicks).toHaveLength(1);
    expect(done).toMatchObject({
      state: 'partial', // the fixture leaves seven problems to their tags, and the model is off
      count: 15,
      by: { neetcode: 2, rule: 1, model: 5, tags: 7 },
      staged: null,
      lastError: null,
    });
  });

  it('answers a second kick while one runs with the status, starting nothing', async () => {
    const { client, kicks } = setup({ invoke: false });
    const api = client('u1');
    expect((await api.startCatalogImport({})).state).toBe('running');
    expect((await api.startCatalogImport({})).state).toBe('running');
    expect(kicks).toHaveLength(1);
  });

  it('releases the claim with the error when the worker can’t be started', async () => {
    const { client } = setup({ fail: true });
    const api = client('u1');
    await expect(api.startCatalogImport({ limit: 3 })).rejects.toThrow('invoke refused');
    expect(await api.getCatalogStatus()).toMatchObject({
      state: 'failed',
      lastError: 'invoke refused',
    });
  });

  it('refuses an import on a stage with no worker, after checking the input', async () => {
    const doc = new InMemoryDoc();
    const api = new BackendClient(new Repo(doc, liveWrites(doc), 'u1'), {
      userId: 'u1',
      now: () => NOW,
    });
    await expect(api.startCatalogImport({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(api.startCatalogImport({})).rejects.toThrow(/off on this stage/);
    expect((await api.getCatalogStatus()).state).toBe('absent');
  });

  it('reads records exactly as before until an import, then every user sees the catalog’s facts', async () => {
    const { client } = setup();
    const u1 = client('u1');
    const u2 = client('u2');
    await u1.logCoachAttempts([{ slug: 'synthetic-heap-merge', outcome: 'solved' }]);
    const before = await u1.listProblemRecords();
    expect(before[0]).toMatchObject({ pattern: 'other', difficulty: null, lists: [] });
    expect(catalogLoaded()).toBeNull();

    await u1.startCatalogImport({ classes: FIXTURE_CLASSES });
    const after = await u1.listProblemRecords();
    expect(after[0]).toMatchObject({
      title: 'Synthetic Heap Merge',
      pattern: 'heap',
      difficulty: 'Hard',
      inCatalog: false,
      lists: ['leetcode'],
    });
    expect(await u2.listProblemRecords()).toEqual([]); // the catalog is shared; records stay each user's own
    const today = await u2.getCoachToday();
    expect(today.slots.every((s) => !s.slug.startsWith('synthetic-'))).toBe(true); // the plan stays NeetCode's
  });

  it('a legacy-only off-list problem reads the catalog’s facts, in its record and its legacy group', async () => {
    const { doc, client } = setup();
    const u1 = client('u1');
    const r = legacyRow(
      'synthetic-heap-merge',
      '2026-10-20',
      'accepted',
      Date.UTC(2026, 9, 20, 17),
      1,
    );
    await doc.put(
      entityItem('u1', `lc#${r.day}#${r.id}`, { ...r, userId: 'u1', problemTitle: 'Old Title' }),
    );
    await u1.startCatalogImport({ classes: FIXTURE_CLASSES });
    unloadCatalog(); // a fresh container: each read must load the catalog itself
    expect((await u1.listLegacyGroups('synthetic-heap-merge'))[0]).toMatchObject({
      title: 'Synthetic Heap Merge',
      difficulty: 'Hard',
    });
    expect((await u1.listProblemRecords())[0]).toMatchObject({
      slug: 'synthetic-heap-merge',
      title: 'Synthetic Heap Merge',
      pattern: 'heap',
      difficulty: 'Hard',
      inCatalog: false,
      lists: ['leetcode'],
    });
  });

  it('a smoke (testMode) import stages and claims nothing', async () => {
    const doc = new InMemoryDoc();
    await expect(
      handleRpc(
        doc,
        {
          userId: 'u1',
          method: 'startCatalogImport',
          args: [{ classes: FIXTURE_CLASSES }],
          testMode: true,
          now: () => NOW,
        },
        { catalogInvoker: inlineCatalogInvoker(async () => {}) },
      ),
    ).rejects.toThrow(/off on this stage/);
    expect(await new CatalogStore(doc, liveWrites(doc)).stage()).toBeNull();
  });
});
