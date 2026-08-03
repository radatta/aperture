import { describe, it, expect } from 'vitest';
import { createUlid, ulid, isUlid } from './ulid';

describe('ulid', () => {
  it('is 26 valid Crockford-base32 chars', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it('is monotonic and unique within the same millisecond', () => {
    const gen = createUlid(() => 1_700_000_000_000); // pinned clock → all same ms
    const ids = Array.from({ length: 1000 }, () => gen());
    expect(ids).toEqual([...ids].sort()); // creation order === lexical order
    expect(new Set(ids).size).toBe(ids.length); // no collisions
  });

  it('advances with the clock', () => {
    let t = 1_700_000_000_000;
    const gen = createUlid(() => t);
    const a = gen();
    t += 1;
    expect(gen() > a).toBe(true);
  });

  it('never goes backwards even if the clock rewinds', () => {
    let t = 1_700_000_000_000;
    const gen = createUlid(() => t);
    const a = gen();
    t -= 10_000;
    expect(gen() > a).toBe(true);
  });

  it('rejects non-ulids', () => {
    expect(isUlid('nope')).toBe(false);
    expect(isUlid('ILOU00000000000000000000000')).toBe(false); // excluded letters
  });
});
