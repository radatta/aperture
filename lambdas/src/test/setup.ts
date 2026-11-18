import { afterAll, afterEach } from 'vitest';
import { failOnConsoleNoise, installConsoleGuard } from '@aperture/shared/console-guard';

// A test that reaches console.error/console.warn fails (docs/product/CONVENTIONS.md → the console guard). The
// handlers' console.log lines stay out of it: vitest.config.ts shows them only for a failing test.
installConsoleGuard();
afterEach(() => failOnConsoleNoise());
afterAll(() => failOnConsoleNoise('after the last test in this file'));
