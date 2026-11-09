import { describe, expect, it } from 'vitest';
import { DEV_SLOTS, isDevSlot } from './stage';

describe('isDevSlot', () => {
  it('is true for both dev slots', () => {
    expect(DEV_SLOTS).toEqual(['dev', 'devb']);
    for (const s of DEV_SLOTS) expect(isDevSlot(s)).toBe(true);
  });

  it('is false for prod, empty, undefined and look-alikes', () => {
    for (const s of ['prod', '', undefined, 'DEV', 'devc', 'dev ', 'dev-main', 'devmain'])
      expect(isDevSlot(s)).toBe(false);
  });
});
