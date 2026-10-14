// Lease decisions for the session board (docs/ops/SESSION-BOARD.md → Leases). Pure: board.sh / heavy.sh
// gather the state under the board lock, call `cli.ts decide-*`, and act on the answer.
import { classCost, thresholds, type Limits, type LiveLimits } from './limits.ts';

// --- dev: one branch on the dev stage at a time (advisory; ci-bot's refs/locks/dev is GitHub's truth) ---

export type DevLease = {
  v: 1;
  holderPid: number;
  holderStart: string;
  holderName: string;
  branch: string;
  acquiredAt: string;
  expiresAt: string;
  ttlSec: number;
  note?: string;
  holderGone?: boolean;
};

export type DevRequest = {
  pid: number;
  start: string;
  name: string;
  branch: string;
  ttlSec: number;
  force?: boolean;
};

export type DevDecision =
  | { kind: 'grant' }
  | { kind: 'renew' }
  | { kind: 'takeover'; reason: 'expired' | 'dead' | 'resumed' | 'forced'; previous: DevLease }
  | { kind: 'wait'; holder: DevLease };

export type Alive = (pid: number, start: string) => boolean;

export function decideDev(
  current: DevLease | null,
  req: DevRequest,
  now: Date,
  alive: Alive,
): DevDecision {
  if (!current) return { kind: 'grant' };
  if (current.holderPid === req.pid && current.holderStart === req.start) return { kind: 'renew' };
  if (Date.parse(current.expiresAt) <= now.getTime())
    return { kind: 'takeover', reason: 'expired', previous: current };
  // A gone holder keeps the lease until TTL (dev testing outlives a session restart) — and the restarted
  // session on the same branch picks it back up; a dead holder that never said goodbye (crash, container
  // restart) loses it at once.
  if (current.holderGone && current.branch === req.branch)
    return { kind: 'takeover', reason: 'resumed', previous: current };
  if (!current.holderGone && !alive(current.holderPid, current.holderStart))
    return { kind: 'takeover', reason: 'dead', previous: current };
  if (req.force) return { kind: 'takeover', reason: 'forced', previous: current };
  return { kind: 'wait', holder: current };
}

// Whole seconds, like every other board timestamp (sb_now, jq `todate` on renew) — a renewal must never
// read as earlier than the grant.
const isoSec = (ms: number) =>
  new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export function devLease(req: DevRequest, now: Date, note?: string): DevLease {
  return {
    v: 1,
    holderPid: req.pid,
    holderStart: req.start,
    holderName: req.name,
    branch: req.branch,
    acquiredAt: isoSec(now.getTime()),
    expiresAt: isoSec(now.getTime() + req.ttlSec * 1000),
    ttlSec: req.ttlSec,
    ...(note ? { note } : {}),
  };
}

// --- heavy: a counting budget against the measured edge ---

export type HeavySlot = { pid: number; class: string; startedAt: string; wrapperPid: number };

export type HeavyRequest = { class: string };

export type Live = { pids: number; anonBytes: number };

export type HeavyDecision = {
  // grant: under soft. nudge: over soft, at or under hard — runs, says so. over-hard: past the measured edge.
  verdict: 'grant' | 'nudge' | 'over-hard';
  // wait only when enforce is on and the prediction is past hard (the user's rule: bite at the edge only).
  wait: boolean;
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
  return {
    verdict: overHard ? 'over-hard' : overSoft ? 'nudge' : 'grant',
    wait: overHard && limits.enforce,
    predicted: { pids, anonMiB: Math.round(anon / MiB) },
    thresholds: {
      pidsSoft: th.pidsSoft,
      pidsHard: th.pidsHard,
      anonSoftMiB: Math.round(th.anonSoft / MiB),
      anonHardMiB: Math.round(th.anonHard / MiB),
    },
  };
}
