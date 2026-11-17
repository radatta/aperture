import { catalogLoaded, loadCatalog, unpackCatalog } from '@aperture/shared';
import type { CatalogStore } from './store';

// Keeps the shared catalog registry (catalogs.ts → loadCatalog) on the store's live catalog, per Lambda container:
// `meta` is re-read at most every RECHECK_MS, the chunks only when its rev moves. Runs before any read that derives
// records (Backend.coachInput, the worker's pick). A failed load leaves whatever was loaded — or nothing, which is
// NeetCode 150 alone, exactly the catalog-less behaviour — and logs; it never fails the read it runs before.

export const RECHECK_MS = 60_000;
let checkedAt = -Infinity;

export async function ensureCatalog(store: CatalogStore, now: number): Promise<void> {
  if (now - checkedAt < RECHECK_MS) return;
  checkedAt = now;
  try {
    const meta = await store.meta();
    if (!meta?.live || !meta.rev || catalogLoaded()?.rev === meta.rev) return;
    const rows = unpackCatalog(await store.loadLive(meta));
    if (!rows) throw new Error(`catalog rev ${meta.rev} is missing chunks or malformed`);
    loadCatalog(rows, meta.rev);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'catalog load failed', error: String(err) }));
  }
}
// Tests, and the import's own end (so the BFF sees a new catalog at once): the next ensure reads meta again.
export function recheckCatalogSoon(): void {
  checkedAt = -Infinity;
}
