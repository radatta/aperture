import { describe, expect, it } from 'vitest';
import { layout, type Rect } from './layout.ts';

const want = { queue: 4, rahul: 2, wave: 6, sessions: 12 };
const cells = (r: Rect) => {
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push(`${x},${y}`);
  return out;
};

function tiles(cols: number, rows: number) {
  const l = layout(cols, rows, want);
  const all = Object.values(l.rects).flatMap(cells);
  return { l, all, unique: new Set(all) };
}

describe('layout', () => {
  it.each([
    [210, 55, 'wide'],
    [160, 40, 'wide'],
    [100, 50, 'narrow'],
    [95, 30, 'narrow'],
    [200, 35, 'narrow'],
  ])('%ix%i is %s and tiles the screen with no overlap', (cols, rows, mode) => {
    const { l, all, unique } = tiles(cols, rows);
    expect(l.mode).toBe(mode);
    expect(all.length).toBe(unique.size); // no overlap
    expect(unique.size).toBe(cols * rows); // no hole
    for (const r of Object.values(l.rects))
      expect(r.x + r.w <= cols && r.y + r.h <= rows).toBe(true);
    expect(l.rects.feed!.h).toBeGreaterThanOrEqual(4);
  });

  it('puts every panel somewhere in both arrangements', () => {
    for (const [c, r] of [
      [210, 55],
      [100, 50],
    ])
      expect(Object.keys(layout(c!, r!, want).rects).sort()).toEqual([
        'failures',
        'feed',
        'header',
        'history',
        'queue',
        'rahul',
        'sessions',
        'tiles',
        'wave',
      ]);
  });

  it('shows only the header below 95×24', () => {
    expect(layout(80, 24, want)).toEqual({
      mode: 'small',
      rects: { header: { x: 0, y: 0, w: 80, h: 2 } },
    });
    expect(layout(120, 20, want).mode).toBe('small');
  });
});
