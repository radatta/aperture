import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Loading aws-cdk-lib is most of the run; one shared worker pays it once. Each test builds its own App.
    isolate: false,
  },
});
