import {
  buildCatalog,
  catalogCounts,
  formatClasses,
  LC_CATALOG_COST_STOP_USD,
  LC_CATALOG_MODEL_ROWS_PER_KICK,
  LC_CATALOG_SOURCE,
  lcCatalogSourceUrl,
  packCatalog,
  parseClasses,
  trimSourceRows,
} from '@aperture/shared';
import type { AnthropicGateway } from '../anthropic/gateway';
import {
  CATALOG_CLASSIFY_MAX_TOKENS,
  CATALOG_CLASSIFY_TIMEOUT_MS,
  CATALOG_CLASSIFY_USD,
  validateCatalogClasses,
} from '../anthropic/catalogClassifyPrompt';
import type { CatalogSource } from './source';
import type { CatalogMeta, CatalogStore } from './store';

// The full catalog's import (docs/areas/recruiting/coach.md → The full LeetCode catalog), one claimed run on the
// coach worker: fetch the pinned source, trim it, classify (NeetCode's facts, the non-algorithm rule, every class
// stored or just uploaded, then a few problems still on their tags by Sonnet while spend is under the stop), pack,
// publish. A failure keeps the live catalog and records the error. Idempotent: the same source and classes give the
// same catalog, and with nothing left to classify no model call is made.

export interface CatalogImportDeps {
  store: CatalogStore;
  source: CatalogSource;
  anthropic: AnthropicGateway;
  now: () => number;
  log?: (line: string) => void;
}

// A call that timed out reported no usage but may still be billed: charge its ceiling — a generous input estimate plus
// every output token it could have used. Any other failure without usage never reached the model (no key, a
// refused or overloaded request, a connection that failed) and costs nothing. The spend never resets on its own.
export const CALL_CEILING_USD =
  20_000 * CATALOG_CLASSIFY_USD.input + CATALOG_CLASSIFY_MAX_TOKENS * CATALOG_CLASSIFY_USD.output;

type Built = Parameters<CatalogStore['finish']>[2];
// A dev slot's import is capped here whatever the caller sent: its table's write ceiling and its one worker slot.
export const DEV_CATALOG_LIMIT = 300;

export async function runCatalogImport(
  deps: CatalogImportDeps,
  job: { runId: string; limit?: number },
): Promise<CatalogMeta> {
  const { store, now } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const meta = await store.meta(true);
  if (meta?.job?.runId !== job.runId) {
    log(JSON.stringify({ event: 'catalog_import', ok: false, error: 'lost its claim' }));
    throw new Error('The catalog import lost its claim');
  }
  let costUsd = meta.costUsd;
  let built: Built;
  let used: Awaited<ReturnType<CatalogStore['stage']>> = null;
  let summary: Record<string, unknown> = {};
  try {
    const got = await deps.source.fetch(lcCatalogSourceUrl());
    if (!got.ok) throw new Error(got.error);
    const { rows: source, dropped } = trimSourceRows(got.data);
    if (!source.length) throw new Error('The source had no usable rows');

    // Every class given so far, then the upload's on top.
    const classes = parseClasses(await store.classesText()).classes;
    const stage = await store.stage();
    const text = stage ? await store.stageText(stage) : null;
    const staged = text === null ? null : parseClasses(text);
    if (staged) used = stage;
    for (const [id, c] of staged?.classes ?? []) classes.set(id, c);

    let rows = buildCatalog(source, classes, job.limit);
    const pending = rows.filter((r) => r.by === 'tags').slice(0, LC_CATALOG_MODEL_ROWS_PER_KICK);
    let modelled = 0;
    let modelError: string | null = null;
    if (pending.length && costUsd < LC_CATALOG_COST_STOP_USD) {
      const ids = new Set(pending.map((r) => r.id));
      const call = await deps.anthropic.catalogClassify({
        rows: source.filter((s) => ids.has(s.id)),
        timeoutMs: CATALOG_CLASSIFY_TIMEOUT_MS,
      });
      costUsd += call.usage
        ? call.usage.input * CATALOG_CLASSIFY_USD.input +
          call.usage.output * CATALOG_CLASSIFY_USD.output
        : !call.ok && call.reason === 'timeout'
          ? CALL_CEILING_USD
          : 0;
      // Counted against the stop now, so a run that dies before `finish` can't lose it.
      if (!(await store.recordSpend(job.runId, costUsd, now())))
        throw new Error('The catalog import lost its claim');
      if (call.ok) {
        const answered = validateCatalogClasses(call.fields, [...ids]);
        for (const [id, c] of answered) classes.set(id, c);
        modelled = answered.size;
        if (!answered.size) modelError = 'the model answered with no usable class';
        rows = buildCatalog(source, classes, job.limit);
      } else modelError = `${call.reason}${call.detail ? `: ${call.detail}` : ''}`.slice(0, 200);
    }

    const counts = catalogCounts(rows);
    built = {
      ok: true,
      packed: packCatalog(rows),
      classes: formatClasses(classes),
      sha: LC_CATALOG_SOURCE.sha,
      counts,
      costUsd,
      modelError,
      badClasses: staged ? staged.bad : null,
    };
    summary = {
      rows: counts.count,
      dropped,
      badClasses: staged?.bad ?? null,
      modelled,
      modelError,
      by: counts.by,
    };
  } catch (err) {
    built = { ok: false, error: (err as Error).message || String(err), costUsd };
  }

  // Published (or failed) once; a lost claim here throws, logged, and leaves the newer job's catalog alone. A publish
  // that fails otherwise (a throttled put) is recorded as the import's failure, then thrown.
  let out: CatalogMeta;
  try {
    out = await store.finish(job.runId, now(), built);
  } catch (err) {
    const error = (err as Error).message || String(err);
    log(JSON.stringify({ event: 'catalog_import', ok: false, error }));
    if (built.ok && !/lost its claim/.test(error))
      await store
        .finish(job.runId, now(), { ok: false, error: `publishing failed: ${error}`, costUsd })
        .catch(() => {}); // the claim gone too: nothing left to record
    throw err;
  }
  // The upload is in the stored classes now; empty it unless a new one began meanwhile.
  if (built.ok && used)
    try {
      await store.clearStage(used, now());
    } catch (err) {
      log(JSON.stringify({ event: 'catalog_stage_clear_failed', error: (err as Error).message }));
    }
  log(
    JSON.stringify({
      event: 'catalog_import',
      ok: built.ok,
      ...(built.ok ? summary : { error: built.error }),
      costUsd: Math.round(costUsd * 10_000) / 10_000,
    }),
  );
  return out;
}
