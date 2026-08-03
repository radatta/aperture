import { describe, it, expect } from 'vitest';
import { runtime } from './index';

// Phase 0 wiring proof: the Lambda package resolves @aperture/shared across the workspace.
describe('lambdas', () => {
  it('resolves the shared package', () => {
    expect(runtime).toBe('aperture-lambda');
  });
});
