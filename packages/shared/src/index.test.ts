import { describe, it, expect } from 'vitest';
import { APERTURE } from './index';

describe('shared', () => {
  it('exports the package marker', () => {
    expect(APERTURE).toBe('aperture');
  });
});
