// Where each panel goes for a terminal size. Two arrangements (wide ≥ 160 cols, narrow ≥ 95), each a stack
// of horizontal bands; the last band (activity + tiles) takes what's left, and when the rows run short the
// other bands give up height down to their minimums.

export type PanelId =
  'header' | 'queue' | 'rahul' | 'wave' | 'history' | 'sessions' | 'failures' | 'feed' | 'tiles';
export type Rect = { x: number; y: number; w: number; h: number };
export type Layout = { mode: 'wide' | 'narrow' | 'small'; rects: Partial<Record<PanelId, Rect>> };

// Content lines each list panel would like (the panel adds its 2 border rows).
export type Wants = { queue: number; rahul: number; wave: number; sessions: number };

export const WIDE_COLS = 160;
export const NARROW_COLS = 95;
export const MIN_ROWS = 24;
const FEED_MIN = 4;

type Cell = { id: PanelId; w: number | 'rest' };
type Band = { h: number; min: number; cells: Cell[] };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function layout(cols: number, rows: number, want: Wants): Layout {
  if (cols < NARROW_COLS || rows < MIN_ROWS)
    return { mode: 'small', rects: { header: { x: 0, y: 0, w: cols, h: Math.min(rows, 2) } } };
  const wide = cols >= WIDE_COLS && rows >= 40;
  const bands: Band[] = [];
  if (wide) {
    const top = clamp(Math.max(want.queue, want.rahul, want.wave) + 2, 5, 16);
    bands.push({
      h: top,
      min: 5,
      cells: [
        { id: 'queue', w: Math.round(cols * 0.36) },
        { id: 'rahul', w: Math.round(cols * 0.28) },
        { id: 'wave', w: 'rest' },
      ],
    });
    const side = Math.max(52, Math.round(cols * 0.32));
    bands.push({
      h: clamp(want.sessions + 2, 16, 20),
      min: 11,
      cells: [
        { id: 'history', w: cols - side },
        { id: 'sessions', w: 'rest' },
      ],
    });
  } else {
    const top = clamp(Math.max(want.queue, want.rahul) + 2, 4, 8);
    bands.push({
      h: top,
      min: 4,
      cells: [
        { id: 'queue', w: Math.round(cols * 0.56) },
        { id: 'rahul', w: 'rest' },
      ],
    });
    bands.push({ h: clamp(want.wave + 2, 3, 14), min: 3, cells: [{ id: 'wave', w: cols }] });
    bands.push({ h: 11, min: 8, cells: [{ id: 'history', w: cols }] });
    bands.push({
      h: clamp(want.sessions + 2, 7, 10),
      min: 7,
      cells: [
        { id: 'sessions', w: Math.round(cols * 0.55) },
        { id: 'failures', w: 'rest' },
      ],
    });
  }
  const tilesW = wide ? 52 : 40; // wide: the failures table sits on top of the tiles
  const FAIL_H = 7;
  const head = 2;
  // shrink the tallest shrinkable band until the feed gets its minimum
  let spare = rows - head - bands.reduce((s, b) => s + b.h, 0);
  while (spare < FEED_MIN) {
    const b = bands.filter((x) => x.h > x.min).sort((a, z) => z.h - z.min - (a.h - a.min))[0];
    if (!b) break;
    b.h--;
    spare++;
  }
  const rects: Layout['rects'] = { header: { x: 0, y: 0, w: cols, h: head } };
  let y = head;
  for (const b of bands) {
    let x = 0;
    for (const cell of b.cells) {
      const w = cell.w === 'rest' ? cols - x : cell.w;
      rects[cell.id] = { x, y, w, h: b.h };
      x += w;
    }
    y += b.h;
  }
  const feedH = Math.max(0, rows - y);
  if (feedH > 0) {
    rects.feed = { x: 0, y, w: cols - tilesW, h: feedH };
    const fh = wide && feedH >= FAIL_H + 3 ? FAIL_H : 0;
    if (fh) rects.failures = { x: cols - tilesW, y, w: tilesW, h: fh };
    rects.tiles = { x: cols - tilesW, y: y + fh, w: tilesW, h: feedH - fh };
  }
  return { mode: wide ? 'wide' : 'narrow', rects };
}
