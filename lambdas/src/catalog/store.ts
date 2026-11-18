import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  CatalogImportState,
  CatalogStatus,
  LcClassifiedBy,
  LcPackedCatalog,
} from '@aperture/shared';
import type { DocClient } from '../ddb/DocClient';
import { ConditionFailedError } from '../ddb/DocClient';
import { CATALOG_PK, catalogSk } from '../ddb/keys';
import type { Writes } from '../ddb/writes';

// The full LeetCode catalog's partition (keys.ts → `catalog#leetcode`), stage-wide, not a user's:
//   meta          — the live slot, its rev and counts, the job's claim, model spend, the last errors
//   classes       — every class ever given (uploaded or the model's), gzipped: what the next import starts from,
//                   whatever an import's `limit` built
//   stage         — the upload under way: its size and the parts in so far; stagepart#NN holds each part's text
//   slot#a#NN / slot#b#NN — the packed catalog, gzipped, base64, in ≤ CHUNK_CHARS pieces stamped with their rev
// An import writes the slot that isn't live, then flips `meta` with a conditional put on the version it read and
// its own claim: a reader sees the old catalog or the new one, never half of either. Every write goes through
// `writes`, and the worker's role may put but never delete (cdk coach-worker): an emptied row is a put.

type Slot = 'a' | 'b';
// ~40 KB a write, each under dev's 50-unit write ceiling (docs/arch/INFRA.md §11) — per write, not per second: dev's
// imports stay capped (the worker clamps `limit` on a dev slot), so they're one chunk. A test passes a smaller one.
const CHUNK_CHARS = 40_000;
// A job's claim lapses after this: the worker's async event may queue 60 s (maxEventAge) and run 90 s (its timeout),
// so a claim always outlives the job it starts.
export const CLAIM_MS = 180_000;

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
  modelError: string | null;
  badClasses: number;
  job: { runId: string; claimedAt: number } | null;
  updatedAt: number;
}
export interface CatalogStage {
  of: number; // 0: none under way
  have: number; // parts 1…have are in, in order
  upload: string; // the upload's id, stamped on each of its part rows: another upload's rows never join it
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
  modelError: null,
  badClasses: 0,
  job: null,
};
const metaOf = (it: Record<string, unknown> | null): CatalogMeta | null =>
  it
    ? ({ ...EMPTY_META, ...(it.meta as object), updatedAt: it.updatedAt as number } as CatalogMeta)
    : null;
const gz = (text: string) => gzipSync(text).toString('base64');
const gunz = (data: string) => gunzipSync(Buffer.from(data, 'base64')).toString('utf8');

export const stageComplete = (s: CatalogStage | null): boolean =>
  !!s && s.of > 0 && s.have === s.of;

// The state from the job and the live catalog; an upload still held shows in `staged` — under way, or complete and
// waiting for a kick (its last part came while another job ran) — and is the state only while there's nothing else
// to say (an abandoned upload never hides a live catalog).
export function catalogState(
  meta: CatalogMeta | null,
  stage: CatalogStage | null,
  now: number,
): CatalogImportState {
  if (meta?.job && now - meta.job.claimedAt < CLAIM_MS) return 'running';
  if (meta?.live) return meta.by && meta.by.tags > 0 ? 'partial' : 'ready';
  if (stage && stage.of > 0 && !stageComplete(stage)) return 'staging';
  return meta?.lastError ? 'failed' : 'absent';
}
export function catalogStatus(
  meta: CatalogMeta | null,
  stage: CatalogStage | null,
  now: number,
): CatalogStatus {
  return {
    state: catalogState(meta, stage, now),
    sha: meta?.live ? meta.sha : null,
    count: meta?.live ? meta.count : 0,
    premium: meta?.live ? meta.premium : 0,
    by: meta?.live ? meta.by : null,
    importedAt: meta?.importedAt ?? null,
    staged: stage && stage.of > 0 ? { have: stage.have, of: stage.of } : null,
    costUsd: meta?.costUsd ?? 0,
    lastError: meta?.lastError ?? null,
    modelError: meta?.modelError ?? null,
    badClasses: meta?.badClasses ?? 0,
  };
}

// A part refused for its place in the upload: the caller's error (a 400), with why.
export class StageOrderError extends Error {}

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
          of: (it.of as number) ?? 0,
          have: (it.have as number) ?? 0,
          upload: typeof it.upload === 'string' ? it.upload : '',
          updatedAt: it.updatedAt as number,
        }
      : null;
  }

  // One part of an upload, in order: a part 1 starts a new one (replacing any upload under way), part k needs parts
  // 1…k-1 of the same size already in. Its text goes in its own row stamped with the upload's id, then the header
  // moves on, conditional on the header as read: a concurrent part loses with a refusal, and a part row another
  // upload overwrote never joins this one's text (stageText reads only rows with its id).
  async stagePart(part: number, of: number, text: string, now: number): Promise<CatalogStage> {
    const cur = await this.stage();
    if (part !== 1) {
      if (!cur || cur.of === 0)
        throw new StageOrderError(`No upload under way: send part 1 of ${of} first`);
      if (cur.of !== of)
        throw new StageOrderError(
          `The upload under way has ${cur.of} parts, not ${of}: start again from part 1`,
        );
      if (cur.have !== part - 1)
        throw new StageOrderError(
          cur.have >= part
            ? `Part ${part} is already in (${cur.have} of ${of}): start again from part 1 to replace it`
            : `Send part ${cur.have + 1} next (${cur.have} of ${of} in)`,
        );
    }
    const updatedAt = Math.max(now, (cur?.updatedAt ?? 0) + 1);
    const upload =
      part === 1 ? `u${updatedAt}-${Math.random().toString(36).slice(2, 10)}` : cur!.upload;
    await this.writes.put({
      PK: CATALOG_PK,
      SK: catalogSk.stagePart(part),
      upload,
      text,
      updatedAt: now,
    });
    const next: CatalogStage = { of, have: part, upload, updatedAt };
    try {
      await this.writes.putIf(
        { PK: CATALOG_PK, SK: catalogSk.stage(), of, have: part, upload, updatedAt },
        cur?.updatedAt ?? null,
      );
    } catch (err) {
      if (err instanceof ConditionFailedError)
        throw new StageOrderError('Another part arrived at the same time: start again from part 1');
      throw err;
    }
    return next;
  }
  // The whole upload's text, its parts joined as sent; null unless every part is in.
  async stageText(stage: CatalogStage): Promise<string | null> {
    if (!stageComplete(stage)) return null;
    const prefix = catalogSk.stagePartPrefix();
    const rows = await this.doc.query(CATALOG_PK, prefix, { consistent: true });
    const byPart = new Map(rows.map((r) => [Number(r.SK.slice(prefix.length)), r]));
    const parts: string[] = [];
    for (let p = 1; p <= stage.of; p++) {
      const r = byPart.get(p);
      if (!r || typeof r.text !== 'string' || r.upload !== stage.upload) return null;
      parts.push(r.text);
    }
    return parts.join('');
  }
  // Empties the upload once an import used it — only if no new upload began since `stage` was read.
  async clearStage(stage: CatalogStage, now: number): Promise<boolean> {
    try {
      await this.writes.putIf(
        {
          PK: CATALOG_PK,
          SK: catalogSk.stage(),
          of: 0,
          have: 0,
          upload: '',
          updatedAt: Math.max(now, stage.updatedAt + 1),
        },
        stage.updatedAt,
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }

  // Every class the stage has been given, as parseClasses' file; '' before the first.
  async classesText(): Promise<string> {
    const it = await this.doc.get(CATALOG_PK, catalogSk.classes(), { consistent: true });
    return typeof it?.data === 'string' ? gunz(it.data) : '';
  }

  // The job's model spend, recorded as soon as the call returns (the claim kept), so a run that dies before
  // `finish` still counts it against the stop. false: the claim is no longer this job's, nothing written.
  async recordSpend(runId: string, costUsd: number, now: number): Promise<boolean> {
    const cur = await this.meta(true);
    if (!cur || cur.job?.runId !== runId) return false;
    try {
      await this.putMeta(
        { ...cur, costUsd, updatedAt: Math.max(now, cur.updatedAt + 1) },
        cur.updatedAt,
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
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

  // The job's end: on success the class map is saved, the packed catalog lands in the idle slot and meta flips to
  // it; either way the claim is released and the spend recorded. Only the claim's own holder may finish it.
  async finish(
    runId: string,
    now: number,
    out:
      | {
          ok: true;
          packed: LcPackedCatalog;
          classes: string;
          sha: string;
          counts: { count: number; premium: number; by: CatalogMeta['by'] };
          costUsd: number;
          modelError: string | null;
          badClasses: number | null; // null: no upload this time, keep the last count
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
      await this.writes.put({
        PK: CATALOG_PK,
        SK: catalogSk.classes(),
        data: gz(out.classes),
        updatedAt: now,
      });
      const slot: Slot = cur.live === 'a' ? 'b' : 'a';
      const rev = `${now}-${runId}`;
      const data = gz(JSON.stringify(out.packed));
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
        modelError: out.modelError,
        badClasses: out.badClasses ?? cur.badClasses,
      };
    } else next = { ...next, lastError: out.error.slice(0, 500) };
    await this.putMeta(next, cur.updatedAt);
    return next;
  }

  // The live slot's packed catalog, or null (none yet, or its chunks don't add up to the meta's rev).
  async loadLive(meta: CatalogMeta): Promise<unknown> {
    if (!meta.live || !meta.rev) return null;
    const chunks = (
      await this.doc.query(CATALOG_PK, catalogSk.slotPrefix(meta.live), { consistent: true })
    ).filter((c) => c.rev === meta.rev);
    const of = chunks[0]?.of;
    if (typeof of !== 'number' || chunks.length < of) return null;
    const data = chunks
      .slice(0, of)
      .sort((x, y) => (x.part as number) - (y.part as number))
      .map((c) => c.data as string)
      .join('');
    return JSON.parse(gunz(data));
  }

  private async putMeta(meta: CatalogMeta, expected: number | null): Promise<void> {
    const { updatedAt, ...rest } = meta;
    await this.writes.putIf(
      { PK: CATALOG_PK, SK: catalogSk.meta(), meta: rest, updatedAt },
      expected,
    );
  }
}
