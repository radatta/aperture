import { catalogLoaded, loadCatalog, unpackCatalog } from '@aperture/shared';
import type { CatalogStore } from './store';

// Keeps the shared catalog registry (catalogs.ts → loadCatalog) on the store's live catalog, per Lambda container:
// every call reads `meta` (one strongly consistent GetItem), and the chunks only when its rev moves — so a read right
// after an import, in any container, sees it. Runs before any read that derives records (Backend.coachInput, the
// worker's pick). A failed load leaves whatever was loaded — or nothing, which is NeetCode 150 alone, exactly the
// catalog-less behaviour — and logs; it never fails the read it runs before.

export async function ensureCatalog(store: CatalogStore): Promise<void> {
  try {
    const meta = await store.meta(true);
    if (!meta?.live || !meta.rev || catalogLoaded()?.rev === meta.rev) return;
    const rows = unpackCatalog(await store.loadLive(meta));
    if (!rows) throw new Error(`catalog rev ${meta.rev} is missing chunks or malformed`);
    loadCatalog(rows, meta.rev);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'catalog load failed', error: String(err) }));
  }
}
