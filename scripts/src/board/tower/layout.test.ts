import { describe, expect, it } from 'vitest';
import { HISTORY_H, layout, type Rect } from './layout.ts';

const want = { queue: 4, rahul: 2, wave: 6, plan: 4, sessions: 12 };
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
        'plan',
        'queue',
        'rahul',
        'sessions',
        'tiles',
        'wave',
      ]);
  });

  it('splits the wide top band in thirds that fill the width', () => {
    for (const cols of [160, 185, 210]) {
      const { queue, rahul, wave } = layout(cols, 55, want).rects;
      expect(queue!.w + rahul!.w + wave!.w).toBe(cols);
      expect(Math.max(queue!.w, rahul!.w, wave!.w) - Math.min(queue!.w, rahul!.w, wave!.w)).toBe(
        cols % 3 === 0 ? 0 : 1,
      );
    }
  });

  it("sizes the middle band to MACHINE's height, growing only for a long session list", () => {
    expect(layout(210, 55, { ...want, sessions: 6 }).rects.history!.h).toBe(HISTORY_H);
    expect(layout(210, 55, { ...want, sessions: 13 }).rects.history!.h).toBe(HISTORY_H);
    expect(layout(210, 55, { ...want, sessions: 16 }).rects.sessions!.h).toBe(18);
    expect(layout(210, 55, { ...want, sessions: 30 }).rects.history!.h).toBe(20);
  });

  it('wide: PLAN | ACTIVITY | tiles at the bottom; narrow: PLAN beside WAVE', () => {
    const w = layout(185, 52, want).rects;
    expect(w.plan).toMatchObject({ x: 0, y: w.feed!.y, w: 48, h: w.feed!.h });
    expect(w.feed!.x).toBe(48);
    expect(w.feed!.w).toBe(185 - 48 - 52);
    expect(layout(160, 40, want).rects.plan!.w).toBe(44);
    const n = layout(100, 50, want).rects;
    expect(n.plan).toMatchObject({ x: n.wave!.w, y: n.wave!.y, h: n.wave!.h, w: 100 - n.wave!.w });
    expect(n.wave!.w).toBe(n.queue!.w);
  });

  it('shows only the header below 95×24', () => {
    expect(layout(80, 24, want)).toEqual({
      mode: 'small',
      rects: { header: { x: 0, y: 0, w: 80, h: 2 } },
    });
    expect(layout(120, 20, want).mode).toBe('small');
  });
});
