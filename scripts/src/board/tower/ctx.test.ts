import { describe, expect, it } from 'vitest';
import { ctxOf, ctxView, parseCtx } from './ctx.ts';

describe('ctx.json (F240)', () => {
  it('reads name and pct; a bad entry is skipped, a bad file is none', () => {
    const t = JSON.stringify([
      { name: 'a', ts: '17:33', tokens: 1, pct: 78.3 },
      { name: '', pct: 50 },
      { name: 'b', pct: 'x' },
      { name: 'c', pct: 41 },
    ]);
    expect(parseCtx(t, 5)).toEqual({
      at: 5,
      list: [
        { name: 'a', pct: 78.3 },
        { name: 'c', pct: 41 },
      ],
    });
    expect(parseCtx('{', 5)).toBeNull();
    expect(parseCtx('{}', 5)).toBeNull();
    expect(parseCtx(null, 5)).toBeNull();
  });
  it('splits at 40 and 50, highest first; stale counts nothing', () => {
    const c = {
      at: 0,
      list: [
        { name: 'a', pct: 40 },
        { name: 'b', pct: 49.9 },
        { name: 'c', pct: 50 },
        { name: 'd', pct: 39.9 },
      ],
    };
    expect(ctxView(c, 60e3)).toEqual({
      at: 0,
      stale: false,
      warn: [
        { name: 'b', pct: 49.9 },
        { name: 'a', pct: 40 },
      ],
      bad: [{ name: 'c', pct: 50 }],
    });
    expect(ctxView(c, 6 * 60e3)).toMatchObject({ stale: true, warn: [], bad: [] });
    expect(ctxOf(c, 'c', 60e3)).toBe(50);
    expect(ctxOf(c, 'c', 6 * 60e3)).toBeNull();
    expect(ctxOf(c, 'zz', 60e3)).toBeNull();
  });
});
