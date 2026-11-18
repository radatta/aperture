import { hostname } from 'node:os';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { APERTURE_MANIFEST } from './pwa/manifest.ts';
import { identityPages } from './pwa/identityPages.ts';
import { lcExtensionVersion } from './pwa/extensionVersion.ts';

// Port ownership — so a listening port always tells you WHOSE dev server it is (docs/ops/COI-SANDBOX.md
// → Ports): 5173+ is you on the Mac, 6173+ is a COI container. Vite walks upward from its base port
// when one is taken, which is what makes several Claude sessions in one container work; `.coi/config.toml`
// maps 6173–6183, so whichever it lands on is reachable from the host. Past 6183 it still runs, just
// unmapped. `preview` shares the base deliberately — it increments into the same mapped range.
const DEV_PORT = hostname().startsWith('coi-') ? 6173 : 5173;

// The build marker: index.html's %VITE_BUILD_SHA% and BUILD_SHA (src/shared/env.ts). publish-frontend.mjs
// sets the deployed commit; any other build says 'local' rather than shipping the literal placeholder.
process.env.VITE_BUILD_SHA ||= 'local';
// The LeetCode extension's version this app is built with: Settings → LeetCode's "latest" (LC_EXTENSION_VERSION in
// src/shared/env.ts). Always from the checkout's manifest, never an outside value.
process.env.VITE_LC_EXTENSION_VERSION = lcExtensionVersion();

// The deployed wasm is brotli-encoded (scripts/aws/publish-frontend.mjs). Its hash is of bytes that never
// change between builds, so the suffix gives the encoded body a key the uncompressed one never had: an edge
// keeps the old key for a year (immutable, no invalidation — INFRA §7), and an old shell still fetching it
// gets the body it was built for (docs/areas/flux D63).
const assetFileNames = (info: { names: string[] }) =>
  info.names.some((n) => n.endsWith('.wasm'))
    ? 'assets/[name]-[hash].br.wasm'
    : 'assets/[name]-[hash][extname]';

// The local check (docs/ops/LOCAL-CHECK.md) serves the app against its own local server: the paths CloudFront
// sends to a Lambda are proxied to the CloudFront stand-in (lambdas/src/local/edge.ts). Unset everywhere else.
const LOCAL_EDGE = process.env.APERTURE_LOCAL_EDGE;
const localProxy = LOCAL_EDGE
  ? Object.fromEntries(
      [
        '/api/',
        '/mcp',
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-authorization-server',
        '/.well-known/openid-configuration',
      ].map((p) => [p, LOCAL_EDGE]),
    )
  : undefined;

// The local check's Vite doesn't watch (docs/ops/LOCAL-CHECK.md → Vite): a session editing its tree mid-run had it
// full-reload the page under a step. Unset everywhere else.
const NO_WATCH = !!process.env.APERTURE_NO_WATCH;

// https://vite.dev/config/
export default defineConfig({
  server: {
    port: DEV_PORT,
    ...(localProxy ? { proxy: localProxy } : {}),
    ...(NO_WATCH ? { watch: null } : {}),
  },
  preview: { port: DEV_PORT },
  // Flux's tracking worker is a module worker: MediaPipe's module glue sets ModuleFactory via ESM, and
  // Vite's default IIFE worker would make it silently no-op ("ModuleFactory not set").
  // The worker imports the wasm, so its emit goes through the worker build's rollup options, not `build`'s.
  worker: { format: 'es', rollupOptions: { output: { assetFileNames } } },
  build: { rollupOptions: { output: { assetFileNames } } },
  plugins: [
    react(),
    tailwindcss(),
    // about.html + privacy.html, filled from identifiers.json at the repo root (docs/ops/IDENTIFIERS.md).
    identityPages(
      new URL('./pages/', import.meta.url),
      new URL('../identifiers.json', import.meta.url),
    ),
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
        // Flux's wasm + model (~17 MB) stay out of the precache (the globs skip .wasm/.task) — only Flux
        // users pay for them, and modules/flux/engine/assets.ts caches them itself. No SW runtime cache on
        // top: it would store them twice and could cache a missing asset's SPA-fallback HTML.
      },
      devOptions: { enabled: false }, // SW off in `vite dev`; verify against `vite preview`
    }),
  ],
});
