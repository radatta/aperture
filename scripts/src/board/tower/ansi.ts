// Nord truecolor, matching tools/coi/tmux.conf. Every row starts on BASE and no style ever emits a full
// reset, so every gap keeps the Nord background. BASE also ends bold, so a style cut by fit() never leaks.
import type { Tone } from './model.ts';

export const NORD = {
  bg: '#2E3440',
  panel: '#3B4252',
  sel: '#434C5E',
  dim: '#4C566A',
  fg: '#D8DEE9',
  bright: '#ECEFF4',
  accent: '#88C0D0',
  blue: '#5E81AC',
  frost: '#81A1C1',
  amber: '#EBCB8B',
  red: '#BF616A',
  green: '#A3BE8C',
  purple: '#B48EAD',
  orange: '#D08770',
} as const;

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
export const fgc = (hex: string) => `\x1b[38;2;${rgb(hex)}m`;
export const bgc = (hex: string) => `\x1b[48;2;${rgb(hex)}m`;
export const BASE = '\x1b[22m' + bgc(NORD.bg) + fgc(NORD.fg);

export type Style = { fg?: string; bg?: string; bold?: boolean };

// text in a style, then back to the base colours
export function paint(text: string, s: Style): string {
  if (!text) return '';
  const on = (s.fg ? fgc(s.fg) : '') + (s.bg ? bgc(s.bg) : '') + (s.bold ? '\x1b[1m' : '');
  const off = (s.bold ? '\x1b[22m' : '') + (s.bg ? bgc(NORD.bg) : '') + (s.fg ? fgc(NORD.fg) : '');
  return on + text + off;
}

export const c = (hex: string, text: string, bold = false) => paint(text, { fg: hex, bold });

export const TONE: Record<Tone, string> = {
  normal: NORD.fg,
  dim: NORD.dim,
  good: NORD.green,
  warn: NORD.amber,
  bad: NORD.red,
};
export const tone = (t: Tone, text: string) => c(TONE[t], text);

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;
export const strip = (s: string) => s.replace(SGR, '');

// Every glyph the tower draws is one column wide (no emoji, no CJK), so width = code points.
export const width = (s: string) => [...strip(s)].length;

// Cut to `w` visible columns, keeping escapes whole; `…` marks a cut.
export function fit(s: string, w: number): string {
  if (w <= 0) return '';
  if (width(s) <= w) return s + ' '.repeat(w - width(s));
  let out = '';
  let n = 0;
  // eslint-disable-next-line no-control-regex
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (n === w - 1) return out + '…' + BASE;
      out += ch;
      n++;
    }
  }
  return out;
}

// left and right parts on one line of width w; the left one is cut first
export function spread(left: string, right: string, w: number): string {
  const rw = width(right);
  if (rw >= w) return fit(right, w);
  return fit(left, w - rw - 1) + ' ' + right;
}

// right-aligned in w columns (escape-aware)
export const rpad = (s: string, w: number) => ' '.repeat(Math.max(0, w - width(s))) + s;
