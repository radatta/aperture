import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { lcExtensionVersion } from './pwa/extensionVersion.ts';

// auth.test.tsx rebuilds the module registry (vi.resetModules), so it runs alone in an isolated
// worker; every other file shares one jsdom and one module graph per worker — the per-file jsdom was
// ~60% of the suite on CI's single worker. CI runs the suite as two --shard halves (ci.yml), each on
// one worker. setup.ts resets the shared state between tests.
const REBUILDS_MODULES = 'src/auth/auth.test.tsx';

// The app runs in the user's browser, so its tests run in the user's zone, whatever the shell or CI's
// (UTC) is: a stub date bug then reads as it would on the phone. Set before vitest forks its workers,
// which inherit it; src/test/tz.test.ts guards it. (lambdas pins UTC, the Lambda's zone.)
process.env.TZ = 'America/Los_Angeles';
// As vite.config.ts sets it for a build (this config doesn't load that one): the manifest's version.
process.env.VITE_LC_EXTENSION_VERSION = lcExtensionVersion();

export default defineConfig({
  plugins: [react()],
  test: {
    // Run totals for heavy.sh's job event, only under heavy.sh (docs/ops/SESSION-BOARD.md → Perf fields).
    globalSetup: process.env.HEAVY_DETAIL_DIR ? ['../scripts/src/board/vitest-stats.ts'] : [],
    environment: 'jsdom',
    setupFiles: ['./src/test/guard.ts', './src/test/setup.ts'],
    // Shuffled every run so an order dependence between files shows up as a red run, not a false pass.
    // The seed is printed; reproduce with --sequence.seed=<n>.
    sequence: { shuffle: { files: true } },
    // CSS is stubbed to '' in tests; tokens.css alone comes through, so tokens.test.ts can read its hexes
    // (`?raw`). Only main.tsx imports it at runtime, and no test imports main.
    css: { include: [/styles\/tokens\.css(\?|$)/] },
    // `include` lives per project, not here: with `extends: true` arrays concatenate, so a root include
    // would leak the full glob into the isolated project.
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          include: ['src/**/*.test.{ts,tsx}', 'pwa/**/*.test.ts'],
          exclude: [...configDefaults.exclude, REBUILDS_MODULES],
          isolate: false,
        },
      },
      { extends: true, test: { name: 'isolated', include: [REBUILDS_MODULES] } },
    ],
  },
});
