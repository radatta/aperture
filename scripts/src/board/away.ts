// The hub's /away, /back and /hs (docs/ops/HUB.md → Shortcuts): `pnpm board away` stamps when the maintainer left,
// `board back` prints what moved since from what the board already records (merge events, lane starts, lane phase
// changes, asks, the usage row) and clears the stamp, and `board stop <HH:MM>` writes the hard-stop time to
// stop.json, which pace-watch.sh turns into exit 12 ahead of it. Pure; the CLI reads and writes the files.
import { countdown, hhmm, pad2 } from './tower/fmt.ts';
import type { LaneFile } from './tower/lanes.ts';
import type { Ask } from './tower/queue.ts';

export const AWAY_FILE = 'away.json';
export const AWAY_LAST = 'away-last.json'; // the last stamp, kept after /back
export const AWAY_STALE_MS = 18 * 3600e3; // a stamp older than this had no /back: the next /away starts fresh
export const STOP_LEAD_SEC = 600; // pace-watch.sh's STOP_LEAD: exit 12 this long before the stop, so lanes stop clean by it

type Fmt = (t: number) => string;
export type Stamp = { v: 1; at: string; ping: boolean; usage: string | null };

export const awayStamp = (now: number, ping: boolean, usage: string | null): Stamp => ({
  v: 1,
  at: new Date(now).toISOString(),
  ping,
  usage,
});

export function readStamp(text: string | null): Stamp | null {
  if (text === null) return null;
  try {
    const s = JSON.parse(text) as Partial<Stamp>;
    if (typeof s.at !== 'string' || !(Date.parse(s.at) > 0)) return null;
    return {
      v: 1,
      at: s.at,
      ping: s.ping === true,
      usage: typeof s.usage === 'string' ? s.usage : null,
    };
  } catch {
    return null;
  }
}

// board.line's usage row (`usage <epoch> <text>`) → `<text> (HH:MM)`, or null.
export function usageRow(boardLine: string | null, f: Fmt = hhmm): string | null {
  const l = (boardLine ?? '').split('\n').find((x) => x.startsWith('usage '));
  const m = l ? /^usage (\d+) (.+)$/.exec(l) : null;
  if (!m) return null;
  return `${m[2]!.replace(/^usage:?\s*/i, '').trim()} (${f(+m[1]! * 1000)})`;
}

export type Merged = { pr: number; sha: string; mergedAt: string; title: string };
export type Started = { branch: string; startedAt: string };
export type BackInputs = {
  stamp: Stamp;
  now: number;
  merged: Merged[]; // history/events-*.jsonl `merged` rows, any order, may repeat
  started: Started[]; // lifecycle/<branch>.json
  lanes: LaneFile[];
  asks: Ask[] | string; // open; or why queue.json couldn't be read
  usageNow: string | null;
};

const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60e3));
  return m >= 60 ? `${Math.floor(m / 60)}h${pad2(m % 60)}m` : `${m}m`;
};
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g; // a control byte becomes a space: board text never moves a cursor
const one = (s: string, max = 60) => {
  const t = s.replace(CTRL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const section = (name: string, items: string[]) =>
  items.length ? `${name} ${items.length} · ${items.join(' · ')}` : `${name} none`;

export function backDigest(b: BackInputs, f: Fmt = hhmm): string {
  const since = Date.parse(b.stamp.at);
  const seen = new Set<string>();
  const merged = b.merged
    .filter((m) => Date.parse(m.mergedAt) >= since && !seen.has(m.sha) && seen.add(m.sha))
    .sort((x, y) => Date.parse(x.mergedAt) - Date.parse(y.mergedAt))
    .map((m) => `PR ${m.pr} "${one(m.title, 50)}" ${f(Date.parse(m.mergedAt))}`);
  const started = b.started
    .filter((s) => Date.parse(s.startedAt) >= since)
    .sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt))
    .map((s) => `${s.branch} ${f(Date.parse(s.startedAt))}`);
  const moved = b.lanes
    .filter((l) => l.phaseSince !== null && l.phaseSince >= since)
    .sort((x, y) => x.phaseSince! - y.phaseSince!)
    .map((l) => `${l.branch} → ${l.phase} ${f(l.phaseSince!)}`);
  const asks =
    typeof b.asks === 'string'
      ? `ASKS unknown (${b.asks})`
      : b.asks.length
        ? `ASKS ${b.asks.length} open (${b.asks.filter((a) => a.asked !== null && a.asked >= since).length} new)`
        : 'ASKS none open';
  return [
    `BACK ${f(b.now)} · away since ${f(since)} (${dur(b.now - since)})`,
    section('MERGED', merged),
    section('STARTED', started),
    section('MOVED', moved),
    asks,
    `USAGE then ${b.stamp.usage ?? 'unknown'} · now ${b.usageNow ?? 'unknown'}`,
    "deploys: not recorded on the board (the brief's LANES, the tower's DONE TODAY)",
  ].join('\n');
}

// `HH:MM` → the next such local time (today, or tomorrow once it has passed), as whole epoch seconds.
export function stopAt(hm: string, now: number): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hm);
  if (!m) throw new Error(`stop: want HH:MM (24 h) or off, got ${JSON.stringify(hm)}`);
  const d = new Date(now);
  d.setHours(+m[1]!, +m[2]!, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}

// A stop under STOP_LEAD away fires on pace-watch's next tick, so it says so rather than name a time already past.
export const stopLine = (at: number, now: number, f: Fmt = hhmm) =>
  `STOP ${f(at * 1000)} hard · in ${countdown(at * 1000, now)} · ${
    at * 1000 - now <= STOP_LEAD_SEC * 1000
      ? 'pace-watch exits 12 on its next tick (under 10 min away)'
      : `pace-watch exits 12 at ${f((at - STOP_LEAD_SEC) * 1000)}`
  }: lanes work until ${f((at - 60) * 1000)}, then stop clean`;

// stop.json, the hard stop's own file: only `board stop` writes it and pace-watch reads it, so a hand rewrite of
// pace-control.json (the hub's calm/hot state) can never drop a stop. `off` writes a null stopAt.
export const STOP_FILE = 'stop.json';
export const stopFile = (at: number | null, now: number) =>
  JSON.stringify({ v: 1, stopAt: at, setAt: new Date(now).toISOString() }) + '\n';
