// limits.json (scripts/board/limits.json): container thresholds as FRACTIONS of the live pids.max /
// memory.high, so the next limit change moves nothing; per-class costs from the load tests.

export type ClassCost = { pids: number; anonMiB: number; p95Sec: number; source?: string };

export type Limits = {
  v: 1;
  enforce: boolean;
  measuredAt: string | null;
  measuredLimits: { pidsMax: number; highMiB: number } | null;
  container: {
    pidsSoftFrac: number;
    pidsHardFrac: number;
    anonSoftFrac: number;
    anonHardFrac: number;
    psiFullKill: number;
    currentGuardMiB: number;
  };
  tuning: { test: { workspaceConcurrency?: number; maxWorkers?: number } | null };
  classes: Record<string, ClassCost>;
};

export type LiveLimits = { pidsMax: number; highBytes: number };

export type Thresholds = { pidsSoft: number; pidsHard: number; anonSoft: number; anonHard: number };

const MiB = 1048576;

export function parseLimits(raw: unknown): Limits {
  const l = raw as Limits;
  const c = l?.container;
  const fracs = [c?.pidsSoftFrac, c?.pidsHardFrac, c?.anonSoftFrac, c?.anonHardFrac];
  if (l?.v !== 1 || !c || fracs.some((f) => typeof f !== 'number' || f <= 0 || f > 1))
    throw new Error('limits.json: expected v:1 and container fractions in (0, 1]');
  if (c.pidsSoftFrac > c.pidsHardFrac || c.anonSoftFrac > c.anonHardFrac)
    throw new Error('limits.json: a soft fraction is above its hard fraction');
  if (typeof l.enforce !== 'boolean') throw new Error('limits.json: enforce must be a boolean');
  return l;
}

export function thresholds(l: Limits, live: LiveLimits): Thresholds {
  const c = l.container;
  return {
    pidsSoft: Math.floor(c.pidsSoftFrac * live.pidsMax),
    pidsHard: Math.floor(c.pidsHardFrac * live.pidsMax),
    anonSoft: Math.floor(c.anonSoftFrac * live.highBytes),
    anonHard: Math.floor(c.anonHardFrac * live.highBytes),
  };
}

export function classCost(l: Limits, cls: string): ClassCost {
  return l.classes[cls] ?? { pids: 0, anonMiB: 0, p95Sec: 0 };
}

type HeavyEvent = {
  class?: string;
  t?: string;
  peak?: { dPids?: number; dAnonMiB?: number };
  guard?: boolean;
};

// Warnings when limits.json no longer matches reality: limits changed since measuring, or a class's
// recent real peaks (non-guarded events in the window) run > 20 % over its budgeted cost.
export function staleness(
  l: Limits,
  live: LiveLimits,
  events: HeavyEvent[],
  now: Date,
  days = 14,
): string[] {
  const out: string[] = [];
  const liveHighMiB = Math.round(live.highBytes / MiB);
  if (!l.measuredLimits)
    out.push('limits.json: classes are placeholders — not yet measured (quiet window pending)');
  else if (l.measuredLimits.pidsMax !== live.pidsMax || l.measuredLimits.highMiB !== liveHighMiB)
    out.push(
      `limits.json: measured at ${l.measuredLimits.pidsMax} pids / ${l.measuredLimits.highMiB} MiB, ` +
        `running at ${live.pidsMax} / ${liveHighMiB} — rerun the matrix`,
    );
  const since = now.getTime() - days * 86400_000;
  const byClass = new Map<string, { pids: number[]; anon: number[] }>();
  for (const e of events) {
    if (!e.class || !e.peak || e.guard || !e.t || Date.parse(e.t) < since) continue;
    const b = byClass.get(e.class) ?? { pids: [], anon: [] };
    b.pids.push(e.peak.dPids ?? 0);
    b.anon.push(e.peak.dAnonMiB ?? 0);
    byClass.set(e.class, b);
  }
  for (const [cls, b] of byClass) {
    const cost = l.classes[cls];
    if (!cost || b.anon.length < 3) continue;
    const anon = p95(b.anon);
    const pids = p95(b.pids);
    if (anon > cost.anonMiB * 1.2)
      out.push(
        `class ${cls}: p95 Δanon ${anon} MiB vs ${cost.anonMiB} in limits.json (${b.anon.length} runs) — rerun the matrix or bump`,
      );
    if (pids > cost.pids * 1.2)
      out.push(
        `class ${cls}: p95 Δpids ${pids} vs ${cost.pids} in limits.json (${b.pids.length} runs) — rerun the matrix or bump`,
      );
  }
  return out;
}

export function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? 0;
}
