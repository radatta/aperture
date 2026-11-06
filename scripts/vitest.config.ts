import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One worker is the default on CI's 2 vCPUs, so the fixture suite and board-cli's deliberate waits run end to end.
    maxWorkers: 2,
  },
});
