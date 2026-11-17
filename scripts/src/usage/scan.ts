// `pnpm usage scan`: read new transcript bytes into the cache, one file at a time, rate-limited, resuming each file
// from where the last run stopped. Discovery is readdir + stat only; nothing but *.jsonl and their *.meta.json is
// ever opened. Never point this at anything but the projects root (docs/ops/USAGE-METER.md → Scan).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileRef, type FileRef } from './lanes.ts';
import {
  readIndex,
  readShard,
  writeIndex,
  writeShard,
  type IndexEntry,
  type SessionRec,
} from './store.ts';
import { lines, type ReadStats } from './throttle.ts';
import { CallMerger, parseLine, wanted, type Marker } from './transcript.ts';

export interface Found {
  rel: string;
  ref: FileRef;
  size: number;
  mtimeMs: number;
  ino: number;
}

const ls = (p: string) => {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
};

// Every transcript under root: <project>/<sid>.jsonl, …/subagents/agent-*.jsonl, …/subagents/workflows/wf_*/agent-*.jsonl.
export function discover(root: string): Found[] {
  const rels: string[] = [];
  for (const p of ls(root).filter((d) => d.isDirectory())) {
    for (const e of ls(join(root, p.name))) {
      if (e.isFile() && e.name.endsWith('.jsonl')) rels.push(`${p.name}/${e.name}`);
      if (!e.isDirectory()) continue;
      const sub = `${p.name}/${e.name}/subagents`;
      for (const a of ls(join(root, sub))) {
        if (a.isFile() && a.name.endsWith('.jsonl')) rels.push(`${sub}/${a.name}`);
        if (a.isDirectory() && a.name === 'workflows')
          for (const w of ls(join(root, sub, 'workflows')).filter((d) => d.isDirectory()))
            for (const f of ls(join(root, sub, 'workflows', w.name)))
              if (f.isFile() && f.name.endsWith('.jsonl'))
                rels.push(`${sub}/workflows/${w.name}/${f.name}`);
      }
    }
  }
  return rels.flatMap((rel) => {
    const ref = fileRef(rel);
    if (!ref) return [];
    try {
      const st = statSync(join(root, rel));
      return [{ rel, ref, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }];
    } catch {
      return [];
    }
  });
}

export type Plan = { action: 'skip' } | { action: 'resume'; from: number } | { action: 'full' };

// What to do with a file given its index entry: unchanged → skip; grown, same inode → resume from the offset;
// shrunk or replaced → full rescan.
export function planFile(f: Found, prev: IndexEntry | undefined): Plan {
  if (!prev) return { action: 'full' };
  if (prev.ino !== f.ino || f.size < prev.offset) return { action: 'full' };
  if (f.size === prev.size && f.mtimeMs === prev.mtimeMs) return { action: 'skip' };
  return f.size > prev.offset ? { action: 'resume', from: prev.offset } : { action: 'skip' };
}

const safe = (s: unknown) =>
  typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _:-]{0,63}$/.test(s) ? s : undefined;

function meta(root: string, rel: string) {
  try {
    const m = JSON.parse(readFileSync(join(root, rel.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
    return { agentType: safe(m.agentType), workflowPhase: safe(m.workflowPhase) };
  } catch {
    return {};
  }
}

const markerKey = (m: Marker) =>
  `${m.ts}|${m.kind}|${m.phase ?? ''}|${m.cls ?? ''}|${m.toolUseId ?? ''}|${m.lane ?? ''}`;

export interface ScanOpts {
  root: string;
  cache: string;
  maxBps: number;
  // Waits while the container's anon memory is high; called before each big file.
  memoryOk?: () => boolean;
  bigFile?: number;
  waitMs?: number;
  log?: (s: string) => void;
}
export interface ScanResult {
  files: number;
  scanned: number;
  bytes: number;
  calls: number;
  skippedLines: number;
}

export async function scan(o: ScanOpts): Promise<ScanResult> {
  const ix = readIndex(o.cache);
  const found = discover(o.root).sort((a, b) => a.size - b.size);
  const res: ScanResult = { files: found.length, scanned: 0, bytes: 0, calls: 0, skippedLines: 0 };
  for (const f of found) {
    const plan = planFile(f, ix.files[f.rel]);
    if (plan.action === 'skip') continue;
    if (f.size > (o.bigFile ?? 100e6) && o.memoryOk) {
      let tries = 0;
      while (!o.memoryOk()) {
        if (++tries > 10) throw new Error(`memory stayed high; stopped before ${f.rel}`);
        o.log?.(`memory high; waiting before ${f.rel}`);
        await sleep(o.waitMs ?? 30_000);
      }
    }
    const old = plan.action === 'resume' ? readShard(o.cache, f.rel) : null;
    const from = old ? (plan as { from: number }).from : 0;
    const s: SessionRec = old?.s ?? {
      rel: f.rel,
      project: f.ref.project,
      sid: f.ref.sid,
      agentId: f.ref.agentId,
      kind: f.ref.kind,
      ...(f.ref.kind === 'main' ? {} : meta(o.root, f.rel)),
    };
    const merger = new CallMerger();
    for (const c of old?.calls ?? []) merger.add(c);
    const markers: Marker[] = [...(old?.markers ?? [])];
    // a crash between the shard and index writes resumes over bytes already read: keep each marker once
    const seen = new Set(markers.map(markerKey));
    const st: ReadStats = { bytes: 0, skipped: 0, done: from };
    for await (const { line } of lines(
      join(o.root, f.rel),
      { start: from, end: f.size, maxBps: o.maxBps },
      st,
    )) {
      if (!wanted(line)) continue;
      const p = parseLine(line);
      if (!p) continue;
      if (p.name) s.name = p.name;
      if (p.cwd && !s.cwd) s.cwd = p.cwd;
      if (p.call) merger.add(p.call);
      for (const m of p.markers) {
        const k = markerKey(m);
        if (seen.has(k)) continue;
        seen.add(k);
        markers.push(m);
      }
    }
    writeShard(o.cache, { s, calls: [...merger.calls.values()], markers });
    ix.files[f.rel] = {
      size: f.size,
      mtimeMs: f.mtimeMs,
      ino: f.ino,
      offset: st.done,
      skipped: (old ? (ix.files[f.rel]?.skipped ?? 0) : 0) + st.skipped,
    };
    writeIndex(o.cache, ix);
    res.scanned++;
    res.bytes += st.bytes;
    res.calls += merger.calls.size;
    res.skippedLines += st.skipped;
  }
  return res;
}

// The container's anon memory, from the cgroup (board/cli.ts reads the same file).
export function anonBytes(cgroupDir: string): number | null {
  const p = join(cgroupDir, 'memory.stat');
  if (!existsSync(p)) return null;
  const m = /^anon (\d+)$/m.exec(readFileSync(p, 'utf8'));
  return m ? Number(m[1]) : null;
}
