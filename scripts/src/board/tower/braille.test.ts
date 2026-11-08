import { describe, expect, it } from 'vitest';
import { strip } from './ansi.ts';
import { level, raster, rasterChars } from './braille.ts';

describe('braille', () => {
  it('maps a value to a dot height, showing any non-zero value', () => {
    expect([null, 0, 0.01, 5, 10, 99].map((v) => level(v, 10, 8))).toEqual([0, 0, 1, 4, 8, 8]);
  });

  it('fills columns from the bottom: left dots 1,2,3,7 and right dots 4,5,6,8', () => {
    // one row, 4 dot levels: left full, right one dot
    expect(rasterChars([4, 1], 1, 1, 4)).toEqual([String.fromCharCode(0x2800 + 0x47 + 0x80)]);
    expect(rasterChars([4, 4], 1, 1, 4)).toEqual(['⣿']);
    expect(rasterChars([null, null], 1, 1, 4)).toEqual(['⠀']);
  });

  it('spreads a tall value over the rows, top row first', () => {
    expect(rasterChars([8, 2], 1, 2, 8)).toEqual([
      String.fromCharCode(0x2800 + 0x47),
      String.fromCharCode(0x2800 + 0x47 + 0x20 + 0x80),
    ]);
    expect(rasterChars([2, 2], 1, 2, 8)).toEqual([
      '⠀',
      String.fromCharCode(0x2800 + 0x44 + 0x80 + 0x20),
    ]);
  });

  it('colours a cell past a band and highlights the cursor cell', () => {
    const rows = raster([1, 1, 9, 9], 2, 1, 10, '#000001', [{ at: 8, color: '#BF616A' }], 1);
    expect(strip(rows[0]!)).toHaveLength(2);
    expect(rows[0]).toContain('\x1b[38;2;191;97;106m'); // red for the cell at 9
    expect(rows[0]).toContain('\x1b[48;2;59;74;102m'); // the cursor's background
  });
});
