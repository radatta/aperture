import { describe, expect, it } from 'vitest';
import { devUlid } from './flux-history';

// The server refuses a set whose id isn't a ULID (fluxSetError), and scripts can't import the shared one.
describe('devUlid', () => {
  it('is 26 Crockford base32 chars, time first, so ids sort by when they were minted', () => {
    const a = devUlid(1_700_000_000_000);
    const b = devUlid(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10)).toBe('01HF7YAT00'); // 1_700_000_000_000 ms, as the shared ulid encodes it
    expect(a < b).toBe(true);
    expect(devUlid()).not.toBe(devUlid());
  });
});
