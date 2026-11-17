import { gunzipSync, gzipSync } from 'node:zlib';
import type { CatalogImportState, LcClassifiedBy, LcPackedCatalog } from '@aperture/shared';
import type { DocClient } from '../ddb/DocClient';
import { ConditionFailedError } from '../ddb/DocClient';
import { CATALOG_PK, catalogSk } from '../ddb/keys';
import type { Writes } from '../ddb/writes';

// The full LeetCode catalog's partition (keys.ts → `catalog#leetcode`), stage-wide, not a user's:
//   meta        — the live slot, its rev and counts, the job's claim, cumulative model spend, the last error
//   stage       — a classification upload's parts, until the import that uses them
//   slot#a#NN / slot#b#NN — the packed catalog, gzipped, base64, in ≤ CHUNK_CHARS pieces stamped with their rev
// An import writes the slot that isn't live, then flips `meta` with a conditional put on the version it read and
// its own claim: a reader sees the old catalog or the new one, never half of either. Writes go through `writes`.

type Slot = 'a' | 'b';
const CHUNK_CHARS = 300_000; // well under DynamoDB's 400 KB item; a test passes a smaller one
export const CLAIM_MS = 120_000; // a job's claim lapses after this (the worker's own timeout is 90 s)

export interface CatalogMeta {
  live: Slot | null;
  rev: string | null;
  sha: string | null;
  count: number;
  premium: number;
  by: Record<LcClassifiedBy, number> | null;
  importedAt: number | null;
  costUsd: number;
  lastError: string | null;
  job: { runId: string; claimedAt: number } | null;
  updatedAt: number;
}
export interface CatalogStage {
  of: number;
  parts: Record<string, string>;
  updatedAt: number;
}
const EMPTY_META: Omit<CatalogMeta, 'updatedAt'> = {
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
};
const metaOf = (it: Record<string, unknown> | null): CatalogMeta | null =>
  it
    ? ({ ...EMPTY_META, ...(it.meta as object), updatedAt: it.updatedAt as number } as CatalogMeta)
    : null;

export const stageHave = (s: CatalogStage | null) => (s ? Object.keys(s.parts).length : 0);
export const stageComplete = (s: CatalogStage | null): s is CatalogStage =>
  !!s && stageHave(s) === s.of;
export const stageText = (s: CatalogStage) =>
  Array.from({ length: s.of }, (_, i) => s.parts[String(i + 1)] ?? '').join('\n');

export function catalogState(
  meta: CatalogMeta | null,
  stage: CatalogStage | null,
  now: number,
): CatalogImportState {
  if (meta?.job && now - meta.job.claimedAt < CLAIM_MS) return 'running';
  if (stage && !stageComplete(stage)) return 'staging';
  if (!meta?.live) return meta?.lastError ? 'failed' : 'absent';
  return meta.by && meta.by.tags > 0 ? 'partial' : 'ready';
}

export class CatalogStore {
  constructor(
    private readonly doc: DocClient,
    private readonly writes: Writes,
    private readonly chunkChars = CHUNK_CHARS,
  ) {}

  async meta(consistent = false): Promise<CatalogMeta | null> {
    return metaOf(await this.doc.get(CATALOG_PK, catalogSk.meta(), { consistent }));
  }
  async stage(): Promise<CatalogStage | null> {
    const it = await this.doc.get(CATALOG_PK, catalogSk.stage(), { consistent: true });
    return it
      ? {
          of: it.of as number,
          parts: it.parts as Record<string, string>,
          updatedAt: it.updatedAt as number,
        }
      : null;
  }

  // One part of a classification upload. A part 1, or a part whose `of` differs from the stage's, starts a new
  // upload. Conditional on the stage as read: a concurrent part retries once on the newer stage.
  async stagePart(part: number, of: number, text: string, now: number): Promise<CatalogStage> {
    for (let tries = 0; ; tries++) {
      const cur = await this.stage();
      const fresh = !cur || part === 1 || cur.of !== of;
      const next: CatalogStage = {
        of,
        parts: { ...(fresh ? {} : cur.parts), [String(part)]: text },
        updatedAt: Math.max(now, (cur?.updatedAt ?? 0) + 1),
      };
      try {
        await this.writes.putIf(
          { PK: CATALOG_PK, SK: catalogSk.stage(), ...next },
          cur?.updatedAt ?? null,
        );
        return next;
      } catch (err) {
        if (!(err instanceof ConditionFailedError) || tries) throw err;
      }
    }
  }
  async clearStage(): Promise<void> {
    await this.writes.delete(CATALOG_PK, catalogSk.stage());
  }

  // Claims the import for `runId`: null (and nothing written) while another claim is younger than CLAIM_MS.
  async claim(runId: string, now: number): Promise<CatalogMeta | null> {
    const cur = await this.meta(true);
    if (cur?.job && now - cur.job.claimedAt < CLAIM_MS) return null;
    const next: CatalogMeta = {
      ...(cur ?? { ...EMPTY_META, updatedAt: 0 }),
      job: { runId, claimedAt: now },
      updatedAt: Math.max(now, (cur?.updatedAt ?? 0) + 1),
    };
    try {
      await this.putMeta(next, cur?.updatedAt ?? null);
      return next;
    } catch (err) {
      if (err instanceof ConditionFailedError) return null;
      throw err;
    }
  }

  // The job's end: on success the packed catalog lands in the idle slot and meta flips to it; either way the
  // claim is released. Only the claim's own holder may finish it (a lapsed claim another job took is theirs).
  async finish(
    runId: string,
    now: number,
    out:
      | {
          ok: true;
          packed: LcPackedCatalog;
          sha: string;
          counts: { count: number; premium: number; by: CatalogMeta['by'] };
          costUsd: number;
        }
      | { ok: false; error: string; costUsd: number },
  ): Promise<CatalogMeta> {
    const cur = await this.meta(true);
    if (!cur || cur.job?.runId !== runId) throw new Error('The catalog import lost its claim');
    let next: CatalogMeta = {
      ...cur,
      job: null,
      costUsd: out.costUsd,
      updatedAt: Math.max(now, cur.updatedAt + 1),
    };
    if (out.ok) {
      const slot: Slot = cur.live === 'a' ? 'b' : 'a';
      const rev = `${now}-${runId}`;
      const data = gzipSync(JSON.stringify(out.packed)).toString('base64');
      const parts = Math.max(1, Math.ceil(data.length / this.chunkChars));
      for (let i = 0; i < parts; i++)
        await this.writes.put({
          PK: CATALOG_PK,
          SK: catalogSk.chunk(slot, i),
          rev,
          part: i,
          of: parts,
          data: data.slice(i * this.chunkChars, (i + 1) * this.chunkChars),
          updatedAt: now,
        });
      next = {
        ...next,
        live: slot,
        rev,
        sha: out.sha,
        ...out.counts,
        importedAt: now,
        lastError: null,
      };
    } else next = { ...next, lastError: out.error.slice(0, 500) };
    await this.putMeta(next, cur.updatedAt);
    return next;
  }

  // The live slot's packed catalog, or null (none yet, or its chunks don't add up to the meta's rev).
  async loadLive(meta: CatalogMeta): Promise<unknown> {
    if (!meta.live || !meta.rev) return null;
    const chunks = (await this.doc.query(CATALOG_PK, catalogSk.slotPrefix(meta.live))).filter(
      (c) => c.rev === meta.rev,
    );
    const of = chunks[0]?.of;
    if (typeof of !== 'number' || chunks.length < of) return null;
    const data = chunks
      .slice(0, of)
      .sort((x, y) => (x.part as number) - (y.part as number))
      .map((c) => c.data as string)
      .join('');
    return JSON.parse(gunzipSync(Buffer.from(data, 'base64')).toString('utf8'));
  }

  private async putMeta(meta: CatalogMeta, expected: number | null): Promise<void> {
    const { updatedAt, ...rest } = meta;
    await this.writes.putIf(
      { PK: CATALOG_PK, SK: catalogSk.meta(), meta: rest, updatedAt },
      expected,
    );
  }
}
