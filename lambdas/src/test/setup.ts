import { afterAll, afterEach } from 'vitest';
import { failOnConsoleNoise, installConsoleGuard } from '@aperture/shared/console-guard';

// A test that reaches console.error/console.warn fails (docs/product/CONVENTIONS.md → the console guard). The
// handlers' console.log lines stay out of it: vitest.config.ts shows them only for a failing test.
installConsoleGuard();
afterEach(() =>
  failOnConsoleNoise('by this test — or left by an earlier one still running a timer or promise'),
);
// One macrotask first, so a fire-and-forget write's log lands while the file can still fail on it.
afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  failOnConsoleNoise('after the last test in this file');
});
