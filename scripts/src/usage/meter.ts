// The account's weekly meter from the status-line log, plus the sparse manual readings → points → fit intervals.
// Each session's rate_limits comes from its own last API response, so an idle session keeps logging a stale value.
// A reading counts only on a row where that session's % or cost moved (fresh), and the account meter is the newest
// change across sessions — never an average. docs/ops/USAGE-METER.md → Meter.

export interface MeterRow {
  ts: number;
  sid: string;
  name: string | null;
  cost: number | null;
  pct: number | null;
  resetsAt: number | null; // epoch s
}
export interface Reading {
  ts: number;
  pct: number;
  resetsAt: number | null;
  sid: string;
}
export interface Point {
  ts: number;
  p: number;
  r: number; // rounding variance of this reading (≈0 for a live tick, 1/12 for a manual reading, 0 for a reset)
  src: 'tick' | 'manual' | 'reset';
}
export interface Interval {
  t0: number;
  t1: number;
  dP: number;
  r: number; // r0 + r1
  src: string; // e.g. tick→tick, manual→manual
}
export interface Manual {
  readings: { at: string; pct: number; approx?: boolean }[]; // at: ISO with offset
  resets: string[];
}

export function parseMeter(text: string): { rows: MeterRow[]; bad: number } {
  const rows: MeterRow[] = [];
  let bad = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      const ts = Date.parse(r.ts);
      const w = r.rl?.seven_day;
      if (!Number.isFinite(ts) || typeof r.sid !== 'string') throw new Error('row');
      rows.push({
        ts,
        sid: r.sid,
        name: typeof r.name === 'string' ? r.name : null,
        cost: typeof r.cost === 'number' ? r.cost : null,
        pct: typeof w?.used_percentage === 'number' ? w.used_percentage : null,
        resetsAt: typeof w?.resets_at === 'number' ? w.resets_at : null,
      });
    } catch {
      bad++;
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, bad };
}

// Rows where the session's reading or cost moved since its previous row. A session's first row never counts: it
// can carry a value from long before.
export function freshReadings(rows: MeterRow[]): Reading[] {
  const last = new Map<string, MeterRow>();
  const out: Reading[] = [];
  for (const r of rows) {
    const prev = last.get(r.sid);
    if (r.pct === null) continue;
    last.set(r.sid, r);
    if (!prev) continue;
    if (r.pct !== prev.pct || (r.cost ?? 0) !== (prev.cost ?? 0))
      out.push({ ts: r.ts, pct: r.pct, resetsAt: r.resetsAt, sid: r.sid });
  }
  return out;
}

export const RESET_DROP = 10;
const HOUR_S = 3600;

// Fresh readings → per-window tick points: tick n is the first time the envelope (running max) reaches n. A new
// window starts when resets_at moves by over an hour, or a reading falls RESET_DROP below the envelope (a manual
// reset may leave resets_at alone); readings still carrying the old resets_at after the switch are ignored. A
// smaller drop is a stale straggler, counted.
export function ticks(readings: Reading[]): { windows: Point[][]; stragglers: number } {
  const windows: Point[][] = [];
  let cur: Point[] = [];
  let env = -1;
  let resetsAt: number | null = null;
  const old = new Set<number>();
  let stragglers = 0;
  for (const r of readings) {
    if (r.resetsAt !== null && [...old].some((o) => Math.abs(o - r.resetsAt!) <= HOUR_S)) continue;
    const moved =
      resetsAt !== null && r.resetsAt !== null && Math.abs(r.resetsAt - resetsAt) > HOUR_S;
    const dropped = env >= 0 && r.pct <= env - RESET_DROP;
    if (moved || dropped || env < 0) {
      if ((moved || dropped) && resetsAt !== null && r.resetsAt !== resetsAt) old.add(resetsAt);
      if (cur.length) windows.push(cur);
      cur = [];
      env = -1;
    }
    resetsAt = r.resetsAt ?? resetsAt;
    if (r.pct < env) stragglers++;
    else if (r.pct > env) {
      // a window's first reading sits somewhere inside its integer: manual-grade, not a tick
      cur.push(
        env < 0
          ? { ts: r.ts, p: r.pct, r: 1 / 12, src: 'manual' }
          : { ts: r.ts, p: r.pct, r: 0, src: 'tick' },
      );
      env = r.pct;
    }
  }
  if (cur.length) windows.push(cur);
  return { windows, stragglers };
}

// Manual readings and resets → points, split into windows at each reset (a reset is a known zero).
export function manualWindows(m: Manual): Point[][] {
  const pts: Point[] = [
    ...m.readings.map((x) => ({
      ts: Date.parse(x.at),
      p: x.pct,
      r: x.approx ? 1 / 3 : 1 / 12,
      src: 'manual' as const,
    })),
    ...m.resets.map((at) => ({ ts: Date.parse(at), p: 0, r: 0, src: 'reset' as const })),
  ]
    .filter((p) => Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);
  const out: Point[][] = [];
  let cur: Point[] = [];
  for (const p of pts) {
    if (p.src === 'reset') {
      if (cur.length) out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Greedy intervals within a window: close at the first point at least minDp points and minMin minutes on.
export function intervals(window: Point[], minDp = 3, minMin = 10): Interval[] {
  const out: Interval[] = [];
  let a = window[0];
  for (const b of window.slice(1)) {
    if (!a) break;
    if (b.p - a.p >= minDp && b.ts - a.ts >= minMin * 60_000) {
      out.push({ t0: a.ts, t1: b.ts, dP: b.p - a.p, r: a.r + b.r, src: `${a.src}→${b.src}` });
      a = b;
    }
  }
  return out;
}

// Positive cost increments per session, stamped at the later row: the log's own ΔQU, a stand-in before the
// transcript calls exist and a cross-check after. A cost that fell means the session restarted: re-baseline.
export function costDeltas(rows: MeterRow[]): { ts: number; sid: string; d: number }[] {
  const last = new Map<string, number>();
  const out: { ts: number; sid: string; d: number }[] = [];
  for (const r of rows) {
    if (r.cost === null) continue;
    const prev = last.get(r.sid);
    last.set(r.sid, r.cost);
    if (prev !== undefined && r.cost > prev) out.push({ ts: r.ts, sid: r.sid, d: r.cost - prev });
  }
  return out;
}

// Burn over the ticks of the trailing hour, or the last 3 ticks when the hour has fewer than 2.
export function burn(
  window: Point[],
  now: number,
): { pct: number; at: number; perHour: number | null; since: number } | null {
  const last = window.at(-1);
  if (!last) return null;
  const t = window.filter((p) => p.src === 'tick');
  const recent = t.filter((p) => p.ts >= now - 3_600_000);
  const span = recent.length >= 2 ? recent : t.slice(-3);
  const [a, b] = [span[0], span.at(-1)];
  if (!a || !b || a === b) return { pct: last.p, at: last.ts, perHour: null, since: last.ts };
  return {
    pct: last.p,
    at: last.ts,
    perHour: (b.p - a.p) / ((b.ts - a.ts) / 3_600_000),
    since: a.ts,
  };
}
