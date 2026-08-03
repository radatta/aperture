import { describe, it, expect } from 'vitest';
import App from './App';

// Phase 0 wiring proof: jsdom env is live and a .tsx component imports cleanly.
describe('app', () => {
  it('runs under jsdom', () => {
    expect(typeof document).toBe('object');
  });

  it('exposes App as a component', () => {
    expect(typeof App).toBe('function');
  });
});
