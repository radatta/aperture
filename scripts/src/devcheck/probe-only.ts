// The probe job (IOS-CHECK.md → Probe job): every iOS plan the scenarios send, cut to the reads that check the
// plan's probe points still land — launch once, then nav, find, tap, absent and the expects that need no draft. No
// drafts, kills, relaunches or sign-in: those are the full scenario's (~6 min); this runs in ~2. A filter stays (a keys
// nothing erases: done-form's search), since the tap after it depends on what it filtered. Pure, on the recorded
// plans (ios-plans.ts), so it can't drift from what ios-standalone and category-suggest send.
import type { IosOp } from '../mailroom/sim';

export interface Plan {
  name: string;
  steps: IosOp[];
}

// Recorded jobs with nothing left to probe once cut: the kills and relaunches are the whole job.
export const NOT_PROBED = ['relaunch'];

const DROPPED = new Set(['signIn', 'kill', 'erase', 'launch', 'shutdown']);
const PROBES = new Set(['nav', 'find', 'tap', 'absent', 'readBuild']);
const inOf = (o: IosOp) => ('in' in o ? o.in : undefined);

// One job, cut. `first`: it opens with a launch and keeps the build guard (readBuild/expectBuild).
export function probeOnly(steps: IosOp[], o: { first: boolean }): IosOp[] {
  const drop = new Set<number>();
  const typed = new Set<string>();
  // A draft: keys … the erase that empties that field (same `in`, or none); what's between reads the draft. A keys
  // no erase empties is a filter (a search) and stays.
  for (const [i, s] of steps.entries()) {
    if (s.op !== 'keys' || drop.has(i)) continue;
    const j = steps.findIndex(
      (e, k) => k > i && e.op === 'erase' && (inOf(e) === undefined || inOf(e) === s.in),
    );
    if (j < 0) continue;
    typed.add(s.text);
    for (let k = i; k <= j; k++) drop.add(k);
  }
  const out: IosOp[] = o.first ? [{ op: 'launch' }] : [];
  const defs = new Set<string>();
  for (const [i, s] of steps.entries()) {
    if (drop.has(i) || DROPPED.has(s.op)) continue;
    if ((s.op === 'readBuild' || s.op === 'expectBuild') && !o.first) continue;
    if ('label' in s && typed.has(s.label)) continue; // the draft's own text, wherever it's read
    if (s.op === 'expect') {
      if ('signedIn' in s ? !out.some((x) => x.op === 'launch') : !defs.has(s.as)) continue;
      if ('sameWidthAs' in s && !defs.has(s.sameWidthAs)) continue;
    }
    if (s.op === 'keys' && s.in !== undefined && !defs.has(s.in)) continue;
    if ((s.op === 'find' || s.op === 'tap') && s.as) defs.add(s.as);
    out.push(s);
  }
  return out;
}

// Every job cut, those with nothing to probe gone, the sim shut down after the last.
export function probeJobs(plans: Plan[]): Plan[] {
  const cut = plans
    .map((p, i) => ({ name: p.name, steps: probeOnly(p.steps, { first: i === 0 }) }))
    .filter((p) => p.steps.some((s) => PROBES.has(s.op)));
  cut.at(-1)?.steps.push({ op: 'shutdown' });
  return cut;
}
