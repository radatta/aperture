// The phase logger's rows (scripts/board/phase-log.sh → <usage dir>/phase-log.jsonl) → explicit phase markers for the
// lanes' tracks. docs/ops/USAGE-METER.md → Phase log.
import { BRANCH_RE, PHASES, type Phase as LanePhase } from '../board/tower/lanes.ts';

export interface PhaseLogRow {
  lane: string;
  from: LanePhase | null;
  to: LanePhase | null; // null: the lane file went
  ts: number;
  pct: number | null;
}

const phase = (v: unknown): LanePhase | null | undefined =>
  v === null ? null : (PHASES as readonly unknown[]).includes(v) ? (v as LanePhase) : undefined;

// Torn or foreign lines dropped; a row repeated (the logger lost its state) kept once, by lane, phase and time.
export function parsePhaseLog(text: string): PhaseLogRow[] {
  const seen = new Set<string>();
  const out: PhaseLogRow[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    const ts = Date.parse(String(r?.ts));
    const to = phase(r?.to);
    if (r?.v !== 1 || typeof r.lane !== 'string' || !BRANCH_RE.test(r.lane) || !Number.isFinite(ts))
      continue;
    if (to === undefined) continue;
    const k = `${r.lane}|${to}|${ts}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // only to is used; a from the logger took from a foreign lane file is no reason to lose the row
    const from = phase(r.from) ?? null;
    out.push({ lane: r.lane, from, to, ts, pct: typeof r.pct === 'number' ? r.pct : null });
  }
  out.sort((a, b) => a.ts - b.ts);
  // a removal stamped at each pass's time repeats while the logger can't save its state: one per gap between sightings
  const gone = new Set<string>();
  return out.filter((r) => {
    const dup = r.to === null && gone.has(r.lane);
    if (r.to === null) gone.add(r.lane);
    else gone.delete(r.lane);
    return !dup;
  });
}
