import { describe, expect, it } from 'vitest';
import { NEETCODE_150, PATTERNS, PATTERN_NAMES } from './neetcode150';

// The catalog is kept by hand: this pins its shape, so a bad edit fails here rather than as a 404 on a tap.
describe('NEETCODE_150', () => {
  it('has 150 problems with unique, well-formed slugs', () => {
    expect(NEETCODE_150).toHaveLength(150);
    expect(new Set(NEETCODE_150.map((p) => p.slug)).size).toBe(150);
    for (const p of NEETCODE_150) expect(p.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it('every row has a title, a known difficulty and a roadmap pattern', () => {
    for (const p of NEETCODE_150) {
      expect(p.title.trim()).not.toBe('');
      expect(['Easy', 'Medium', 'Hard']).toContain(p.difficulty);
      expect(PATTERNS).toContain(p.pattern);
    }
  });
  it('every pattern has problems, in roadmap order, and a name', () => {
    const order = [...new Set(NEETCODE_150.map((p) => p.pattern))];
    expect(order).toEqual([...PATTERNS]);
    for (const p of PATTERNS) {
      expect(PATTERN_NAMES[p]).toBeTruthy();
      expect(NEETCODE_150.some((c) => c.pattern === p && !c.premium)).toBe(true);
    }
  });
});
