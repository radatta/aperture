// Heavy-slot decisions for the session board (docs/ops/SESSION-BOARD.md → Leases). Pure: heavy.sh gathers the
// state under the board lock, calls `cli.ts decide-heavy`, and acts on the answer.
import { classCost, concurrencyCap, thresholds, type Limits, type LiveLimits } from './limits.ts';

// --- heavy: a counting budget against the measured edge ---

export type HeavySlot = {
  pid: number;
  class: string;
  startedAt: string;
  wrapperPid: number;
  label?: string;
};

// loadTest: matrix / edge runs probe the edge on purpose, so the cap never holds them.
export type HeavyRequest = { class: string; loadTest?: boolean };

export type HeavyCap = { max: number; running: number; full: boolean };

export type Live = { pids: number; anonBytes: number };

export type HeavyDecision = {
  // grant: under soft. nudge: over soft, at or under hard — runs, says so. over-hard: past the measured
  // edge. cap-full: the class's concurrency cap is reached — wins over over-hard (it names the holders).
  verdict: 'grant' | 'nudge' | 'over-hard' | 'cap-full';
  // wait only when enforce is on and the prediction is past hard or the cap is full (bite at the edge only).
  wait: boolean;
  cap: HeavyCap | null; // null when limits.json caps no jobs of this class
  predicted: { pids: number; anonMiB: number };
  thresholds: { pidsSoft: number; pidsHard: number; anonSoftMiB: number; anonHardMiB: number };
};

// A slot younger than this hasn't ramped up yet, so its cost isn't in the live numbers — count it.
export const RAMP_SEC = 20;

const MiB = 1048576;

export function decideHeavy(
  limits: Limits,
  liveLimits: LiveLimits,
  live: Live,
  slots: HeavySlot[],
  req: HeavyRequest,
  now: Date,
): HeavyDecision {
  const th = thresholds(limits, liveLimits);
  let pids = live.pids;
  let anon = live.anonBytes;
  for (const s of slots) {
    if (now.getTime() - Date.parse(s.startedAt) >= RAMP_SEC * 1000) continue;
    const c = classCost(limits, s.class);
    pids += c.pids;
    anon += c.anonMiB * MiB;
  }
  const c = classCost(limits, req.class);
  pids += c.pids;
  anon += c.anonMiB * MiB;
  const overHard = pids > th.pidsHard || anon > th.anonHard;
  const overSoft = pids > th.pidsSoft || anon > th.anonSoft;
  // Every running slot of the class counts, however young: a 5 s-old suite is about to take 8 cores.
  const max = concurrencyCap(limits, req.class);
  const running = slots.filter((s) => s.class === req.class).length;
  const cap = max === null ? null : { max, running, full: running >= max };
  const capFull = !!cap?.full && !req.loadTest;
  return {
    verdict: capFull ? 'cap-full' : overHard ? 'over-hard' : overSoft ? 'nudge' : 'grant',
    // Load tests are never held — not by the cap, not by the hard line: they push toward the edge on purpose and
    // stop themselves (matrix.sh's HEAVY_GUARD, edge.sh's own stops); a hold would read as a false edge.
    wait: (capFull || (overHard && !req.loadTest)) && limits.enforce,
    cap,
    predicted: { pids, anonMiB: Math.round(anon / MiB) },
    thresholds: {
      pidsSoft: th.pidsSoft,
      pidsHard: th.pidsHard,
      anonSoftMiB: Math.round(th.anonSoft / MiB),
      anonHardMiB: Math.round(th.anonHard / MiB),
    },
  };
}
