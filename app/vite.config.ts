import { hostname } from 'node:os';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { APERTURE_MANIFEST } from './pwa/manifest.ts';

// Port ownership — so a listening port always tells you WHOSE dev server it is (docs/ops/COI-SANDBOX.md
// → Ports): 5173+ is you on the Mac, 6173+ is a COI container. Vite walks upward from its base port
// when one is taken, which is what makes several Claude sessions in one container work; `.coi/config.toml`
// maps 6173–6183, so whichever it lands on is reachable from the host. Past 6183 it still runs, just
// unmapped. `preview` shares the base deliberately — it increments into the same mapped range.
const DEV_PORT = hostname().startsWith('coi-') ? 6173 : 5173;

// https://vite.dev/config/
export default defineConfig({
  server: { port: DEV_PORT },
  preview: { port: DEV_PORT },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate', // ship a new shell the moment it's built; no update prompt
      manifest: APERTURE_MANIFEST,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      workbox: {
        // Precache the app SHELL only. Data (the Phase 10 Lambda /api/*) is deliberately left
        // network-only — TECH §1 online-first: never serve a stale plan/count from the SW cache.
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false }, // SW off in `vite dev`; verify against `vite preview`
    }),
  ],
});
