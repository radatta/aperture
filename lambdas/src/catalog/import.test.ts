import { afterEach, describe, expect, it } from 'vitest';
import { LC_CATALOG_COST_STOP_USD, LC_CATALOG_SOURCE, unpackCatalog } from '@aperture/shared';
import type { LcCatalogRow } from '@aperture/shared';
import { FakeAnthropic } from '../anthropic/gateway';
import type { CatalogClassifyRequest } from '../anthropic/gateway';
import { InMemoryDoc } from '../ddb/DocClient';
import { liveWrites } from '../ddb/writes';
import { FIXTURE_CLASSES, FIXTURE_SOURCE } from './fixture';
import { runCatalogImport } from './import';
import { recheckCatalogSoon } from './loader';
import { FakeCatalogSource } from './source';
import { CatalogStore } from './store';

// The fixture's rows the classes leave to their tags: 9004, 9005, 9007, 9009, 9011, 9012.
const TAGS_ONLY = [9004, 9005, 9007, 9009, 9011, 9012];
const answer = (req: CatalogClassifyRequest) => ({
  ok: true as const,
  fields: {
    items: req.rows.map((r) => ({ id: r.id, pattern: 'greedy', similar: [9008], harder: [] })),
  },
  model: 'fake',
  usage: { input: 1000, output: 500 },
  ms: 1,
});

function setup() {
  const doc = new InMemoryDoc();
  const store = new CatalogStore(doc, liveWrites(doc));
  const source = new FakeCatalogSource({ ok: true, data: FIXTURE_SOURCE });
  const anthropic = new FakeAnthropic();
  let t = 1_000;
  const deps = { store, source, anthropic, now: () => t, log: () => {} };
  const run = async (runId: string, limit?: number) => {
    t += 200_000; // past any earlier claim
    await store.claim(runId, t);
    return runCatalogImport(deps, { runId, limit });
  };
  const rows = async () =>
    unpackCatalog(await store.loadLive((await store.meta(true))!)) as LcCatalogRow[];
  return { store, source, anthropic, run, rows };
}

describe('runCatalogImport', () => {
  afterEach(() => recheckCatalogSoon());

  it('builds from the pinned source, the uploaded classes and a few model rows, then clears the upload', async () => {
    const { store, source, anthropic, run, rows } = setup();
    anthropic.nextClassify = answer;
    await store.stagePart(1, 1, FIXTURE_CLASSES, 1);
    const meta = await run('run-1');
    expect(source.urls).toEqual([
      `https://raw.githubusercontent.com/${LC_CATALOG_SOURCE.repo}/${LC_CATALOG_SOURCE.sha}/${LC_CATALOG_SOURCE.path}`,
    ]);
    expect(anthropic.classifyCalls[0]!.rows.map((r) => r.id)).toEqual(TAGS_ONLY);
    expect(meta).toMatchObject({
      live: 'a',
      sha: LC_CATALOG_SOURCE.sha,
      count: 14,
      premium: 1,
      by: { neetcode: 2, rule: 1, model: 11, tags: 0 },
      lastError: null,
      job: null,
    });
    expect(meta.costUsd).toBeCloseTo(1000 * 2e-6 + 500 * 10e-6);
    expect(await store.stage()).toBeNull();
    const by = Object.fromEntries((await rows()).map((r) => [r.slug, r]));
    expect(by['two-sum']).toMatchObject({ pattern: 'arrays-hashing', by: 'neetcode' });
    expect(by['synthetic-window-sum']).toMatchObject({
      pattern: 'sliding-window',
      similar: ['synthetic-greedy-jumps'],
      harder: ['synthetic-heap-merge'],
      by: 'model',
    });
    expect(by['synthetic-orders-report']).toMatchObject({ pattern: 'other', by: 'rule' });
  });

  it('a re-run with nothing left to classify makes no model call and keeps every class', async () => {
    const { store, anthropic, run, rows } = setup();
    anthropic.nextClassify = answer;
    await store.stagePart(1, 1, FIXTURE_CLASSES, 1);
    const first = await run('run-1');
    const before = await rows();
    const again = await run('run-2');
    expect(anthropic.classifyCalls).toHaveLength(1);
    expect(again).toMatchObject({ live: 'b', by: first.by, costUsd: first.costUsd });
    expect(await rows()).toEqual(before);
  });

  it('keeps the live catalog and records why when the source fails', async () => {
    const { source, run } = setup();
    const ok = await run('run-1');
    source.next = { ok: false, error: 'source HTTP 503' };
    const failed = await run('run-2');
    expect(failed).toMatchObject({ live: ok.live, rev: ok.rev, lastError: 'source HTTP 503' });
    source.next = { ok: true, data: { not: 'rows' } };
    expect(await run('run-3')).toMatchObject({ lastError: 'The source had no usable rows' });
  });

  it('leaves rows to their tags past the cost stop, and on a failed model call still counts its spend', async () => {
    const { store, anthropic, run } = setup();
    anthropic.nextClassify = {
      ok: false,
      reason: 'api',
      model: 'fake',
      usage: { input: 100, output: 0 },
      ms: 1,
    };
    const failedCall = await run('run-1');
    expect(failedCall.by).toMatchObject({ model: 0, tags: 11 });
    expect(failedCall.costUsd).toBeCloseTo(100 * 2e-6);

    anthropic.nextClassify = answer;
    await store.claim('spend', 10 ** 9); // spend reaches the stop
    await store.finish('spend', 10 ** 9, {
      ok: false,
      error: 'x',
      costUsd: LC_CATALOG_COST_STOP_USD,
    });
    const stopped = await run('run-2');
    expect(anthropic.classifyCalls).toHaveLength(1);
    expect(stopped.by).toMatchObject({ model: 0, tags: 11 });
  });

  it('caps the non-NeetCode problems at the limit (dev’s import)', async () => {
    const { run } = setup();
    expect(await run('run-1', 3)).toMatchObject({ count: 5, by: { neetcode: 2 } });
  });

  it('refuses a run whose claim another job holds', async () => {
    const { store, source, anthropic } = setup();
    await store.claim('mine', 1);
    await expect(
      runCatalogImport({ store, source, anthropic, now: () => 2 }, { runId: 'theirs' }),
    ).rejects.toThrow(/lost its claim/);
  });
});
