import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleCatalogImport,
  handleCoachPick,
  parseCatalogImportEvent,
  parseCoachWorkerEvent,
} from './coachWorker';
import { FIXTURE_SOURCE } from './catalog/fixture';
import { recheckCatalogSoon } from './catalog/loader';
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
  afterEach(() => recheckCatalogSoon());

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
