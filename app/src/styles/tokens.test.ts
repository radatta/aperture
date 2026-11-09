import { describe, it, expect } from 'vitest';
import raw from './tokens.css?raw';

// tokens.css's contrast rule, measured (WCAG 2.x relative luminance), so it can't drift back: every text
// token clears 4.5:1 on all three grounds in both themes, and keeps it under the due fills as a filled row
// draws it (dueStyle.ts: subtle is lifted to muted, the accents re-pointed to their --*-on-fill shades).
const TEXT = ['ink', 'ink-muted', 'ink-subtle', 'teal', 'gold', 'danger'];
const GROUNDS = ['surface', 'panel', 'panel-2'];
const FILLS = ['due-imminent-fill', 'due-past-fill'];
// What each text token is drawn with on a filled row.
const ON_FILL: Record<string, string> = {
  ink: 'ink',
  'ink-muted': 'ink-muted',
  'ink-subtle': 'ink-muted',
  teal: 'teal-on-fill',
  gold: 'gold-on-fill',
  danger: 'danger-on-fill',
};
const AA = 4.5;

type Rgb = [number, number, number];

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}
const css = raw.replace(/\/\*[\s\S]*?\*\//g, ''); // a commented-out token never counts
const THEMES = {
  dark: block(":root[data-theme='dark']"),
  light: block(":root[data-theme='light']"),
};

function hex(v: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) throw new Error(`not a #rrggbb colour: ${v}`);
  return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as Rgb;
}

// An rgba() fill painted over an opaque ground, rounded to 8 bits as the browser composites it.
function over(fill: string, ground: Rgb): Rgb {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(fill);
  if (!m) throw new Error(`not an rgba() fill: ${fill}`);
  const a = Number(m[4]);
  return ground.map((g, i) => Math.round(Number(m[i + 1]) * a + g * (1 - a))) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(Object.entries(THEMES))('%s theme contrast', (_, vars) => {
  const color = (name: string) => hex(vars[name] ?? `missing --${name}`);

  it('every text token clears 4.5:1 on every ground', () => {
    const failing = TEXT.flatMap((t) =>
      GROUNDS.map((g) => ({ pair: `${t} on ${g}`, ratio: contrast(color(t), color(g)) })),
    ).filter((r) => r.ratio < AA);
    expect(failing).toEqual([]);
  });

  it('every text token, as a filled row draws it, clears 4.5:1 under the due fills', () => {
    expect(Object.keys(ON_FILL).sort()).toEqual([...TEXT].sort());
    const failing = TEXT.flatMap((t) =>
      GROUNDS.flatMap((g) =>
        FILLS.map((f) => ({
          pair: `${t} (as --${ON_FILL[t]}) on ${g} + ${f}`,
          ratio: contrast(color(ON_FILL[t]!), over(vars[f] ?? `missing --${f}`, color(g))),
        })),
      ),
    ).filter((r) => r.ratio < AA);
    expect(failing).toEqual([]);
  });

  it('keeps three text levels: ink > ink-muted > ink-subtle on every ground', () => {
    for (const g of GROUNDS) {
      const [ink, muted, subtle] = ['ink', 'ink-muted', 'ink-subtle'].map((t) =>
        contrast(color(t), color(g)),
      ) as [number, number, number];
      expect(ink).toBeGreaterThan(muted);
      expect(muted).toBeGreaterThan(subtle);
    }
  });
});

describe('the measure', () => {
  it('matches WCAG: black on white is 21:1, a colour on itself 1:1', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast(hex('#2f423c'), hex('#2f423c'))).toBe(1);
  });

  it('would catch the old 3:1 subtle', () => {
    expect(contrast(hex('#8c9d97'), hex('#3e5049'))).toBeLessThan(AA);
    expect(contrast(hex('#78877f'), hex('#e6ebe4'))).toBeLessThan(AA);
  });
});
