// The smart cap, log-only (docs/ops/SESSION-BOARD.md → Budget): a job budget at every heavy.sh admission and a lane
// budget at every `pnpm lanes start`, in units of about one busy core, computed beside the live rules and logged as
// `kind: "budget"` events — never a decision. Pure: callers read the files. Numbers: limits.json `budget`.
import type { MacRead } from './tower/health.ts';

export type Budget = {
  enforce: boolean; // recorded in events only: nothing here acts on it
  base: number;
  lightWorking: number;
  jobUnits: number;
  laneUnits: number;
  newLane: number;
  sessionsMax: number;
  macSimSlots: number;
  sampleFreshSec: number;
  units: Record<UnitKey, number>;
  phases: Record<string, number>;
  power: { slow: number; thermal: number; unknown: number; batteryPctBelow: number };
};

export const UNIT_KEYS = [
  'test',
  'test-fast',
  'ui-local',
  'ui-capture',
  'ui-dev',
  'dev',
  'typecheck',
  'lint',
  'test-file',
  'build',
  'other',
] as const;
export type UnitKey = (typeof UNIT_KEYS)[number];
export const PHASE_KEYS = [
  'plan',
  'build',
  'gate',
  'review',
  'local',
  'dev',
  'pr',
  'merged',
  'cleanup',
  'blocked',
  'parked',
];

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const nonNeg = (x: unknown) => fin(x) && x >= 0;
const pos = (x: unknown) => fin(x) && x > 0;

// Lenient and separate from parseLimits (which throws, and a throw in decide-heavy is a fail-open grant): anything
// missing or malformed is null, and null means no log and no line, nothing else.
export function parseBudget(raw: unknown): Budget | null {
  const b = raw as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  const u = b.units as Record<string, unknown> | undefined;
  const ph = b.phases as Record<string, unknown> | undefined;
  const pw = b.power as Record<string, unknown> | undefined;
  if (typeof b.enforce !== 'boolean' || !u || !ph || !pw) return null;
  if (![b.base, b.lightWorking, b.newLane, b.macSimSlots].every(nonNeg)) return null;
  if (![b.jobUnits, b.laneUnits, b.sessionsMax, b.sampleFreshSec].every(pos)) return null;
  if (!UNIT_KEYS.every((k) => nonNeg(u[k])) || !PHASE_KEYS.every((k) => nonNeg(ph[k]))) return null;
  if (![pw.slow, pw.thermal, pw.unknown].every((x) => fin(x) && x >= 1)) return null;
  if (!nonNeg(pw.batteryPctBelow)) return null;
  return b as unknown as Budget;
}

export type KWhy = 'ac' | 'battery' | 'lpm' | 'low' | 'thermal' | 'unknown';

// k divides both budgets: a slow Mac (battery, Low Power Mode, low charge) does the same work with fewer cores.
// A read up to 5 min old still counts, as powerSummary's: power changes slowly. No read is the slow guess. A CPU
// speed or scheduler limit under 100 % is thermal.
export function powerFactor(read: MacRead, pw: Budget['power']): { k: number; why: KWhy } {
  const p = read.state === 'ok' || read.state === 'stale' ? read.stats?.power : undefined;
  if (!p) return { k: pw.unknown, why: 'unknown' };
  const under = (x: number | null | undefined) => x !== null && x !== undefined && x < 100;
  if (under(p.thermal?.cpuSpeedLimit) || under(p.thermal?.cpuSchedulerLimit))
    return { k: pw.thermal, why: 'thermal' };
  if (p.source === 'battery') return { k: pw.slow, why: 'battery' };
  if (p.lowPowerMode) return { k: pw.slow, why: 'lpm' };
  // the spec's "charge under 30%", literal: on battery the line above already said so, so `low` is AC charging below it
  if (p.batteryPct !== null && p.batteryPct < pw.batteryPctBelow) return { k: pw.slow, why: 'low' };
  return { k: 1, why: 'ac' };
}

const PLAIN = new Set(['test', 'test-fast', 'typecheck', 'lint', 'dev', 'build', 'test-file']);

// A slot's budget key. `ui` covers three loads (a local dev check, one against deployed dev, a short capture), told
// apart by the command; a ui slot from an older lease.sh carries none and counts as the heaviest.
export function unitKey(cls: string, cmd?: string | null): { as: UnitKey; guess?: true } {
  if (PLAIN.has(cls)) return { as: cls as UnitKey };
  if (cls !== 'ui') return { as: 'other' };
  if (!cmd) return { as: 'ui-local', guess: true };
  if (/devcheck:local\b|\bdevcheck\b.*\s--local\b/.test(cmd)) return { as: 'ui-local' };
  if (/\bdevcheck\b/.test(cmd)) return { as: 'ui-dev' };
  return { as: 'ui-capture' };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export type BudgetSlot = { pid: number; class: string; cmd?: string | null };
export type SampleLite = {
  t: string;
  sessions?: { pid: number; state: string }[];
  cg?: { psiCpuSome10?: number; cpuCores?: number | null; anonMiB?: number };
};

// What the job budget would say: committed = base + every live slot's units + lightWorking per working session that
// holds no slot (from the last sample, when it is fresh); admit while committed + this job ≤ jobUnits / k.
export function jobBudget(
  b: Budget,
  slots: BudgetSlot[],
  sample: SampleLite | null,
  now: number,
  owner: number,
  req: { class: string; cmd?: string | null },
  k: number,
) {
  const held = slots.map((s) => {
    const u = unitKey(s.class, s.cmd);
    return {
      pid: s.pid,
      class: s.class,
      as: u.as,
      units: b.units[u.as],
      ...(u.guess && { guess: true }),
    };
  });
  const age = sample ? Math.round((now - Date.parse(sample.t)) / 1000) : null;
  const fresh = age !== null && age >= -60 && age <= b.sampleFreshSec;
  const busy = new Set([owner, ...slots.map((s) => s.pid)]);
  const light = fresh
    ? (sample!.sessions ?? []).filter((s) => s.state === 'working' && !busy.has(s.pid)).length
    : 0;
  const slotUnits = r2(held.reduce((a, h) => a + h.units, 0));
  const lightUnits = r2(light * b.lightWorking);
  const total = r2(b.base + slotUnits + lightUnits);
  const u = unitKey(req.class, req.cmd);
  const job = b.units[u.as];
  const allowed = r2(b.jobUnits / k);
  return {
    unit: { as: u.as, units: job, ...(u.guess && { guess: true }) },
    committed: {
      base: b.base,
      slots: slotUnits,
      light: lightUnits,
      total,
      held,
      lightWorking: light,
      lightKnown: fresh,
      sampleAgeSec: age,
    },
    limit: b.jobUnits,
    allowed,
    would: total + job <= allowed + 1e-9 ? ('admit' as const) : ('wait' as const),
    cg:
      fresh && sample!.cg
        ? {
            psiCpuSome10: sample!.cg.psiCpuSome10 ?? null,
            cpuCores: sample!.cg.cpuCores ?? null,
            anonMiB: sample!.cg.anonMiB ?? null,
          }
        : null,
  };
}

export const phaseUnits = (b: Budget, phase: string | null) =>
  phase !== null && Object.hasOwn(b.phases, phase) ? b.phases[phase]! : b.phases.build!;

// What the lane budget would say about one more lane: base + every active lane's phase units + newLane against
// laneUnits / k, and the live sessions (the hub's included) plus this one against sessionsMax. No lane file = build.
export function laneBudget(
  b: Budget,
  lanes: { branch: string; phase: string | null }[],
  live: number,
  k: number,
) {
  const rows = lanes.map((l) => ({
    branch: l.branch,
    phase: l.phase,
    units: phaseUnits(b, l.phase),
  }));
  const sum = r2(rows.reduce((a, l) => a + l.units, 0));
  const total = r2(b.base + sum + b.newLane);
  const allowed = r2(b.laneUnits / k);
  const wouldWhy: ('units' | 'sessions')[] = [];
  if (total > allowed + 1e-9) wouldWhy.push('units');
  if (live + 1 > b.sessionsMax) wouldWhy.push('sessions');
  return {
    lanes: rows,
    units: { base: b.base, lanes: sum, new: b.newLane, total },
    limit: b.laneUnits,
    allowed,
    sessions: { live, max: b.sessionsMax },
    sim: null, // one Simulator job at a time: no lease marks one yet (decisions.md)
    would: wouldWhy.length ? ('refuse' as const) : ('admit' as const),
    wouldWhy,
  };
}

const lim = (x: number) => String(Math.round(x * 100) / 100); // the value `would` compares against: 3.46, not 3.5

// The one status line (board.sh status, pnpm lanes status, the brief's BUDGET): what is committed now against each
// scaled limit. The brief strips BUDGET_PREFIX, so it has one home.
export const BUDGET_PREFIX = 'budget (log-only): ';
export function budgetLine(
  b: Budget,
  now: { jobs: number | null; lanes: number | null; sessions: number | null },
  pf: { k: number; why: KWhy },
): string {
  const bits: string[] = [];
  if (now.jobs !== null) bits.push(`jobs ${lim(now.jobs)}/${lim(r2(b.jobUnits / pf.k))}`);
  if (now.lanes !== null) bits.push(`lanes ${lim(now.lanes)}/${lim(r2(b.laneUnits / pf.k))}`);
  if (now.sessions !== null) bits.push(`sessions ${now.sessions}/${b.sessionsMax}`);
  bits.push(`k ${lim(pf.k)} ${pf.why}`);
  return `${BUDGET_PREFIX}${bits.join(' · ')}`;
}

// The committed job units right now (status): base + slots + light, no request.
export const jobsNow = (b: Budget, slots: BudgetSlot[], sample: SampleLite | null, now: number) =>
  jobBudget(b, slots, sample, now, -1, { class: 'other' }, 1).committed.total;

// The lane units right now (status): base + every active lane, without the new one.
export const lanesNow = (b: Budget, lanes: { branch: string; phase: string | null }[]) =>
  r2(b.base + lanes.reduce((a, l) => a + phaseUnits(b, l.phase), 0));

// The last whole JSON line of a samples file's tail (a torn line from a concurrent append is skipped).
export function lastSample(tail: string): SampleLite | null {
  const lines = tail.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const s = JSON.parse(lines[i]!);
      if (s && typeof s.t === 'string') return s as SampleLite;
    } catch {
      // torn, or the tail cut it: the one before
    }
  }
  return null;
}
