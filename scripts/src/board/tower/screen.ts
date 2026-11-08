// The terminal: alternate screen, hidden cursor, a per-row diff writer (only changed rows are rewritten,
// cursor-addressed, so there is no clear and no flicker), raw-mode keys, and an idempotent restore.
// Rows are always the full width (compose() pads them), so a rewrite covers the old row.
import { BASE } from './ansi.ts';

export type Key = 'quit' | '1h' | '6h' | '24h' | 'left' | 'right' | 'live' | 'oldest' | 'refresh';

// Keys in one stdin chunk (a held arrow can deliver several).
export function decodeKeys(s: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < s.length;) {
    const rest = s.slice(i);
    const seq: [string, Key][] = [
      ['\x1b[D', 'left'],
      ['\x1bOD', 'left'],
      ['\x1b[C', 'right'],
      ['\x1bOC', 'right'],
      ['\x1b[H', 'oldest'],
      ['\x1b[F', 'live'],
    ];
    const hit = seq.find(([p]) => rest.startsWith(p));
    if (hit) {
      out.push(hit[1]);
      i += hit[0].length;
      continue;
    }
    const ch = s[i]!;
    i++;
    if (ch === '\x1b') {
      if (s[i] === 'O') i += 2;
      else if (s[i] === '[') {
        // an unknown CSI (F10 is ESC [ 2 1 ~): skip through its final byte, 0x40–0x7E
        i++;
        while (i < s.length && !(s.charCodeAt(i) >= 0x40 && s.charCodeAt(i) <= 0x7e)) i++;
        i++;
      } else out.push('live');
    } else if (ch === 'q' || ch === 'Q' || ch === '\x03') out.push('quit');
    else if (ch === '1') out.push('1h');
    else if (ch === '6') out.push('6h');
    else if (ch === '2') out.push('24h');
    else if (ch === 'h') out.push('left');
    else if (ch === 'l') out.push('right');
    else if (ch === 'r') out.push('refresh');
  }
  return out;
}

export type Out = { write: (s: string) => unknown };

export class Screen {
  private prev: string[] = [];
  private on = false;
  private out: Out;
  constructor(out: Out) {
    this.out = out;
  }

  enter() {
    if (this.on) return;
    this.on = true;
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[?7l' + BASE + '\x1b[2J');
  }

  // Rewrites only the rows that changed; `invalidate` first after a resize.
  draw(lines: string[]): number {
    let buf = '';
    let n = 0;
    lines.forEach((l, i) => {
      if (this.prev[i] === l) return;
      // no CSI K: a full-width row leaves the cursor on its last cell, and K would erase that cell
      buf += `\x1b[${i + 1};1H${l}`;
      n++;
    });
    if (buf) this.out.write('\x1b[?2026h' + buf + '\x1b[?2026l'); // synchronized update where supported
    this.prev = lines;
    return n;
  }

  invalidate() {
    this.prev = [];
    if (this.on) this.out.write(BASE + '\x1b[2J');
  }

  restore() {
    if (!this.on) return;
    this.on = false;
    this.out.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
  }
}
