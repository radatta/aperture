// The slowdown ratio (F120, docs/ops/SESSION-BOARD.md → History → Slowdown): per heavy.sh class, the median wall time
// of the last 30 min's clean runs over the median of the 24 h before them, so a throttled Mac (battery, Low Power
// Mode, heat) or a crowded container shows as "test ×1.8" rather than as a vague feeling. One function for the tower
// and `board.sh status` (via `cli.ts machine`), so the two never disagree. The gate's outer runs (gate-narrow,
// gate-wide) are classes of their own, each against its own baseline; a class with no clean run for SLOW_STALE_MS
// says since when instead of a dash (F293), and `short` is the status line's cut (board.line → statusline-board.sh).
import type { Job } from './model.ts';

// lib.sh sb_classify, plus the gate's (heavy.sh HEAVY_CLASS): its eslint step, which runs beside tsc in either gate,
// and its outer runs. The rest are too mixed. gate-typecheck stays out: tsc cache hits make it bimodal like plain
// typecheck (p10 0.8 s, p90 47 s), and gate-lint already speaks for the gate
export const SLOW_CLASSES = [
  'typecheck',
  'lint',
  'test',
  'ui',
  'gate-lint',
  'gate-narrow',
  'gate-wide',
] as const;
export const SLOW_WINDOW_MIN = 30;
// gate-lint because lanes rarely run plain typecheck or lint since the gate; the outer gates follow the diff's size
const HEADLINE = new Set(['typecheck', 'lint', 'gate-lint']);
export const MIN_RECENT = 2;
export const MIN_BASE = 5;
export const SLOW_WARN = 1.5;
export const SLOW_BAD = 2;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const HHMM_MS = 20 * HOUR;
export const SLOW_STALE_MS = 2 * HOUR;
const LOOKBACK_D = 7; // the job history both loaders read (source.ts JOB_DAYS, cli.ts machine)
const SHORT: Record<string, string> = {
  typecheck: 'tc',
  lint: 'lint',
  'gate-lint': 'gl',
  'gate-narrow': 'gn',
  'gate-wide': 'gw',
};

export type SlowClass = {
  cls: string;
  recentSec: number | null;
  baseSec: number | null;
  ratio: number | null; // null: under MIN_RECENT recent or MIN_BASE baseline runs
  nRecent: number;
  nBase: number;
  base: '24h' | '7d' | null; // which baseline: 7 d when the 24 h one is thin
  lastAt: number | null; // the newest clean run in the loaded history
  stale: boolean; // no clean run for over SLOW_STALE_MS
};
export type Slowdown = {
  windowMin: number;
  classes: SlowClass[];
  worst: { cls: string; ratio: number } | null;
  tone: 'ok' | 'warn' | 'bad';
  line: string; // slowdownLine: what board.sh status and the CONTAINER details print
  short: string; // slowdownShort: the status line's segment
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function slowdown(jobs: Job[], now: number, hm: (t: number) => string): Slowdown {
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
    const lastAt = mine.length ? Math.max(...mine.map((j) => j.t)) : null;
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
      lastAt,
      stale: lastAt === null || now - lastAt > SLOW_STALE_MS,
    };
  });
  // the headline (tile colour, "slow ×…") from the clean signals only: test mixes suites with filtered runs, ui dev
  // checks with captures, and a gate's wall time follows its diff; all still show in the line
  const rated = classes.filter((c) => c.ratio !== null && HEADLINE.has(c.cls));
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
  out.line = slowdownLine(out, now, hm);
  out.short = slowdownShort(out, now, hm);
  return out;
}

// "no data since 22:58" under 20 h: an HH:MM near a day old would read as the current minute, so then hours, then days
const noData = (lastAt: number | null, now: number, hm: (t: number) => string) => {
  if (lastAt === null) return `no data in ${LOOKBACK_D} d`;
  const age = now - lastAt;
  if (age < HHMM_MS) return `no data since ${hm(lastAt)}`;
  return age < 2 * DAY
    ? `no data in ${Math.floor(age / HOUR)} h`
    : `no data in ${Math.floor(age / DAY)} d`;
};

// "test ×1.8 (3/41) · typecheck ×1.1 (2/37) · lint – (1 recent) · ui – (no data since 14:02)": counts are
// recent/baseline runs.
export function slowdownLine(
  s: Pick<Slowdown, 'classes'>,
  now: number,
  hm: (t: number) => string,
): string {
  return s.classes
    .map((c) =>
      c.ratio !== null
        ? `${c.cls} ×${c.ratio.toFixed(1)} (${c.nRecent}/${c.nBase}${c.base === '7d' ? ' 7d' : ''})`
        : c.stale
          ? `${c.cls} – (${noData(c.lastAt, now, hm)})`
          : `${c.cls} – (${c.nRecent < MIN_RECENT ? `${c.nRecent} recent` : `${c.nBase} baseline`})`,
    )
    .join(' · ');
}

// The status line's cut, typecheck, lint and the gate classes: "slow 30m tc×1.2 lint– gl×1.0 gw×1.1 · gn no data
// since 19:02".
// Stale classes share one tail at the newest of their last runs, which is true of each.
export function slowdownShort(
  s: Pick<Slowdown, 'classes'>,
  now: number,
  hm: (t: number) => string,
): string {
  const cs = s.classes.filter((c) => Object.hasOwn(SHORT, c.cls));
  const live = cs.filter((c) => !c.stale);
  const stale = cs.filter((c) => c.stale);
  const dated = stale.map((c) => c.lastAt).filter((t) => t !== null);
  const since = noData(dated.length ? Math.max(...dated) : null, now, hm);
  if (!live.length) return `slow: ${since}`;
  const head = `slow ${SLOW_WINDOW_MIN}m ${live.map((c) => `${SHORT[c.cls]}${c.ratio === null ? '–' : `×${c.ratio.toFixed(1)}`}`).join(' ')}`;
  return stale.length ? `${head} · ${stale.map((c) => SHORT[c.cls]).join(', ')} ${since}` : head;
}
