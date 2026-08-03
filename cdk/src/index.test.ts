import { describe, it, expect } from 'vitest';
import { CDK_PLACEHOLDER } from './index';

describe('cdk', () => {
  it('is wired', () => {
    expect(CDK_PLACEHOLDER).toBe(true);
  });
});
