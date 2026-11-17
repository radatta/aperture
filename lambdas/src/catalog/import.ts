import {
  buildCatalog,
  catalogCounts,
  classesOf,
  LC_CATALOG_COST_STOP_USD,
  LC_CATALOG_MODEL_ROWS_PER_KICK,
  LC_CATALOG_SOURCE,
  lcCatalogSourceUrl,
  packCatalog,
  parseClasses,
  trimSourceRows,
  unpackCatalog,
} from '@aperture/shared';
import type { LcClass } from '@aperture/shared';
import type { AnthropicGateway } from '../anthropic/gateway';
import {
  CATALOG_CLASSIFY_TIMEOUT_MS,
  CATALOG_CLASSIFY_USD,
  validateCatalogClasses,
} from '../anthropic/catalogClassifyPrompt';
import { recheckCatalogSoon } from './loader';
import type { CatalogSource } from './source';
import { stageComplete, stageText } from './store';
import type { CatalogMeta, CatalogStore } from './store';

// The full catalog's import (docs/areas/recruiting/coach.md → The catalog), one claimed run on the coach worker:
// fetch the pinned source, trim it, classify (NeetCode's facts, the non-algorithm rule, the uploaded classes, the
// live catalog's earlier model classes, then a few late rows by Sonnet while spend is under the stop), pack, publish.
// A failure keeps the live catalog and records the error. Idempotent: the same source and classes give the same
// catalog, and with nothing left to classify no model call is made.

export interface CatalogImportDeps {
  store: CatalogStore;
  source: CatalogSource;
  anthropic: AnthropicGateway;
  now: () => number;
  log?: (line: string) => void;
}

export async function runCatalogImport(
  deps: CatalogImportDeps,
  job: { runId: string; limit?: number },
): Promise<CatalogMeta> {
  const { store, now } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const meta = await store.meta(true);
  if (meta?.job?.runId !== job.runId) throw new Error('The catalog import lost its claim');
  let costUsd = meta.costUsd;
  try {
    const got = await deps.source.fetch(lcCatalogSourceUrl());
    if (!got.ok) throw new Error(got.error);
    const { rows: source, dropped } = trimSourceRows(got.data);
    if (!source.length) throw new Error('The source had no usable rows');

    const classes = new Map<number, LcClass>();
    if (meta.live)
      for (const [id, c] of classesOf(unpackCatalog(await store.loadLive(meta)) ?? []))
        classes.set(id, c);
    const stage = await store.stage();
    const staged = stageComplete(stage) ? parseClasses(stageText(stage)) : null;
    for (const [id, c] of staged?.classes ?? []) classes.set(id, c);

    let rows = buildCatalog(source, classes, job.limit);
    const pending = rows.filter((r) => r.by === 'tags').slice(0, LC_CATALOG_MODEL_ROWS_PER_KICK);
    let modelled = 0;
    if (pending.length && costUsd < LC_CATALOG_COST_STOP_USD) {
      const ids = new Set(pending.map((r) => r.id));
      const call = await deps.anthropic.catalogClassify({
        rows: source.filter((s) => ids.has(s.id)),
        timeoutMs: CATALOG_CLASSIFY_TIMEOUT_MS,
      });
      if (call.usage)
        costUsd +=
          call.usage.input * CATALOG_CLASSIFY_USD.input +
          call.usage.output * CATALOG_CLASSIFY_USD.output;
      if (call.ok) {
        const got = validateCatalogClasses(call.fields, [...ids]);
        for (const [id, c] of got) classes.set(id, c);
        modelled = got.size;
        rows = buildCatalog(source, classes, job.limit);
      }
    }

    const counts = catalogCounts(rows);
    const out = await store.finish(job.runId, now(), {
      ok: true,
      packed: packCatalog(rows),
      sha: LC_CATALOG_SOURCE.sha,
      counts,
      costUsd,
    });
    if (staged) await store.clearStage();
    recheckCatalogSoon();
    log(
      JSON.stringify({
        event: 'catalog_import',
        ok: true,
        rows: counts.count,
        dropped,
        badClasses: staged?.bad ?? 0,
        modelled,
        by: counts.by,
        costUsd: Math.round(costUsd * 10_000) / 10_000,
      }),
    );
    return out;
  } catch (err) {
    const error = (err as Error).message || String(err);
    log(JSON.stringify({ event: 'catalog_import', ok: false, error }));
    return store.finish(job.runId, now(), { ok: false, error, costUsd });
  }
}
