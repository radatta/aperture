import { describe, it, expect } from 'vitest';
import { cx } from './cx';

describe('cx', () => {
  it('joins truthy parts and drops falsy ones', () => {
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
  });
  it('is empty when nothing is truthy', () => {
    expect(cx(false, null, undefined)).toBe('');
  });
});
