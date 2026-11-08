import { defineConfig } from 'vitest/config';

// The Lambda runs in UTC, so its tests do too: a local-getter date bug (an evening day key) shows here
// instead of only in prod. Set before vitest forks its workers, which inherit it; tz.test.ts guards it.
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
