import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { APERTURE_MANIFEST } from './pwa/manifest.ts';

// https://vite.dev/config/
export default defineConfig({
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
