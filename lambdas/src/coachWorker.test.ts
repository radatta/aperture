import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleCatalogImport,
  handleCoachPick,
  handleWorkerEvent,
  parseCatalogImportEvent,
  parseCoachWorkerEvent,
} from './coachWorker';
import {
  buildCatalog,
  catalogCounts,
  catalogLoaded,
  packCatalog,
  trimSourceRows,
  unloadCatalog,
} from '@aperture/shared';
import { FIXTURE_SOURCE } from './catalog/fixture';
import { FakeCatalogSource } from './catalog/source';
import { CatalogStore } from './catalog/store';
import { liveWrites } from './ddb/writes';
import { InMemoryDoc } from './ddb/DocClient';
import { FakeAnthropic } from './anthropic/gateway';

const EVENT = { userId: 'u1', day: '2026-11-17', claimId: 'c1' };

afterEach(() => vi.restoreAllMocks());

describe('parseCoachWorkerEvent', () => {
  it('keeps exactly the three fields, dropping extras', () =>
    expect(parseCoachWorkerEvent({ ...EVENT, note: 'x' })).toEqual(EVENT));

  it.each([
    ['userId', { ...EVENT, userId: undefined }],
    ['userId', { ...EVENT, userId: '  ' }],
    ['userId', { ...EVENT, userId: 7 }],
    ['day', { ...EVENT, day: undefined }],
    ['day', { ...EVENT, day: '2026-11-31' }], // not a real date
    ['day', { ...EVENT, day: '2026-1-5' }], // unpadded
    ['day', { ...EVENT, day: '2026-11-17T00:00:00Z' }],
    ['claimId', { ...EVENT, claimId: '' }],
    ['claimId', { ...EVENT, claimId: null }],
  ])('refuses a bad %s', (field, raw) =>
    expect(() => parseCoachWorkerEvent(raw)).toThrow(`Invalid coach worker event: ${field}`),
  );

  it('refuses a missing event', () => {
    expect(() => parseCoachWorkerEvent(undefined)).toThrow('userId');
    expect(() => parseCoachWorkerEvent(null)).toThrow('userId');
  });
});

describe('handleCoachPick', () => {
  it('logs one line a run, with no user id or text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // No claim on the day: the run isn't this event's, and nothing is called.
    const fake = new FakeAnthropic();
    await expect(handleCoachPick(new InMemoryDoc(), fake, EVENT)).resolves.toBe('not-ours');
    expect(fake.pickCalls).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toEqual({ event: 'coach_worker', run: 'not-ours', day: EVENT.day, claimId: 'c1' });
    expect(JSON.stringify(line)).not.toContain('u1');
  });

  it('throws on a malformed event and logs nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      handleCoachPick(new InMemoryDoc(), new FakeAnthropic(), { day: EVENT.day }),
    ).rejects.toThrow('userId');
    expect(log).not.toHaveBeenCalled();
  });
});

describe('the catalog import on the worker', () => {
  afterEach(() => unloadCatalog());

  it('refuses a malformed event before any work', () => {
    expect(parseCatalogImportEvent({ kind: 'catalog-import', runId: 'r', limit: 3, x: 1 })).toEqual(
      {
        kind: 'catalog-import',
        runId: 'r',
        limit: 3,
      },
    );
    expect(() => parseCatalogImportEvent({ kind: 'catalog-import' })).toThrow('runId');
    expect(() => parseCatalogImportEvent({ kind: 'catalog-import', runId: 'r', limit: 0 })).toThrow(
      'limit',
    );
  });

  it('runs a claimed import over the table', async () => {
    const doc = new InMemoryDoc();
    await new CatalogStore(doc, liveWrites(doc)).claim('run-1', 1);
    const meta = await handleCatalogImport(
      doc,
      new FakeAnthropic(),
      new FakeCatalogSource({ ok: true, data: FIXTURE_SOURCE }),
      { kind: 'catalog-import', runId: 'run-1' },
      { now: () => 2 },
    );
    expect(meta).toMatchObject({ live: 'a', count: 15, job: null });
  });
});

describe('handleWorkerEvent', () => {
  afterEach(() => unloadCatalog());
  const src = () => new FakeCatalogSource({ ok: true, data: FIXTURE_SOURCE });

  it('routes a catalog-import event to the import and anything else to the pick', async () => {
    const doc = new InMemoryDoc();
    await new CatalogStore(doc, liveWrites(doc)).claim('run-1', 1);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const meta = await handleWorkerEvent(
      doc,
      new FakeAnthropic(),
      src(),
      {
        kind: 'catalog-import',
        runId: 'run-1',
      },
      { now: () => 2 },
    );
    expect(meta).toMatchObject({ live: 'a', count: 15 });
    await expect(handleWorkerEvent(doc, new FakeAnthropic(), src(), EVENT)).resolves.toBe(
      'not-ours',
    );
  });

  it('loads the live catalog before a pick, so the pick names problems by their catalog facts', async () => {
    const doc = new InMemoryDoc();
    const store = new CatalogStore(doc, liveWrites(doc));
    const rows = buildCatalog(trimSourceRows(FIXTURE_SOURCE).rows, new Map());
    await store.claim('run-1', 1);
    const meta = await store.finish('run-1', 2, {
      ok: true,
      packed: packCatalog(rows),
      classes: '',
      sha: 'a'.repeat(40),
      counts: catalogCounts(rows),
      costUsd: 0,
      modelError: null,
      badClasses: null,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCoachPick(doc, new FakeAnthropic(), EVENT);
    expect(catalogLoaded()).toEqual({ rev: meta.rev, count: rows.length });
  });
});
