import { describe, expect, it } from 'vitest';
import { failOnConsoleNoise } from '@aperture/shared/console-guard';

// setup.ts installs the guard for every lambdas test. Each test drains the record itself, so setup's afterEach
// finds it empty and the file stays green.
describe('the lambdas console guard (setup.ts)', () => {
  it('fails on console.error and console.warn, naming each', () => {
    console.error(JSON.stringify({ event: 'something_broke' }));
    console.warn('careful');
    expect(() => failOnConsoleNoise()).toThrow(
      /^2 unexpected console call\(s\)[\s\S]*console\.error: \{"event":"something_broke"\}[\s\S]*console\.warn: careful/,
    );
  });

  it('leaves console.log to the reporter: a handler’s structured log is not noise', () => {
    console.log(JSON.stringify({ event: 'rpc_failed' }));
    expect(() => failOnConsoleNoise()).not.toThrow();
  });
});
