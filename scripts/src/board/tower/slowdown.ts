// The slowdown ratio (F120, docs/ops/SESSION-BOARD.md → History → Slowdown): per heavy.sh class, the median wall time
// of the last 30 min's clean runs over the median of the 24 h before them, so a throttled Mac (battery, Low Power
// Mode, heat) or a crowded container shows as "test ×1.8" rather than as a vague feeling. One function for the tower
// and `board.sh status` (via `cli.ts machine`), so the two never disagree.
import type { Job } from './model.ts';

export const SLOW_CLASSES = ['typecheck', 'lint', 'test', 'ui'] as const; // lib.sh sb_classify; the rest are too mixed
export const SLOW_WINDOW_MIN = 30;
export const MIN_RECENT = 2;
export const MIN_BASE = 5;
export const SLOW_WARN = 1.5;
export const SLOW_BAD = 2;
const MIN = 60_000;
const HOUR = 60 * MIN;

export type SlowClass = {
  cls: string;
  recentSec: number | null;
  baseSec: number | null;
  ratio: number | null; // null: under MIN_RECENT recent or MIN_BASE baseline runs
  nRecent: number;
  nBase: number;
  base: '24h' | '7d' | null; // which baseline: 7 d when the 24 h one is thin
};
export type Slowdown = {
  windowMin: number;
  classes: SlowClass[];
  worst: { cls: string; ratio: number } | null;
  tone: 'ok' | 'warn' | 'bad';
  line: string; // slowdownLine: what board.sh status and the CONTAINER details print
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function slowdown(jobs: Job[], now: number): Slowdown {
  const from = now - SLOW_WINDOW_MIN * MIN;
  const clean = jobs.filter((j) => j.exit === 0 && !j.excluded && j.wallSec > 0 && j.t <= now);
  const classes = SLOW_CLASSES.map((cls): SlowClass => {
    const mine = clean.filter((j) => j.cls === cls);
    const recent = mine.filter((j) => j.t > from).map((j) => j.wallSec);
    const before = mine.filter((j) => j.t <= from);
    let base: SlowClass['base'] = '24h';
    let pool = before.filter((j) => j.t > from - 24 * HOUR).map((j) => j.wallSec);
    if (pool.length < MIN_BASE) {
      base = '7d';
      pool = before.filter((j) => j.t > from - 7 * 24 * HOUR).map((j) => j.wallSec);
    }
    const recentSec = median(recent);
    const baseSec = median(pool);
    const ok = recent.length >= MIN_RECENT && pool.length >= MIN_BASE && !!baseSec;
    return {
      cls,
      recentSec,
      baseSec,
      ratio: ok ? Math.round((recentSec! / baseSec!) * 10) / 10 : null,
      nRecent: recent.length,
      nBase: pool.length,
      base: pool.length >= MIN_BASE ? base : null,
    };
  });
  const rated = classes.filter((c) => c.ratio !== null);
  const top = rated.sort((a, b) => b.ratio! - a.ratio!)[0];
  const worst = top ? { cls: top.cls, ratio: top.ratio! } : null;
  const tone = !worst
    ? 'ok'
    : worst.ratio >= SLOW_BAD
      ? 'bad'
      : worst.ratio >= SLOW_WARN
        ? 'warn'
        : 'ok';
  const out = { windowMin: SLOW_WINDOW_MIN, classes, worst, tone } as Slowdown;
  out.line = slowdownLine(out);
  return out;
}

// "test ×1.8 (3/41) · typecheck ×1.1 (2/37) · lint – (1 recent) · ui – (0 recent)": counts are recent/baseline runs.
export function slowdownLine(s: Pick<Slowdown, 'classes'>): string {
  return s.classes
    .map((c) =>
      c.ratio !== null
        ? `${c.cls} ×${c.ratio.toFixed(1)} (${c.nRecent}/${c.nBase}${c.base === '7d' ? ' 7d' : ''})`
        : `${c.cls} – (${c.nRecent < MIN_RECENT ? `${c.nRecent} recent` : `${c.nBase} baseline`})`,
    )
    .join(' · ');
}
