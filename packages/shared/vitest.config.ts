import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run totals for heavy.sh's job event, only under heavy.sh (docs/ops/SESSION-BOARD.md → Perf fields).
    globalSetup: process.env.HEAVY_DETAIL_DIR ? ['../../scripts/src/board/vitest-stats.ts'] : [],
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
