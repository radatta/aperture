// HEALTH's two file sources (docs/ops/TOWER.md → HEALTH): the Mac stats agent's JSON and the AWS cost pull.
// Each reader returns a value with its age and a state; missing, unreadable and stale are states, never blanks.
import { readFileSync, statSync } from 'node:fs';
import { clean, parseTime } from './fmt.ts';

export type Fresh = 'ok' | 'stale' | 'silent' | 'missing' | 'bad';

export type MacStats = {
  t: number;
  host: string;
  memTotalMiB: number;
  mem: {
    freeMiB: number;
    activeMiB: number;
    inactiveMiB: number;
    wiredMiB: number;
    compressedMiB: number;
    usedMiB: number;
    freePct: number | null;
    pressure: string;
  };
  swap: { totalMiB: number; usedMiB: number };
  load: number[];
  cpus: number;
  vm: { pid: number; comm: string; rssMiB: number } | null;
  agentVersion: string | null;
};
export type MacRead = { state: Fresh; at: number | null; error: string | null; stats: MacStats | null };

export const MAC_STALE_SEC = 60; // four missed 15 s ticks
export const MAC_SILENT_SEC = 300;

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const need = (x: unknown, k: string) => {
  const n = num(x);
  if (n === null) throw new Error(`${k} is not a number`);
  return n;
};

export function parseMacStats(text: string): MacStats {
  const r = JSON.parse(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!r || r.v !== 1) throw new Error(`v is ${JSON.stringify(r?.v)}, want 1`);
  const t = parseTime(r.t);
  if (t === null) throw new Error('t is not an ISO time');
  const m = r.mem ?? {};
  const vm = r.vm && typeof r.vm === 'object' ? r.vm : null;
  return {
    t,
    host: typeof r.host === 'string' ? clean(r.host) : '?',
    memTotalMiB: need(r.memTotalMiB, 'memTotalMiB'),
    mem: {
      freeMiB: need(m.freeMiB, 'mem.freeMiB'),
      activeMiB: need(m.activeMiB, 'mem.activeMiB'),
      inactiveMiB: need(m.inactiveMiB, 'mem.inactiveMiB'),
      wiredMiB: need(m.wiredMiB, 'mem.wiredMiB'),
      compressedMiB: need(m.compressedMiB, 'mem.compressedMiB'),
      usedMiB: need(m.usedMiB, 'mem.usedMiB'),
      freePct: num(m.freePct),
      pressure: typeof m.pressure === 'string' ? clean(m.pressure) : '?',
    },
    swap: { totalMiB: num(r.swap?.totalMiB) ?? 0, usedMiB: num(r.swap?.usedMiB) ?? 0 },
    load: Array.isArray(r.load) ? r.load.map(num).filter((x: number | null) => x !== null) : [],
    cpus: num(r.cpus) ?? 0,
    vm: vm && num(vm.rssMiB) !== null
      ? { pid: num(vm.pid) ?? 0, comm: typeof vm.comm === 'string' ? clean(vm.comm) : '?', rssMiB: vm.rssMiB }
      : null,
    agentVersion: typeof r.agentVersion === 'string' ? clean(r.agentVersion).slice(0, 64) : null,
  };
}

export function readMacStats(path: string, now: number, read = (p: string) => readFileSync(p, 'utf8')): MacRead {
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return { state: missing ? 'missing' : 'bad', at: null, error: missing ? null : clean((e as Error).message), stats: null };
  }
  let stats: MacStats;
  try {
    stats = parseMacStats(text);
  } catch (e) {
    return { state: 'bad', at: null, error: clean((e as Error).message).slice(0, 120), stats: null };
  }
  const sec = (now - stats.t) / 1000;
  const state: Fresh = sec > MAC_SILENT_SEC ? 'silent' : sec > MAC_STALE_SEC ? 'stale' : 'ok';
  return { state, at: stats.t, error: null, stats };
}

// AWS month-to-date from localNotes/costs-daily.json: `aws ce get-cost-and-usage --granularity DAILY --group-by
// LINKED_ACCOUNT,SERVICE`, re-pulled by Rahul on request. Its "as of" is the file's mtime; it covers only through
// its last day, which the page shows too.
export const AWS_ACCOUNTS = { '618015769091': 'dev', '594060113104': 'prod' } as const;
export const COSTS_STALE_SEC = 3 * 86400;
export type Costs = {
  state: Fresh;
  at: number | null; // mtime
  error: string | null;
  month: string;
  through: string | null; // the last day with data, YYYY-MM-DD
  total: number;
  byAccount: Record<string, number>; // dev / prod / other
};

export function sumCosts(text: string, month: string): Omit<Costs, 'state' | 'at' | 'error'> {
  const r = JSON.parse(text.replace(/^﻿/, '')) as { ResultsByTime?: unknown };
  if (!r || !Array.isArray(r.ResultsByTime)) throw new Error('no ResultsByTime');
  const byAccount: Record<string, number> = {};
  let total = 0;
  let through: string | null = null;
  for (const day of r.ResultsByTime as { TimePeriod?: { Start?: string }; Groups?: unknown }[]) {
    const start = day?.TimePeriod?.Start;
    if (typeof start !== 'string' || !start.startsWith(`${month}-`)) continue;
    if (!through || start > through) through = start;
    for (const g of (Array.isArray(day.Groups) ? day.Groups : []) as { Keys?: string[]; Metrics?: any }[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const amt = Number(g?.Metrics?.UnblendedCost?.Amount);
      if (!Number.isFinite(amt)) continue;
      const acct = (AWS_ACCOUNTS as Record<string, string>)[g.Keys?.[0] ?? ''] ?? 'other';
      byAccount[acct] = (byAccount[acct] ?? 0) + amt;
      total += amt;
    }
  }
  return { month, through, total, byAccount };
}

export function readCosts(path: string, now: number, month: string): Costs {
  const empty = { month, through: null, total: 0, byAccount: {} };
  let mtime: number;
  let text: string;
  try {
    mtime = statSync(path).mtimeMs;
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return { ...empty, state: missing ? 'missing' : 'bad', at: null, error: missing ? null : clean((e as Error).message) };
  }
  try {
    const c = sumCosts(text, month);
    return { ...c, state: (now - mtime) / 1000 > COSTS_STALE_SEC ? 'stale' : 'ok', at: mtime, error: null };
  } catch (e) {
    return { ...empty, state: 'bad', at: mtime, error: clean((e as Error).message).slice(0, 120) };
  }
}
