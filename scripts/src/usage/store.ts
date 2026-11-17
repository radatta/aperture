// The usage cache under <usage dir>/cache/: one shard per transcript file (its session record, deduped calls and
// markers) plus index.json saying how far each file was read. Atomic writes (tmp + rename), so an interrupted scan
// leaves every shard whole. Loading dedupes calls globally: a forked session can repeat a message in another file.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Kind } from './lanes.ts';
import { priceCall, type PriceFlag } from './prices.ts';
import type { Call, Marker } from './transcript.ts';

export interface SessionRec {
  rel: string; // path under the projects root
  project: string;
  sid: string;
  agentId?: string;
  kind: Kind;
  agentType?: string;
  workflowPhase?: string;
  name?: string;
  cwd?: string;
}
export interface Shard {
  s: SessionRec;
  calls: Call[];
  markers: Marker[];
}
export interface PricedCall extends Call {
  qu: number;
  flags: PriceFlag[];
  file: string; // the owning shard's rel
}
export interface IndexEntry {
  size: number;
  mtimeMs: number;
  ino: number;
  offset: number;
  skipped: number;
}
export interface Index {
  v: 1;
  parser: number;
  files: Record<string, IndexEntry>;
}

// Bump when transcript.ts extracts something new or different: the next scan rereads every file.
export const PARSER = 5;

export function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export const shardPath = (cache: string, rel: string) =>
  join(cache, 'shards', `${rel.replace(/\.jsonl$/, '').replace(/\//g, '__')}.jsonl`);

export function writeShard(cache: string, sh: Shard) {
  const rows = [
    JSON.stringify({ k: 's', ...sh.s }),
    ...sh.calls.map((c) => JSON.stringify({ k: 'c', ...c })),
    ...sh.markers.map((m) => JSON.stringify({ k: 'm', ...m })),
  ];
  writeAtomic(shardPath(cache, sh.s.rel), `${rows.join('\n')}\n`);
}

export function parseShard(text: string): Shard | null {
  let s: SessionRec | null = null;
  const calls: Call[] = [];
  const markers: Marker[] = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    const { k, ...r } = JSON.parse(l);
    if (k === 's') s = r as SessionRec;
    else if (k === 'c') calls.push(r as Call);
    else if (k === 'm') markers.push(r as Marker);
  }
  return s && { s, calls, markers };
}

export const readShard = (cache: string, rel: string) => {
  const p = shardPath(cache, rel);
  return existsSync(p) ? parseShard(readFileSync(p, 'utf8')) : null;
};

export function readIndex(cache: string): Index {
  try {
    const ix = JSON.parse(readFileSync(join(cache, 'index.json'), 'utf8'));
    if (ix?.v === 1 && ix.parser === PARSER && ix.files) return ix;
  } catch {
    // missing or torn: rescan
  }
  return { v: 1, parser: PARSER, files: {} };
}
export const writeIndex = (cache: string, ix: Index) =>
  writeAtomic(join(cache, 'index.json'), JSON.stringify(ix));

export interface Loaded {
  sessions: SessionRec[];
  calls: PricedCall[];
  markers: Map<string, Marker[]>; // by rel
  dupes: number;
}

// A call seen in two files belongs to the more specific one (a subagent's own file over its parent's), then the
// earlier sighting.
const rank = (k: Kind) => (k === 'main' ? 1 : 0);

export function loadShards(shards: Shard[]): Loaded {
  const best = new Map<string, { c: Call; s: SessionRec; first: number }>();
  let dupes = 0;
  const markers = new Map<string, Marker[]>();
  for (const sh of shards) {
    markers.set(sh.s.rel, sh.markers);
    // a fork copies the original's rows with their timestamps; the original is the file that started first
    const first = Math.min(...sh.calls.map((c) => c.ts));
    for (const c of sh.calls) {
      const prev = best.get(c.id);
      if (!prev) {
        best.set(c.id, { c, s: sh.s, first });
        continue;
      }
      dupes++;
      const [r, pr] = [rank(sh.s.kind), rank(prev.s.kind)];
      const better =
        r < pr || (r === pr && (c.ts < prev.c.ts || (c.ts === prev.c.ts && first < prev.first)));
      if (better) best.set(c.id, { c, s: sh.s, first });
    }
  }
  const calls = [...best.values()]
    .map(({ c, s }) => ({ ...c, ...priceCall(c.model, c, c), file: s.rel }))
    .sort((a, b) => a.ts - b.ts);
  return { sessions: shards.map((s) => s.s), calls, markers, dupes };
}

export function loadCache(cache: string): Loaded {
  const dir = join(cache, 'shards');
  const shards = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .flatMap((f) => parseShard(readFileSync(join(dir, f), 'utf8')) ?? [])
    : [];
  return loadShards(shards);
}
