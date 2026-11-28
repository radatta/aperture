import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { useState } from 'react';
import { failOnConsoleNoise } from '@aperture/shared/console-guard';

// setup.ts keeps React's act() checking on (docs/product/CONVENTIONS.md → the console guard). This file runs in the
// isolated project (vitest.config.ts), so the read below sees what setup did as the file loaded, not a flag an
// earlier file's test left behind in the shared jsdom.
const env = () => (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const atLoad = env();

describe('act() checking (setup.ts)', () => {
  it('is on as the file loads', () => {
    expect(atLoad).toBe(true);
    expect(env()).toBe(true);
  });

  it('a test may switch it off for itself', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    expect(env()).toBe(false);
  });

  // Reads what the test above left: tests in a file run in order (the config shuffles files, not tests).
  it('is back on for the next test', () => {
    expect(env()).toBe(true);
  });

  it('an update outside act() reaches the guard, with no spy in the way', () => {
    let bump!: () => void;
    function Counter() {
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return <p>{n}</p>;
    }
    render(<Counter />);
    bump();
    expect(() => failOnConsoleNoise()).toThrow(
      /An update to Counter inside a test was not wrapped in act/,
    );
  });
});
