import { describe, expect, it } from 'vitest';
import { Screen, decodeKeys } from './screen.ts';

describe('decodeKeys', () => {
  it('reads letters, digits, arrows and escape', () => {
    expect(decodeKeys('q')).toEqual(['quit']);
    expect(decodeKeys('\x03')).toEqual(['quit']);
    expect(decodeKeys('162')).toEqual(['1h', '6h', '24h']);
    expect(decodeKeys('\x1b[D\x1b[D\x1bOC')).toEqual(['left', 'left', 'right']);
    expect(decodeKeys('\x1b')).toEqual(['live']);
    expect(decodeKeys('\x1b[F\x1b[Hr')).toEqual(['live', 'oldest', 'refresh']);
    expect(decodeKeys('\x1b[Ax')).toEqual([]); // up arrow and unknown keys do nothing
  });
});

describe('Screen', () => {
  it('rewrites only changed rows, cursor-addressed, never clearing', () => {
    const out: string[] = [];
    const s = new Screen({ write: (x: string) => out.push(x) });
    s.enter();
    expect(out[0]).toContain('\x1b[?1049h');
    expect(s.draw(['a', 'b', 'c'])).toBe(3);
    out.length = 0;
    expect(s.draw(['a', 'B', 'c'])).toBe(1);
    expect(out.join('')).toContain('\x1b[2;1HB');
    expect(out.join('')).not.toContain('\x1b[2J');
    expect(out.join('')).not.toContain('\x1b[K'); // it would erase a full row's last cell
    expect(s.draw(['a', 'B', 'c'])).toBe(0);
    s.invalidate();
    expect(s.draw(['a', 'B', 'c'])).toBe(3);
  });

  it('restores once', () => {
    const out: string[] = [];
    const s = new Screen({ write: (x: string) => out.push(x) });
    s.restore();
    expect(out).toEqual([]);
    s.enter();
    s.restore();
    s.restore();
    expect(out.filter((x) => x.includes('\x1b[?1049l'))).toHaveLength(1);
    expect(out.at(-1)).toContain('\x1b[?25h');
  });
});
