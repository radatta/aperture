import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run totals for heavy.sh's job event, only under heavy.sh (docs/ops/SESSION-BOARD.md → Perf fields).
    globalSetup: process.env.HEAVY_DETAIL_DIR ? ['./src/board/vitest-stats.ts'] : [],
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // CI's 2 vCPUs would default to one worker, and the fixture suite and board-cli's deliberate waits would run end to
    // end. Here too, so a flake from it shows before CI.
    // package.json's test script pins VITEST_MAX_WORKERS=2 as well: vitest applies that env over this, and
    // heavy.sh's container tuning sets it to 4.
    maxWorkers: 2,
  },
});
