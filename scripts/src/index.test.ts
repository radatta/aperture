import { describe, it, expect } from 'vitest';
import { SCRIPTS_PLACEHOLDER } from './index';

describe('scripts', () => {
  it('is wired', () => {
    expect(SCRIPTS_PLACEHOLDER).toBe(true);
  });
});
