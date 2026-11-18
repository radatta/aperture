import { describe, expect, it, vi } from 'vitest';
import { failOnConsoleNoise } from '@aperture/shared/console-guard';

// guard.ts installs the guard and reroutes jsdom's own errors into it. Each test drains the record itself, so
// setup's afterEach finds it empty and the file stays green.
describe('the app console guard (guard.ts)', () => {
  it('fails on what jsdom reports, which otherwise goes past vitest straight to stderr', () => {
    document.createElement('canvas').getContext('2d');
    expect(() => failOnConsoleNoise()).toThrow(
      /console\.error: Not implemented: HTMLCanvasElement's getContext\(\)/,
    );
  });

  it('fails on a React warning logged during the test', () => {
    console.error('Warning: Each child in a list should have a unique "key" prop.');
    expect(() => failOnConsoleNoise()).toThrow(
      /^1 unexpected console call\(s\)[\s\S]*unique "key" prop/,
    );
  });

  it('a spy with mockImplementation takes jsdom’s report instead: nothing left to fail on', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    document.createElement('canvas').getContext('2d');
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^Not implemented: HTMLCanvasElement's getContext/),
    );
    expect(() => failOnConsoleNoise()).not.toThrow();
  });
});
