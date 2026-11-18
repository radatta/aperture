import { catalogLoaded, loadCatalog, unpackCatalog } from '@aperture/shared';
import type { CatalogStore } from './store';

// Keeps the shared catalog registry (catalogs.ts → loadCatalog) on the store's live catalog, per Lambda container:
// every call reads `meta` (one strongly consistent GetItem), and the chunks only when its rev moves — so a read right
// after an import, in any container, sees it. Runs before any read that derives records (Backend.coachInput, the
// worker's pick). A failed load leaves whatever was loaded — or nothing, which is NeetCode 150 alone, exactly the
// catalog-less behaviour — and logs; it never fails the read it runs before.

// A rev that wouldn't load isn't retried for this long (each try is the whole slot's query and a parse, and a log
// line): the meta read stays per call, so a new rev still loads at once.
export const FAILED_REV_RETRY_MS = 60_000;
let failed: { rev: string; at: number } | null = null;

export async function ensureCatalog(store: CatalogStore, now = Date.now()): Promise<void> {
  let rev: string | null = null;
  try {
    const meta = await store.meta(true);
    rev = meta?.rev ?? null;
    if (!meta?.live || !meta.rev || catalogLoaded()?.rev === meta.rev) return;
    if (failed?.rev === meta.rev && now - failed.at < FAILED_REV_RETRY_MS) return;
    const rows = unpackCatalog(await store.loadLive(meta));
    if (!rows) {
      failed = { rev: meta.rev, at: now };
      throw new Error(`catalog rev ${meta.rev} is missing chunks or malformed`);
    }
    loadCatalog(rows, meta.rev);
    failed = null;
  } catch (err) {
    if (rev && catalogLoaded()?.rev !== rev && failed?.rev !== rev) failed = { rev, at: now };
    console.error(JSON.stringify({ msg: 'catalog load failed', error: String(err) }));
  }
}
// Tests: forget a failed rev.
export function resetCatalogLoader(): void {
  failed = null;
}
