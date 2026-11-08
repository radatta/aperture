// Small formatters shared by the panels. Times are local, like `board.sh status`.

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function hhmmss(ms: number): string {
  const d = new Date(ms);
  return `${hhmm(ms)}:${pad2(d.getSeconds())}`;
}

// 4.9G from MiB
export const gib = (mib: number) => `${(mib / 1024).toFixed(1)}G`;

// Signed whole minutes until `ms`: 35m · 1h05m · -3m
export function countdown(ms: number, now: number): string {
  const m = Math.round((ms - now) / 60000);
  const a = Math.abs(m);
  const s = a >= 60 ? `${Math.floor(a / 60)}h${pad2(a % 60)}m` : `${a}m`;
  return m < 0 ? `-${s}` : s;
}

// 45s · 12m · 3h · 2d
export function age(sec: number): string {
  if (sec < 90) return `${Math.max(0, Math.round(sec))}s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)}m`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export function wall(sec: number): string {
  if (sec < 100) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  return `${Math.floor(sec / 60)}m${pad2(Math.round(sec % 60))}s`;
}

export function parseTime(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Text from outside the tower (queue.json, gh, session and branch names, logs) as one-column glyphs: control
// characters dropped (a newline or ESC would move the cursor mid-row), tabs as spaces, zero-width marks
// removed, and double-width glyphs (CJK, emoji) as "?" so every row stays exactly the terminal's width.
// Text-style symbols that are Extended_Pictographic but narrow (© ® ™ ‼ ↔) stay.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;
const ZERO = /[\p{M}\p{Cf}]/gu; // combining marks, variation selectors, zero-width and bidi format characters
const WIDE =
  /(?![\u00a9\u00ae\u203c\u2049\u2122\u2139\u2194-\u2199])[\p{Extended_Pictographic}\u1100-\u115f\u2600-\u27bf\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]/gu;
export const clean = (s: string) =>
  s.replace(/\t/g, ' ').replace(CONTROL, '').replace(ZERO, '').replace(WIDE, '?');
