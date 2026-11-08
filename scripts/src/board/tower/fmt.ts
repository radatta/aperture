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
