// HEALTH's two file sources (docs/ops/TOWER.md → HEALTH): the Mac stats agent's JSON and the AWS cost pull.
// Each reader returns a value with its age and a state; missing, unreadable and stale are states, never blanks.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { IDS } from '../../identifiers.ts';
import { clean, parseTime } from './fmt.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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
  swap: { totalMiB: number; usedMiB: number } | null; // null: sysctl's swap line was unreadable
  load: number[] | null; // null: unreadable (never an empty list read as calm)
  cpus: number | null;
  vm: { pid: number; comm: string; rssMiB: number } | null;
  agentVersion: string | null;
  power?: Power; // absent: an agent older than F120 (unknown, never red)
};
export type Thermal = {
  warningLevel: number | string | null; // null: "No … has been recorded"; a string: recorded, not a number
  performanceWarningLevel: number | string | null;
  cpuSpeedLimit: number | null; // % of full speed
  cpuSchedulerLimit: number | null;
  cpuAvailableCpus: number | null;
};
export type Power = {
  source: 'ac' | 'battery' | null;
  batteryPct: number | null;
  state: string | null; // charging | discharging | charged | finishing | not-charging
  remainingMin: number | null; // to full on AC, to empty on battery
  lowPowerMode: boolean | null;
  thermal: Thermal | null; // null: pmset -g therm printed nothing
};
export type MacRead = {
  state: Fresh;
  at: number | null;
  error: string | null;
  stats: MacStats | null;
};

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
    swap:
      num(r.swap?.totalMiB) !== null && num(r.swap?.usedMiB) !== null
        ? { totalMiB: r.swap.totalMiB, usedMiB: r.swap.usedMiB }
        : null,
    load:
      Array.isArray(r.load) && r.load.length === 3 && r.load.every((x: unknown) => num(x) !== null)
        ? (r.load as number[])
        : null,
    cpus: num(r.cpus),
    vm:
      vm && num(vm.rssMiB) !== null
        ? {
            pid: num(vm.pid) ?? 0,
            comm: typeof vm.comm === 'string' ? clean(vm.comm) : '?',
            rssMiB: vm.rssMiB,
          }
        : null,
    agentVersion: typeof r.agentVersion === 'string' ? clean(r.agentVersion).slice(0, 64) : null,
    ...(r.power !== undefined && { power: parsePower(r.power) }),
  };
}

// Lenient: a wrong-typed field is null, never a throw (memory is the agent's job; power is extra).
function parsePower(p: unknown): Power {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const t =
    o.thermal && typeof o.thermal === 'object' ? (o.thermal as Record<string, unknown>) : null;
  const lvl = (x: unknown) => (typeof x === 'string' ? clean(x).slice(0, 24) : num(x));
  const pct = num(o.batteryPct);
  return {
    source: o.source === 'ac' || o.source === 'battery' ? o.source : null,
    batteryPct: pct !== null && pct >= 0 && pct <= 100 ? pct : null,
    state: typeof o.state === 'string' ? clean(o.state).slice(0, 16) : null,
    remainingMin: num(o.remainingMin),
    lowPowerMode: typeof o.lowPowerMode === 'boolean' ? o.lowPowerMode : null,
    thermal: t && {
      warningLevel: lvl(t.warningLevel),
      performanceWarningLevel: lvl(t.performanceWarningLevel),
      cpuSpeedLimit: num(t.cpuSpeedLimit),
      cpuSchedulerLimit: num(t.cpuSchedulerLimit),
      cpuAvailableCpus: num(t.cpuAvailableCpus),
    },
  };
}

// The Mac's throttle state for HEALTH, `board.sh status` and `pnpm lanes status` (docs/ops/HUB.md → lanes on battery).
// Red (alerts) on Low Power Mode, battery under 20%, a CPU limit under 100%, or a recorded warning level other than 0.
export const BATTERY_LOW_PCT = 20;
export const LANES_THROTTLED = 3; // the advice: at most this many lanes on battery under 30% or with Low Power Mode
export const BATTERY_ADVISE_PCT = 30;
export type PowerSummary = {
  known: boolean; // false: no fresh read, or an agent older than F120
  line: string; // '' when unknown
  alerts: string[];
  advice: string | null;
};

const hm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;

export function powerSummary(read: MacRead): PowerSummary {
  // a stale read (1–5 min old) still counts: power changes slowly; silent or bad doesn't
  const p = read.state === 'ok' || read.state === 'stale' ? read.stats?.power : undefined;
  if (!p) return { known: false, line: '', alerts: [], advice: null };
  const alerts: string[] = [];
  const bits: string[] = [];
  const onBatt = p.source === 'battery';
  if (p.batteryPct !== null) {
    const left =
      p.remainingMin === null ? '' : ` (${hm(p.remainingMin)} ${onBatt ? 'left' : 'to full'})`;
    bits.push(
      `${onBatt ? 'battery' : 'AC'} ${p.batteryPct}%${p.state ? ` ${p.state}` : ''}${left}`,
    );
  } else if (p.source) bits.push(onBatt ? 'battery' : 'AC');
  if (onBatt && p.batteryPct !== null && p.batteryPct < BATTERY_LOW_PCT)
    alerts.push(`battery ${p.batteryPct}%`);
  if (p.lowPowerMode) {
    bits.push('Low Power Mode on');
    alerts.push('Low Power Mode');
  } else if (p.lowPowerMode === null && p.source) bits.push('Low Power Mode unknown'); // a pmset line we can't read: say so
  const t = p.thermal;
  const limits: string[] = [];
  if (t) {
    if (t.cpuSpeedLimit !== null && t.cpuSpeedLimit < 100)
      limits.push(`CPU speed ${t.cpuSpeedLimit}%`);
    if (t.cpuSchedulerLimit !== null && t.cpuSchedulerLimit < 100)
      limits.push(`scheduler ${t.cpuSchedulerLimit}%`);
    if (t.warningLevel !== null && t.warningLevel !== 0)
      limits.push(`thermal warning ${t.warningLevel}`);
    if (t.performanceWarningLevel !== null && t.performanceWarningLevel !== 0)
      limits.push(`performance warning ${t.performanceWarningLevel}`);
  }
  alerts.push(...limits);
  bits.push(
    limits.length ? `limit: ${limits.join(', ')}` : t ? 'no thermal limit' : 'thermal unknown',
  );
  const advise =
    !!p.lowPowerMode || (onBatt && p.batteryPct !== null && p.batteryPct < BATTERY_ADVISE_PCT);
  return {
    known: true,
    line: bits.join(' · '),
    alerts,
    advice: advise
      ? `≤ ${LANES_THROTTLED} lanes (on battery under ${BATTERY_ADVISE_PCT}% or Low Power Mode)`
      : null,
  };
}

export function readMacStats(
  path: string,
  now: number,
  read = (p: string) => readFileSync(p, 'utf8'),
): MacRead {
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      state: missing ? 'missing' : 'bad',
      at: null,
      error: missing ? null : clean((e as Error).message),
      stats: null,
    };
  }
  let stats: MacStats;
  try {
    stats = parseMacStats(text);
  } catch (e) {
    return {
      state: 'bad',
      at: null,
      error: clean((e as Error).message).slice(0, 120),
      stats: null,
    };
  }
  const sec = (now - stats.t) / 1000;
  // a time ahead of ours (a skewed clock, a bug) would read fresh until the clock caught up
  if (sec < -60)
    return { state: 'bad', at: stats.t, error: `t is ${Math.round(-sec)} s in the future`, stats };
  const state: Fresh = sec > MAC_SILENT_SEC ? 'silent' : sec > MAC_STALE_SEC ? 'stale' : 'ok';
  return { state, at: stats.t, error: null, stats };
}

// AWS month-to-date from localNotes/costs-daily.json: `aws ce get-cost-and-usage --granularity DAILY --group-by
// LINKED_ACCOUNT,SERVICE`, re-pulled by the maintainer on request. Its "as of" is the file's mtime; it covers only
// through its last day, which the page shows too. Accounts by identifiers.json: dev by its id, prod by its id's
// sha256 (the prod id stays out of tracked files — docs/ops/IDENTIFIERS.md). The fixtures' synthetic ids come
// from their own accounts.json (web/main.ts --fixtures), never from here.
export type AccountKind = (id: string) => string;
export function accountKind(id: string, ids = IDS): string {
  if (id === ids.aws.devAccountId) return 'dev';
  if (/^\d{12}$/.test(id) && sha256(id) === ids.aws.prodAccountSha256) return 'prod';
  return 'other';
}
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

export function sumCosts(
  text: string,
  month: string,
  kind: AccountKind = (id) => accountKind(id),
): Omit<Costs, 'state' | 'at' | 'error'> {
  const r = JSON.parse(text.replace(/^\uFEFF/, '')) as { ResultsByTime?: unknown };
  if (!r || !Array.isArray(r.ResultsByTime)) throw new Error('no ResultsByTime');
  const byAccount: Record<string, number> = {};
  let total = 0;
  let through: string | null = null;
  for (const day of r.ResultsByTime as { TimePeriod?: { Start?: string }; Groups?: unknown }[]) {
    const start = day?.TimePeriod?.Start;
    if (typeof start !== 'string' || !start.startsWith(`${month}-`)) continue;
    if (!through || start > through) through = start;
    for (const g of (Array.isArray(day.Groups) ? day.Groups : []) as {
      Keys?: string[];
      Metrics?: { UnblendedCost?: { Amount?: unknown } };
    }[]) {
      const amt = Number(g?.Metrics?.UnblendedCost?.Amount);
      if (!Number.isFinite(amt)) continue;
      const acct = kind(g.Keys?.[0] ?? '');
      byAccount[acct] = (byAccount[acct] ?? 0) + amt;
      total += amt;
    }
  }
  return { month, through, total, byAccount };
}

export function readCosts(path: string, now: number, month: string, kind?: AccountKind): Costs {
  const empty = { month, through: null, total: 0, byAccount: {} };
  let mtime: number;
  let text: string;
  try {
    mtime = statSync(path).mtimeMs;
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ...empty,
      state: missing ? 'missing' : 'bad',
      at: null,
      error: missing ? null : clean((e as Error).message),
    };
  }
  try {
    const c = sumCosts(text, month, kind);
    // a pull with no rows for this month (the 1st, before a re-pull) is not "$0.00, fine"
    if (c.through === null)
      return { ...c, state: 'stale', at: mtime, error: `no rows for ${month}: re-pull` };
    return {
      ...c,
      state: (now - mtime) / 1000 > COSTS_STALE_SEC ? 'stale' : 'ok',
      at: mtime,
      error: null,
    };
  } catch (e) {
    return { ...empty, state: 'bad', at: mtime, error: clean((e as Error).message).slice(0, 120) };
  }
}
