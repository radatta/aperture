import { defineConfig } from 'vitest/config';

// The Lambda runs in UTC, so its tests do too: a local-getter date bug (an evening day key) shows here
// instead of only in prod. Set before vitest forks its workers, which inherit it; tz.test.ts guards it.
process.env.TZ = 'UTC';
// Off a stage, as a dev shell is: the strict-auth signal (auth/strict.ts) must come from a test that sets it, never
// from a STAGE the shell exported. Tests that need it set it and delete it after.
delete process.env.STAGE;
delete process.env.AWS_LAMBDA_FUNCTION_NAME;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    // The handlers' structured logs (rpc_failed and the rest, ~800 blocks a run from tests that hit error paths on
    // purpose) print only for a failing test, where they help. console.error/warn fail the test (setup.ts).
    silent: 'passed-only',
  },
});
