import { defineConfig } from 'vitest/config';

// The extension ships as plain browser scripts (no build); the tests load the real files — the pure libs
// through require, the page scripts into a jsdom window or a vm with a fake extension API (test/load.ts).
export default defineConfig({
  test: {
    // Run totals for heavy.sh's job event, only under heavy.sh (docs/ops/SESSION-BOARD.md → Perf fields).
    globalSetup: process.env.HEAVY_DETAIL_DIR ? ['../scripts/src/board/vitest-stats.ts'] : [],
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
