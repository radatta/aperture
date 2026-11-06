import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // CI's 2 vCPUs would default to one worker, and the fixture suite and board-cli's deliberate waits would run end to
    // end. Here too, so a flake from it shows before CI.
    maxWorkers: 2,
  },
});
