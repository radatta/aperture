import { describe, expect, it } from 'vitest';
import { ansiToSvg, parseCapture } from './svg.ts';

describe('svg', () => {
  const cap = '\x1b[38;2;191;97;106m\x1b[48;2;67;76;94mab\x1b[0m c\n\x1b[1mbold<&>\x1b[22m\n';
  it('reads truecolor SGR runs into cells', () => {
    const rows = parseCapture(cap);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.map((c) => c.ch).join('')).toBe('ab c');
    expect(rows[0]![0]).toEqual({ ch: 'a', fg: '#BF616A', bg: '#434C5E', bold: false });
    expect(rows[0]![2]!.bg).toBe('#0D2140'); // a reset is the terminal's own background
    expect(rows[1]![0]!.bold).toBe(true);
  });

  it('draws one rect + text per run, escaping markup', () => {
    const svg = ansiToSvg(cap);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('<rect x="0.0" y="0" width="16.8" height="17" fill="#434C5E"/>');
    expect(svg).toContain('fill="#BF616A"');
    expect(svg).toContain('bold&lt;&amp;&gt;');
    expect(svg).toContain('font-weight="bold"');
  });
});
