// @aperture/lambdas — the coach worker Lambda (cdk/src/lib/coach-worker.ts): the LeetCode coach's AI pick runs here,
// invoked async (InvocationType 'Event') by the BFF or the MCP function, at most once a day a user
// (docs/areas/recruiting/coach.md → The AI pick). So does the full catalog's import (`kind: 'catalog-import'`,
// catalog/import.ts → The catalog), which also fetches the pinned public source. It never serves HTTP. Its role reads
// the table, puts rows and reads the Anthropic key, nothing else. The logic is coach/pick.ts and catalog/import.ts;
// this is the AWS edge.
import { isDayKey } from '@aperture/shared';
import { createLiveAnthropic } from './anthropic/liveAnthropic';
import type { CatalogImportEvent } from './catalog/invoker';
import { runCatalogImport } from './catalog/import';
import { ensureCatalog } from './catalog/loader';
import { liveCatalogSource } from './catalog/source';
import type { CatalogSource } from './catalog/source';
import { CatalogStore } from './catalog/store';
import type { CatalogMeta } from './catalog/store';
import type { AnthropicGateway } from './anthropic/gateway';
import type { CoachPickEvent } from './coach/invoker';
import { runCoachPick } from './coach/pick';
import type { CoachPickRun } from './coach/pick';
import { createLiveDoc } from './ddb/LiveDoc';
import type { DocClient } from './ddb/DocClient';
import { Repo } from './ddb/repo';
import { liveWrites } from './ddb/writes';

const doc = createLiveDoc(process.env.TABLE_NAME ?? 'aperture');
const anthropic = createLiveAnthropic({ stage: process.env.STAGE ?? 'dev' });
const source = liveCatalogSource();

export type CoachWorkerEvent = CoachPickEvent;

// The catalog import's event, refused when malformed like a pick's.
export function parseCatalogImportEvent(raw: unknown): CatalogImportEvent {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (typeof e.runId !== 'string' || e.runId.trim() === '')
    throw new Error('Invalid catalog import event: runId');
  if (e.limit !== undefined && !(Number.isInteger(e.limit) && (e.limit as number) > 0))
    throw new Error('Invalid catalog import event: limit');
  return {
    kind: 'catalog-import',
    runId: e.runId,
    ...(e.limit !== undefined ? { limit: e.limit as number } : {}),
  };
}
export async function handleCatalogImport(
  table: DocClient,
  gateway: AnthropicGateway,
  src: CatalogSource,
  raw: unknown,
  opts: { now?: () => number } = {},
): Promise<CatalogMeta> {
  const e = parseCatalogImportEvent(raw);
  const store = new CatalogStore(table, liveWrites(table));
  return runCatalogImport({ store, source: src, anthropic: gateway, now: opts.now ?? Date.now }, e);
}
const isCatalogImport = (raw: unknown) =>
  !!raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'catalog-import';

// Anything else is a malformed invoke — refuse it before doing any work.
export function parseCoachWorkerEvent(raw: unknown): CoachWorkerEvent {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (typeof e.userId !== 'string' || e.userId.trim() === '')
    throw new Error('Invalid coach worker event: userId');
  if (typeof e.day !== 'string' || !isDayKey(e.day))
    throw new Error('Invalid coach worker event: day');
  if (typeof e.claimId !== 'string' || e.claimId.trim() === '')
    throw new Error('Invalid coach worker event: claimId');
  return { userId: e.userId, day: e.day, claimId: e.claimId };
}

// The core, AWS-free for tests. One line a run, no user text (and no user id, as finance-sync's lines).
export async function handleCoachPick(
  table: DocClient,
  gateway: AnthropicGateway,
  raw: unknown,
  opts: { now?: () => number } = {},
): Promise<CoachPickRun> {
  const e = parseCoachWorkerEvent(raw);
  // The pick names problems: the full catalog's facts, when imported (catalog/loader.ts).
  await ensureCatalog(new CatalogStore(table, liveWrites(table)), (opts.now ?? Date.now)());
  const run = await runCoachPick(
    {
      repo: new Repo(table, liveWrites(table), e.userId),
      anthropic: gateway,
      now: opts.now ?? Date.now,
    },
    e,
  );
  console.log(JSON.stringify({ event: 'coach_worker', run, day: e.day, claimId: e.claimId }));
  return run;
}

export async function handler(event: unknown): Promise<CoachPickRun | CatalogMeta> {
  return isCatalogImport(event)
    ? handleCatalogImport(doc, anthropic, source, event)
    : handleCoachPick(doc, anthropic, event);
}
