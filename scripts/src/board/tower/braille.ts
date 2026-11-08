// Braille area charts: each cell holds 2×4 dots, so a chart of `cols` cells takes 2·cols values and draws
// rows·4 levels. Dot bits (U+2800 + mask): left column top→bottom 0,1,2,6 · right column 3,4,5,7.
import { BG_DEFAULT, NORD, bgc, fgc } from './ansi.ts';

const LEFT = [0x01, 0x02, 0x04, 0x40];
const RIGHT = [0x08, 0x10, 0x20, 0x80];

// The chart's dot height for a value: any non-zero value shows at least one dot.
export function level(v: number | null, max: number, dots: number): number {
  if (v === null || !(max > 0) || v <= 0) return 0;
  return Math.max(1, Math.min(dots, Math.round((v / max) * dots)));
}

export type Band = { at: number; color: string }; // values ≥ at draw in color (soft/hard lines)

// Rows of plain braille characters for `values` (length 2·cols), top row first.
export function rasterChars(
  values: (number | null)[],
  cols: number,
  rows: number,
  max: number,
): string[] {
  const dots = rows * 4;
  const lv = values.map((v) => level(v, max, dots));
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    const base = (rows - 1 - r) * 4; // dots below this row
    for (let x = 0; x < cols; x++) {
      let m = 0;
      for (let d = 0; d < 4; d++) {
        const need = base + (4 - d); // dot d (from the top) of this row is lit when the level reaches it
        if ((lv[2 * x] ?? 0) >= need) m |= LEFT[d]!;
        if ((lv[2 * x + 1] ?? 0) >= need) m |= RIGHT[d]!;
      }
      line += String.fromCharCode(0x2800 + m);
    }
    out.push(line);
  }
  return out;
}

// The coloured chart: each cell takes the band colour of its larger value; `cursor` is a highlighted cell.
export function raster(
  values: (number | null)[],
  cols: number,
  rows: number,
  max: number,
  color: string,
  bands: Band[] = [],
  cursor: number | null = null,
): string[] {
  const chars = rasterChars(values, cols, rows, max);
  const cellColor = (x: number) => {
    const v = Math.max(values[2 * x] ?? 0, values[2 * x + 1] ?? 0);
    let col = color;
    for (const b of bands) if (v >= b.at) col = b.color;
    return col;
  };
  return chars.map((line) => {
    let out = '';
    let cur = '';
    [...line].forEach((ch, x) => {
      const col = cellColor(x);
      const sel = x === cursor;
      const key = col + (sel ? 's' : '');
      if (key !== cur) {
        out += fgc(col) + (sel ? bgc(NORD.sel) : BG_DEFAULT);
        cur = key;
      }
      out += ch;
    });
    return out + BG_DEFAULT + fgc(NORD.fg);
  });
}
