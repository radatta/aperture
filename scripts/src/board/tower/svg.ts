// A `tmux capture-pane -e -p` capture (SGR truecolor) → SVG, so a proof frame opens anywhere. Cells are a
// fixed grid; runs of one style become one <rect> + <text>.
import { NORD } from './ansi.ts';

const CW = 8.4; // cell width at font-size 14 (DejaVu Sans Mono)
const CH = 17;

type Cell = { ch: string; fg: string; bg: string; bold: boolean };

const hex = (r: number, g: number, b: number) =>
  '#' +
  [r, g, b]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function parseCapture(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let fg: string = NORD.fg;
  let bg: string = NORD.bg;
  let bold = false;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const row: Cell[] = [];
    // eslint-disable-next-line no-control-regex
    for (const part of line.split(/(\x1b\[[0-9;:]*[a-zA-Z])/)) {
      if (part.startsWith('\x1b[')) {
        if (!part.endsWith('m')) continue;
        const p = part.slice(2, -1).split(/[;:]/).map(Number);
        for (let i = 0; i < p.length; i++) {
          const k = p[i] || 0;
          if (k === 0) [fg, bg, bold] = [NORD.fg, NORD.bg, false];
          else if (k === 1) bold = true;
          else if (k === 22) bold = false;
          else if (k === 39) fg = NORD.fg;
          else if (k === 49) bg = NORD.bg;
          else if ((k === 38 || k === 48) && p[i + 1] === 2) {
            const col = hex(p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0);
            if (k === 38) fg = col;
            else bg = col;
            i += 4;
          }
        }
        continue;
      }
      for (const ch of part) row.push({ ch, fg, bg, bold });
    }
    rows.push(row);
  }
  return rows;
}

export function ansiToSvg(text: string): string {
  const rows = parseCapture(text);
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(cols * CW)}" height="${rows.length * CH}" font-family="DejaVu Sans Mono, Menlo, monospace" font-size="14">`,
    `<rect width="100%" height="100%" fill="${NORD.bg}"/>`,
  ];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const a = row[x]!;
      let e = x + 1;
      while (
        e < row.length &&
        row[e]!.fg === a.fg &&
        row[e]!.bg === a.bg &&
        row[e]!.bold === a.bold
      )
        e++;
      const run = row
        .slice(x, e)
        .map((c) => c.ch)
        .join('');
      if (a.bg !== NORD.bg)
        out.push(
          `<rect x="${(x * CW).toFixed(1)}" y="${y * CH}" width="${((e - x) * CW).toFixed(1)}" height="${CH}" fill="${a.bg}"/>`,
        );
      if (run.trim())
        out.push(
          `<text x="${(x * CW).toFixed(1)}" y="${y * CH + 13}" fill="${a.fg}"${a.bold ? ' font-weight="bold"' : ''} textLength="${((e - x) * CW).toFixed(1)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(run)}</text>`,
        );
      x = e;
    }
  });
  out.push('</svg>');
  return out.join('\n');
}
