import { defineConfig } from 'vitest/config';

// aws-cdk-lib warns once per prod Function that still sets `logRetention` — a known deprecation, kept on purpose
// until the `cdk import` (lib/app-stack.ts, the log retention comment). vitest hands consecutive warnings over as
// one log, so drop a log only when nothing but this text is in it: any other warning still prints, in full.
const LOG_RETENTION_DEPRECATION =
  '[WARNING] aws-cdk-lib.aws_lambda.FunctionOptions#logRetention is deprecated.\n' +
  '  use `logGroup` instead\n' +
  '  This API will be removed in the next major release.';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Loading aws-cdk-lib is most of the run; one shared worker pays it once. Each test builds its own App.
    isolate: false,
    onConsoleLog: (log) =>
      log.split(LOG_RETENTION_DEPRECATION).join('').trim() === '' ? false : undefined,
  },
});
