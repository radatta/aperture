// The pace gate `lanes start` runs before it makes anything: the hub's pace watcher (scripts/board/pace-watch.sh)
// writes pace.json to the board dir each minute, and a start waits for calm, the CPU (cores, PSI), anon and
// memory-PSI readings under their limits, a fresh and warmed-up file, and the spacing since the last start
// (docs/ops/LANES.md → Start → The pace gate). A
// missing, stale or unreadable file fails closed: a dead watcher is the silent failure the gate exists for, and
// --over-pace always goes past it.
import type { Deps, Env } from './state.ts';

export type PaceLimits = {
  coresBelow: number;
  psiCpuBelow: number;
  anonMiBBelow: number;
  psiMemFullMax: number; // the watcher's own memory trip (> 1): it exits with pace.json still calm
  minSamples: number; // the watcher's own floor: below it the "average" is a minute or two
  spacingSec: number;
  staleSec: number;
};
// The maintainer's rule (2026-11-17), plus the watcher's memory trip; load5 isn't judged: it counts I/O-waiting
// tasks here and sat >= 12 in a third of calm samples. scripts/board/limits.json `pace` overrides each field.
export const PACE_DEFAULTS: PaceLimits = {
  coresBelow: 7.5,
  psiCpuBelow: 40,
  anonMiBBelow: 9000,
  psiMemFullMax: 1,
  minSamples: 3,
  spacingSec: 120,
  staleSec: 180,
};
// 5 by default: a wait and the install after it must fit a caller's 600 s tool call; longer waits run in the background.
export const WAIT_DEFAULT_MIN = 5;
export const WAIT_MAX_MIN = 30;
export const WAIT_POLL_MS = 30_000;
const FUTURE_SKEW_SEC = 60; // a heartbeat further ahead than this is not the watcher's

export const paceFile = (e: Env) => `${e.boardDir}/pace.json`;
// The hub's own state file: a trip lands here at once, while the exiting watcher's last pace.json still says calm.
export const paceControlFile = (e: Env) => `${e.boardDir}/pace-control.json`;
export const lastStartFile = (e: Env) => `${e.boardDir}/lane-last-start.json`;
export const lastStartText = (b: string, nowMs: number) =>
  JSON.stringify({ v: 1, at: Math.floor(nowMs / 1000), branch: b }) + '\n';

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const parse = (s: string | null): unknown => {
  try {
    return s === null ? null : JSON.parse(s);
  } catch {
    return undefined;
  }
};

export function paceLimits(d: Deps): PaceLimits {
  const l = parse(d.fs.read(`${d.env.mainRoot}/scripts/board/limits.json`)) as {
    pace?: Partial<Record<keyof PaceLimits, unknown>>;
  } | null;
  const p = l && typeof l === 'object' && l.pace && typeof l.pace === 'object' ? l.pace : {};
  const out = { ...PACE_DEFAULTS };
  for (const k of Object.keys(out) as (keyof PaceLimits)[]) {
    const v = p[k];
    if (num(v) && (v > 0 || (k === 'psiMemFullMax' && v === 0))) out[k] = v; // 0: any memory stall refuses
  }
  return out;
}

// Each reason a start must wait, keyed so a wait logs only when the set changes; [] is clear.
export function paceReasons(
  pace: string | null,
  control: string | null,
  last: string | null,
  nowMs: number,
  lim: PaceLimits,
  boardDir: string,
): { key: string; text: string }[] {
  const now = nowMs / 1000;
  const restart = 'restart scripts/board/pace-watch.sh (docs/ops/HUB.md → Watchers)';
  const out: { key: string; text: string }[] = [];
  const p = parse(pace) as Record<string, unknown> | null | undefined;
  const avg = p && typeof p === 'object' ? (p.avg as Record<string, unknown> | undefined) : null;
  if (pace === null)
    out.push({
      key: 'missing',
      text: `no pace.json in ${boardDir}: the watcher is not running, ${restart}`,
    });
  else if (!p || typeof p !== 'object' || Array.isArray(p))
    out.push({
      key: 'unreadable',
      text: `pace.json is unreadable (not a JSON object): ${restart}`,
    });
  else if (
    !num(p.heartbeat) ||
    typeof p.state !== 'string' ||
    !num(p.samples) ||
    !num(p.psiMemFull) ||
    !num(avg?.cores) ||
    !num(avg?.psiCpu) ||
    !num(avg?.anonMiB)
  )
    out.push({
      key: 'unreadable',
      text: `pace.json is unreadable (heartbeat, state, samples, psiMemFull or an avg field missing or not a number): ${restart}`,
    });
  else if (p.heartbeat - now > FUTURE_SKEW_SEC)
    out.push({
      key: 'unreadable',
      text: `pace.json is unreadable (heartbeat ${Math.round(p.heartbeat - now)} s in the future): ${restart}`,
    });
  else if (now - p.heartbeat > lim.staleSec)
    out.push({
      key: 'stale',
      text: `pace.json is ${Math.round(now - p.heartbeat)} s old (over ${lim.staleSec}): the watcher is not running, ${restart}`,
    });
  else if (p.samples < lim.minSamples)
    out.push({
      key: 'warming',
      text: `the watcher has ${p.samples} of ${lim.minSamples} samples (restarted under ${lim.minSamples} min ago)`,
    });
  else {
    if (p.state !== 'calm')
      out.push({
        key: 'state',
        text: `the container is ${p.state} (pace.json state "${p.state}")`,
      });
    const { cores, psiCpu, anonMiB: anon } = avg as Record<'cores' | 'psiCpu' | 'anonMiB', number>;
    if (cores >= lim.coresBelow)
      out.push({ key: 'cores', text: `cores avg ${cores}, wants under ${lim.coresBelow}` });
    if (psiCpu >= lim.psiCpuBelow)
      out.push({ key: 'psiCpu', text: `CPU PSI avg ${psiCpu}, wants under ${lim.psiCpuBelow}` });
    if (anon >= lim.anonMiBBelow)
      out.push({
        key: 'anon',
        text: `anon avg ${Math.round(anon)} MiB, wants under ${lim.anonMiBBelow}`,
      });
    if (p.psiMemFull > lim.psiMemFullMax)
      out.push({
        key: 'psiMem',
        text: `memory PSI full ${p.psiMemFull}, wants at most ${lim.psiMemFullMax}`,
      });
  }
  // An absent control file is no signal (pace.json still judges); one that is there must read, or a hot mark caught
  // mid-write would pass as calm.
  const c = parse(control) as { state?: unknown } | null | undefined;
  if (control !== null && (!c || typeof c !== 'object' || typeof c.state !== 'string'))
    out.push({
      key: 'control',
      text: `pace-control.json is unreadable (no string state): the hub rewrites it`,
    });
  else if (c && typeof c === 'object' && c.state !== 'calm')
    out.push({
      key: 'control',
      text: `the hub marked the box ${String(c.state)} (pace-control.json)`,
    });
  // A junk or future stamp is ignored: spacing must never block for good.
  const s = parse(last) as { at?: unknown; branch?: unknown } | null | undefined;
  if (s && typeof s === 'object' && num(s.at)) {
    const ago = now - s.at;
    if (ago >= 0 && ago < lim.spacingSec)
      out.push({
        key: 'spacing',
        text: `lane ${typeof s.branch === 'string' ? s.branch : '?'} started ${Math.floor(ago)} s ago, wants ${lim.spacingSec} s between starts`,
      });
  }
  return out;
}

const reasonsNow = (d: Deps) =>
  paceReasons(
    d.fs.read(paceFile(d.env)),
    d.fs.read(paceControlFile(d.env)),
    d.fs.read(lastStartFile(d.env)),
    d.clock.now(),
    paceLimits(d),
    d.env.boardDir,
  );

// Why a start must wait now, or null when the pace is clear.
export function paceBlock(d: Deps): string | null {
  const r = reasonsNow(d);
  return r.length ? r.map((x) => x.text).join('; ') : null;
}

// `--wait[=<min>]`: null when absent, whole minutes 1..WAIT_MAX_MIN, else 'bad' (a swallowed branch name too).
export function parseWait(raw: string | null): number | null | 'bad' {
  if (raw === null) return null;
  if (raw === 'true') return WAIT_DEFAULT_MIN;
  if (!/^\d+$/.test(raw)) return 'bad';
  const n = Number(raw);
  return n >= 1 && n <= WAIT_MAX_MIN ? n : 'bad';
}

// Polls until the pace clears (null) or the clock reaches `until` (the last reason). Logs once per change of reasons;
// `min` is the whole wait, for the log.
export async function waitForPace(d: Deps, until: number, min: number): Promise<string | null> {
  let said = '';
  for (;;) {
    const r = reasonsNow(d);
    if (!r.length) return null;
    const text = r.map((x) => x.text).join('; ');
    const keys = r.map((x) => x.key).join(',');
    if (keys !== said) d.log(`pace: ${text}; waiting (up to ${min} min)`);
    said = keys;
    const left = until - d.clock.now();
    if (left <= 0) return text;
    await d.clock.sleep(Math.min(WAIT_POLL_MS, left));
  }
}
