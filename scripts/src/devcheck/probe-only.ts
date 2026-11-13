// The probe job (IOS-CHECK.md → Probe job): every iOS plan the scenarios send, cut to the reads that check the
// plan's probe points still land — launch once, then nav, find, tap, absent and the expects that need no draft. No
// drafts, kills, relaunches or sign-in: those are the full scenario's (~6 min); this takes ~4–5 (2026-11-12, mostly launch's build guard). A filter stays (a keys
// nothing erases: done-form's search), since the tap after it depends on what it filtered. Pure, on the recorded
// plans (ios-plans.ts), so it can't drift from what ios-standalone and category-suggest send.
import type { IosOp } from '../mailroom/sim';

export interface Plan {
  name: string;
  steps: IosOp[];
}

// Recorded jobs the probe job doesn't send. relaunch: once cut, nothing is left (its kills are the whole job).
// capture-long: its points hold only after the full plan's kill, relaunch and 16 padding tasks (a long Tasks page);
// cut, it ran on a short page still filtered by done-form's search, and its Task tap failed there on both dev runs that
// reached it (2026-11-12) while the full scenario's passes — a state its plan doesn't vouch for. ios-standalone and the
// headless check keep its points.
export const NOT_PROBED = ['relaunch', 'capture-long'];

const DROPPED = new Set(['signIn', 'kill', 'erase', 'launch', 'shutdown']);
const PROBES = new Set(['nav', 'find', 'tap', 'absent', 'readBuild']);
const inOf = (o: IosOp) => ('in' in o ? o.in : undefined);

// One job, cut. `first`: it opens with a launch and keeps the build guard (readBuild/expectBuild).
export function probeOnly(steps: IosOp[], o: { first: boolean }): IosOp[] {
  const drop = new Set<number>();
  const typed = new Set<string>();
  // A draft: keys … the erase that empties it; what's between reads the draft. An erase with `in` empties the latest
  // open keys into that field; one without, the latest open keys of all (what has focus). A keys no erase empties
  // is a filter (a search) and stays.
  const open: number[] = [];
  for (const [j, e] of steps.entries()) {
    if (e.op === 'keys') open.push(j);
    if (e.op !== 'erase') continue;
    const at = open.findLastIndex((i) => inOf(e) === undefined || inOf(steps[i]!) === inOf(e));
    if (at < 0) continue;
    const i = open.splice(at, 1)[0]!;
    const keys = steps[i]!;
    if (keys.op === 'keys') typed.add(keys.text);
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
    .filter((p) => !NOT_PROBED.includes(p.name))
    .map((p, i) => ({ name: p.name, steps: probeOnly(p.steps, { first: i === 0 }) }))
    .filter((p) => p.steps.some((s) => PROBES.has(s.op)));
  cut.at(-1)?.steps.push({ op: 'shutdown' });
  return cut;
}
