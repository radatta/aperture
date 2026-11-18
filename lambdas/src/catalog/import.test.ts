import { describe, expect, it } from 'vitest';
import {
  LC_CATALOG_COST_STOP_USD,
  LC_CATALOG_SOURCE,
  parseClasses,
  unpackCatalog,
} from '@aperture/shared';
import type { LcCatalogRow } from '@aperture/shared';
import { FakeAnthropic } from '../anthropic/gateway';
import type { CatalogClassifyRequest } from '../anthropic/gateway';
import { InMemoryDoc } from '../ddb/DocClient';
import { liveWrites } from '../ddb/writes';
import { FIXTURE_CLASSES, FIXTURE_SOURCE } from './fixture';
import { CALL_CEILING_USD, runCatalogImport } from './import';
import { FakeCatalogSource } from './source';
import { CatalogStore } from './store';

// The fixture's rows the classes leave to their tags: 9, 9004, 9005, 9007, 9009, 9011, 9012.
const TAGS_ONLY = [9, 9004, 9005, 9007, 9009, 9011, 9012];
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
  const logs: string[] = [];
  let t = 1_000;
  const deps = { store, source, anthropic, now: () => t, log: (l: string) => logs.push(l) };
  const run = async (runId: string, limit?: number) => {
    t += 200_000; // past any earlier claim
    await store.claim(runId, t);
    return runCatalogImport(deps, { runId, limit });
  };
  const rows = async () =>
    unpackCatalog(await store.loadLive((await store.meta(true))!)) as LcCatalogRow[];
  return { store, source, anthropic, run, rows, logs, deps };
}

describe('runCatalogImport', () => {
  it('builds from the pinned source, the uploaded classes and a few model rows, then clears the upload', async () => {
    const { store, source, anthropic, run, rows } = setup();
    anthropic.nextClassify = answer;
    await store.stagePart(1, 1, `${FIXTURE_CLASSES}\nnot a class line`, 1);
    const meta = await run('run-1');
    expect(source.urls).toEqual([
      `https://raw.githubusercontent.com/${LC_CATALOG_SOURCE.repo}/${LC_CATALOG_SOURCE.sha}/${LC_CATALOG_SOURCE.path}`,
    ]);
    expect(anthropic.classifyCalls[0]!.rows.map((r) => r.id)).toEqual(TAGS_ONLY);
    expect(meta).toMatchObject({
      live: 'a',
      sha: LC_CATALOG_SOURCE.sha,
      count: 15,
      premium: 1,
      by: { neetcode: 2, rule: 1, model: 12, tags: 0 },
      lastError: null,
      modelError: null,
      badClasses: 1,
      job: null,
    });
    expect(meta.costUsd).toBeCloseTo(1000 * 2e-6 + 500 * 10e-6);
    expect(await store.stage()).toMatchObject({ of: 0 });
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

  it('a capped import keeps every class it was given: a full one after it loses none', async () => {
    const { store, run } = setup();
    await store.stagePart(1, 1, FIXTURE_CLASSES, 1);
    expect(await run('run-1', 1)).toMatchObject({ count: 3 }); // NeetCode's two and one more
    const full = await run('run-2');
    expect(full.by).toMatchObject({ model: 5 }); // all five uploaded classes, though run-1 built none
    expect(parseClasses(await store.classesText()).classes.size).toBe(5);
  });

  it('keeps an upload that began while the job ran', async () => {
    const { store, run, deps } = setup();
    await store.stagePart(1, 1, FIXTURE_CLASSES, 1);
    const fetch = deps.source.fetch.bind(deps.source);
    deps.source.fetch = async (url) => {
      const got = await fetch(url);
      await store.stagePart(1, 2, 'new upload', 2); // a new upload's first part lands mid-job
      return got;
    };
    await run('run-1');
    expect(await store.stage()).toMatchObject({ of: 2, have: 1 });
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

  it('records a failed model call, keeps those rows on their tags, and charges a call with no usage at its ceiling', async () => {
    const { anthropic, run } = setup();
    anthropic.nextClassify = {
      ok: false,
      reason: 'api',
      detail: 'HTTP 529',
      model: 'fake',
      usage: { input: 100, output: 0 },
      ms: 1,
    };
    const failedCall = await run('run-1');
    expect(failedCall).toMatchObject({
      modelError: 'api: HTTP 529',
      by: { model: 0, tags: 12 },
    });
    expect(failedCall.costUsd).toBeCloseTo(100 * 2e-6);

    anthropic.nextClassify = {
      ok: false,
      reason: 'timeout',
      model: 'fake',
      usage: null,
      ms: 45_000,
    };
    const timedOut = await run('run-2');
    expect(timedOut.costUsd).toBeCloseTo(100 * 2e-6 + CALL_CEILING_USD);
    expect(timedOut.modelError).toBe('timeout');

    anthropic.nextClassify = answer;
    expect((await run('run-3')).modelError).toBeNull();
  });

  it('makes no model call once spend reaches the stop; rows stay on their tags', async () => {
    const { store, anthropic, run } = setup();
    anthropic.nextClassify = answer;
    await store.claim('spend', 1);
    await store.finish('spend', 1, { ok: false, error: 'x', costUsd: LC_CATALOG_COST_STOP_USD });
    const stopped = await run('run-1');
    expect(anthropic.classifyCalls).toHaveLength(0);
    expect(stopped.by).toMatchObject({ model: 0, tags: 12 });
  });

  it('caps the non-NeetCode problems at the limit (dev’s import)', async () => {
    const { run } = setup();
    expect(await run('run-1', 3)).toMatchObject({ count: 5, by: { neetcode: 2 } });
  });

  it('refuses, and logs, a run whose claim another job holds', async () => {
    const { store, deps, logs } = setup();
    await store.claim('mine', 1);
    await expect(runCatalogImport(deps, { runId: 'theirs' })).rejects.toThrow(/lost its claim/);
    expect(logs.at(-1)).toContain('lost its claim');
  });
});
