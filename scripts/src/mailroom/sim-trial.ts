// `pnpm mailroom sim-trial --tag <t>`: the input-gap trial (docs/ops/IOS-CHECK.md → Input-gap trial). AXe can report a
// tap done that iOS never got (AXe issue 71: a new axe process can lose its first touch before the sim's input service
// is up). Each round is one sim job typing one word into the capture bar and erasing it once per `via`, the order
// rotated each round so a change in the Mac's load lands on every variant alike; the runner's read-backs count the
// drops into trial.jsonl, and this sums them per variant. No dev lock, no deploy: a drop count doesn't depend on the
// build. The read-backs still retry and fail as in a devcheck run, so nothing dropped is hidden.
import { join } from 'node:path';
import {
  IosAssert,
  IosUnavailable,
  VIAS,
  makeSimJob,
  runSimJob,
  validateSimParams,
} from './sim.ts';
import type { IosOp, SimDeps, SimJob, SimParams, SimResult, Via } from './sim.ts';

// Six distinct letters each, from all three rows, never one key twice in a row (a repeat can be coalesced: another failure).
export const TRIAL_WORDS = ['fjqmzt', 'wkbpxa', 'rhculd', 'ygvoes', 'nimwtk'] as const;
export const TRIAL_ROUNDS = TRIAL_WORDS.length;
const TAG_RE = /^[a-z0-9-]{1,16}$/;

const at = <T>(xs: readonly T[], i: number): T => xs[i % xs.length] as T;

export function trialPlan(round: number, last: boolean): SimParams {
  const word = at(TRIAL_WORDS, round);
  const order = VIAS.map((_, k) => at(VIAS, k + round));
  const steps: IosOp[] = [
    { op: 'launch' },
    { op: 'signIn' },
    { op: 'expect', signedIn: true },
    { op: 'nav', tab: 'Home' },
    { op: 'tap', label: 'Capture', near: { x: 220, y: 895 }, radius: 10 },
    { op: 'wait', s: 2 },
    {
      op: 'find',
      label: 'Capture log',
      near: { x: 200, y: 480 },
      radius: 40,
      role: 'AXTextArea',
      as: 'bar',
    },
    // erase n = the letters typed: every delete is needed, so each one dropped is a letter left and counted
    ...order.flatMap((via): IosOp[] => [
      { op: 'keys', text: word, in: 'bar', via },
      { op: 'erase', n: word.length, in: 'bar', via },
    ]),
    { op: 'blur' },
  ];
  return { sha: '0'.repeat(40), timeoutSec: 600, shutdown: last, steps };
}

interface TrialLine {
  i: number;
  op: 'keys' | 'erase';
  via: Via;
  n: number;
  drops: number;
  sendMs: number;
}
export interface TrialRound {
  round: number;
  id: string;
  load: { start: string; end: string } | null;
  lines: TrialLine[];
  retried: number[]; // step indexes whose note says the read-back sent more (retyped / deleted … more)
  failure?: string;
}
export interface TrialRow {
  via: Via;
  taps: number;
  drops: number;
  retried: number;
  msPerTap: number | null; // median over its ops
}

export function parseTrial(raw: string | null): Pick<TrialRound, 'load' | 'lines'> {
  const out: Pick<TrialRound, 'load' | 'lines'> = { load: null, lines: [] };
  for (const l of (raw ?? '').split('\n')) {
    if (!l.trim()) continue;
    const o = JSON.parse(l) as Partial<TrialLine> & { load?: TrialRound['load'] };
    if (o.load) out.load = o.load;
    else out.lines.push(o as TrialLine);
  }
  return out;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? at(s, m) : (at(s, m - 1) + at(s, m)) / 2);
};

export function summarise(rounds: TrialRound[]): TrialRow[] {
  return VIAS.map((via) => {
    const ls = rounds.flatMap((r) =>
      r.lines.filter((l) => l.via === via).map((l) => ({ ...l, retried: r.retried.includes(l.i) })),
    );
    return {
      via,
      taps: ls.reduce((a, l) => a + l.n, 0),
      drops: ls.reduce((a, l) => a + l.drops, 0),
      retried: ls.filter((l) => l.retried).length,
      msPerTap: median(ls.map((l) => l.sendMs / l.n)),
    };
  });
}

export function trialTable(tag: string, rounds: TrialRound[]): string[] {
  const rows = summarise(rounds);
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const out = [
    `sim-trial ${tag}: ${rounds.length} round(s)`,
    `${pad('via', 9)}${pad('taps', 6)}${pad('drops', 7)}${pad('drop %', 8)}${pad('retried', 9)}ms/tap`,
    ...rows.map(
      (r) =>
        `${pad(r.via, 9)}${pad(r.taps, 6)}${pad(r.drops, 7)}${pad(r.taps ? ((100 * r.drops) / r.taps).toFixed(1) : '-', 8)}${pad(r.retried, 9)}${r.msPerTap ?? '-'}`,
    ),
  ];
  for (const r of rounds)
    out.push(
      `  round ${r.round} ${r.id}: load ${r.load ? `${r.load.start} → ${r.load.end}` : 'unrecorded'}${r.failure ? `; FAILED: ${r.failure}` : ''}`,
    );
  return out;
}

const retriedSteps = (r: SimResult | undefined) =>
  (r?.steps ?? []).filter((s) => /retyped|deleted .*more/.test(s.note ?? '')).map((s) => s.i);

// Exit 0: every round ran clean; 1: a round failed (its drops still count up to the failure, and the table says so);
// 3: the Mac couldn't run one (what ran before it is still printed).
export async function simTrial(
  d: SimDeps,
  tag: string,
  run: (d: SimDeps, job: SimJob) => Promise<SimResult> = runSimJob,
): Promise<number> {
  if (!TAG_RE.test(tag)) {
    d.log('sim-trial needs --tag <a-z 0-9 ->, e.g. idle or loaded');
    return 2;
  }
  const rounds: TrialRound[] = [];
  let code = 0;
  for (let round = 0; round < TRIAL_ROUNDS; round++) {
    const params = trialPlan(round, round === TRIAL_ROUNDS - 1);
    const bad = validateSimParams(params);
    if (bad) throw new Error(`the trial plan is invalid: ${bad}`);
    const job = makeSimJob(`trial-${tag}-${round}`, params, d.clock.now());
    d.log(`round ${round + 1}/${TRIAL_ROUNDS}: ${job.id}`);
    let result: SimResult | undefined;
    let failure: string | undefined;
    try {
      result = await run(d, job);
    } catch (err) {
      if (err instanceof IosAssert) {
        result = err.result;
        failure = err.message;
        code = 1;
      } else if (err instanceof IosUnavailable) {
        result = err.result;
        failure = `unavailable: ${err.message}`;
        code = 3;
      } else throw err;
    }
    const t = parseTrial(d.fs.read(join(d.dir, 'results', job.id, 'trial.jsonl')));
    rounds.push({ round, id: job.id, ...t, retried: retriedSteps(result), failure });
    if (code === 3) break;
  }
  for (const l of trialTable(tag, rounds)) d.log(l);
  return code;
}
