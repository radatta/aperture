// `pnpm mailroom sim-trial --tag <t> [--round N] [--keys]`: the input-gap trial (docs/ops/IOS-CHECK.md → Input-gap
// trial). AXe can report a tap done that iOS never got (AXe issue 71: a new axe process can lose its first touch before
// the sim's input service is up). Each round is one sim job. By default it taps element after element, each after a
// pause, once per way of sending (`via`): the Home Screen icon, Bulk add and its Cancel, the capture bar, the mode
// row's Task and Log; and types a word into Bulk add's field and erases it, sent the same way. `--keys` runs the
// earlier trial instead: a word typed and erased per keys `via` (five of them) in the capture bar. The order rotates
// each round, so a change in the Mac's load lands on every variant alike; the runner's read-backs count the first try's
// drops into trial.jsonl, and this sums them per target and variant. No dev lock, no deploy, no dev writes. The
// read-backs still retry and fail as in a devcheck run, and a count the runner couldn't read is shown, never a zero.
import { join } from 'node:path';
import {
  IosAssert,
  IosUnavailable,
  TAP_VIAS,
  VIAS,
  makeSimJob,
  runSimJob,
  validateSimParams,
} from './sim.ts';
import type { IosOp, SimDeps, SimJob, SimParams, SimResult, TapVia, Via } from './sim.ts';

// Six distinct letters each, from all three rows, never one key twice in a row (a repeat can be coalesced: another failure).
export const TRIAL_WORDS = ['fjqmzt', 'wkbpxa', 'rhculd', 'ygvoes', 'nimwtk'] as const;
export const KEY_ROUNDS = TRIAL_WORDS.length;
export const TAP_ROUNDS = 6; // 6 taps per target and variant (12 for the mode row), ~40 min (a round ~6)
const TAG_RE = /^[a-z0-9-]{1,16}$/;

const at = <T>(xs: readonly T[], i: number): T => xs[i % xs.length] as T;
const rotate = <T>(xs: readonly T[], round: number): T[] => xs.map((_, k) => at(xs, k + round));

const BASE = { sha: '0'.repeat(40), timeoutSec: 600 } as const;

// The keys trial (2026-11-08): one word typed into the capture bar and erased, per keys variant.
export function keysPlan(round: number, last: boolean): SimParams {
  const word = at(TRIAL_WORDS, round);
  const steps: IosOp[] = [
    // no kill first: it fails when the app isn't running (a dropped icon tap, idle4). A sim left mid-typing by an
    // aborted round fails the next launch (LANDMARK): rerun that round with --round. Start the trial on a fresh sim.
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
    ...rotate(VIAS, round).flatMap((via): IosOp[] => [
      { op: 'keys', text: word, in: 'bar', via },
      { op: 'erase', n: word.length, in: 'bar', via },
    ]),
    { op: 'blur' },
  ];
  return { ...BASE, shutdown: last, steps };
}

// The mode row's scans, as devcheck/ios.ts's DOCK(x, MODE_ROW) (not imported: devcheck imports mailroom). A test pins
// them equal.
export const MODE_SCAN = (x: number) => ({ x, from: 315, to: 650 });
// Bulk add sits at the Tasks header's right (frame 318,212 102×34 in the stub app at 440×956); its dialog's Cancel at
// 205–283 × 648–685 with the keyboard down. The dialog focuses its field, and the keyboard can lift it, so Cancel's scan
// runs from well above. Both are first measured in headless Chromium; the smoke round is the proof.
export const BULK_ADD = { x: 369, from: 200, to: 260 };
export const BULK_CANCEL = { x: 244, from: 240, to: 690 };
export const BULK_FIELD_LABEL = 'Tasks, one per line';
export const BULK_FIELD = { x: 220, from: 300, to: 630 };

// One cycle per variant: every counted tap comes after a wait of 3 s or more and its own reads, 5–6 s with no touch,
// and the next cycle's launch presses Home itself. A cycle leaves Log on, the keyboard down and no dialog.
function tapCycle(via: TapVia, k: number, word: string): IosOp[] {
  const first = k === 0;
  const field = `bulk-${k}`;
  return [
    ...(first
      ? []
      : ([
          { op: 'launch', via },
          { op: 'nav', tab: 'Tasks' },
        ] as IosOp[])),
    { op: 'wait', s: 3 },
    // role AXButton: the dialog's heading starts with the same words
    { op: 'tap', label: 'Bulk add', scan: BULK_ADD, role: 'AXButton', closes: true, via },
    // Keys too, sent the same way (the done-form's dropped keys, 2026-11-08 to 11-15): the dialog's field, tapped so
    // the keyboard is surely up, then found once it has settled, so the read-back spot isn't a stale one. erase n =
    // the letters typed: each delete dropped is a letter left, counted. Cancel drops any leftover draft.
    { op: 'wait', s: 2 },
    { op: 'tap', label: BULK_FIELD_LABEL, scan: BULK_FIELD, role: 'AXTextArea' },
    { op: 'wait', s: 3 },
    { op: 'find', label: BULK_FIELD_LABEL, scan: BULK_FIELD, role: 'AXTextArea', as: field },
    { op: 'keys', text: word, in: field, via },
    { op: 'erase', n: word.length, in: field, via },
    // keyboard down first: it lifts the dialog (Cancel at y 445 up, 648 down), so Cancel is tapped where it rests
    { op: 'blur' },
    { op: 'wait', s: 4 },
    { op: 'tap', label: 'Cancel', scan: BULK_CANCEL, role: 'AXButton', closes: true, via },
    { op: 'wait', s: 4 },
    {
      op: 'tap',
      label: 'Capture',
      near: { x: 220, y: 895 },
      radius: 10,
      role: 'AXTextArea',
      via,
    },
    // 4 s: the dock settles after focus (PR 156); the stillness read before the tap covers a slower one
    { op: 'wait', s: 4 },
    {
      op: 'tap',
      label: 'Task',
      scan: MODE_SCAN(110),
      hint: { x: 96, y: 464 },
      role: 'AXCheckBox',
      selects: true,
      via,
    },
    { op: 'wait', s: 3 },
    { op: 'tap', label: 'Log', scan: MODE_SCAN(49), role: 'AXCheckBox', selects: true, via },
    { op: 'blur' },
  ];
}

export function tapPlan(round: number, last: boolean): SimParams {
  const order = rotate(TAP_VIAS, round);
  const steps: IosOp[] = [
    // the first launch's icon tap counts too; no kill (see keysPlan). Tasks: Bulk add lives in its header.
    { op: 'launch', via: order[0] as TapVia },
    { op: 'signIn' },
    { op: 'expect', signedIn: true },
    { op: 'nav', tab: 'Tasks' },
    ...order.flatMap((via, k) => tapCycle(via, k, at(TRIAL_WORDS, round))),
  ];
  return { ...BASE, shutdown: last, steps };
}

export type TrialKind = 'taps' | 'keys';
const PLANS = { taps: tapPlan, keys: keysPlan } as const;
const ROUNDS = { taps: TAP_ROUNDS, keys: KEY_ROUNDS } as const;

// A runner line: drops null is a read-back that couldn't tell, `un` says why (moving, moved, gone, already, notfield,
// unrecorded, or the op's failure).
interface TrialLine {
  i: number;
  op: 'keys' | 'erase' | 'tap' | 'launch';
  via: Via;
  n: number;
  drops: number | null;
  sendMs: number | null; // null: no tap went out (already, or a failure before it)
  un?: string;
}
// What a via step came to: counted, uncounted (why), or not run (the round ended before it).
export interface TrialCell {
  i: number;
  target: string;
  via: Via;
  n: number;
  drops: number | null;
  un?: string;
  sendMs: number | null;
}
export interface TrialRound {
  round: number;
  id: string;
  load: { start: string; end: string } | null;
  cells: TrialCell[];
  retried: number[]; // step indexes whose note says a read-back sent more (retyped, deleted … more, tapped again)
  bad: number; // lines that aren't a well-formed count, or a second line for one step
  failure?: string;
}
export interface TrialRow {
  target: string;
  via: Via;
  taps: number; // counted
  drops: number;
  uncounted: Record<string, number>;
  notRun: number;
  retried: number;
  msPerTap: number | null; // median over its sent ops
}

const OPS = ['keys', 'erase', 'tap', 'launch'];
const okLine = (o: Record<string, unknown>): boolean =>
  Number.isInteger(o.i) &&
  OPS.includes(o.op as string) &&
  typeof o.via === 'string' &&
  Number.isInteger(o.n) &&
  (o.n as number) >= 1 &&
  (typeof o.sendMs === 'number' || o.sendMs === null) &&
  ((Number.isInteger(o.drops) &&
    (o.drops as number) >= 0 &&
    (o.drops as number) <= (o.n as number)) ||
    (o.drops === null && typeof o.un === 'string' && o.un !== ''));

// bad: lines that aren't a well-formed count (a count it can't read is never a zero)
export function parseTrial(raw: string | null): {
  load: TrialRound['load'];
  lines: TrialLine[];
  bad: number;
} {
  const out = { load: null as TrialRound['load'], lines: [] as TrialLine[], bad: 0 };
  for (const l of (raw ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o.load && typeof o.load === 'object') out.load = o.load as TrialRound['load'];
      else if (okLine(o)) out.lines.push(o as unknown as TrialLine);
      else out.bad++;
    } catch {
      out.bad++;
    }
  }
  return out;
}

export const targetOf = (s: IosOp): string =>
  s.op === 'launch' ? 'icon' : s.op === 'tap' ? s.label : s.op;

const viaOf = (s: IosOp): Via | undefined =>
  'via' in s && typeof s.via === 'string' ? (s.via as Via) : undefined;

// The taps a via step's line stands for: 1 for a tap or launch, the letters for keys, the deletes for erase.
const nOf = (s: IosOp): number => (s.op === 'keys' ? s.text.length : s.op === 'erase' ? s.n : 1);

// Each via step of the plan gets its one line: none is not run (or its failure, when that step is where the round
// failed before the runner could write one), two (or a line for another op, variant or tap count) is bad. A
// `closes` zero rests on the element's absence at its spot; if the next step then can't find what it looks for, the
// page wasn't where the read assumed, so that zero is uncounted (unconfirmed).
export function joinTrial(
  steps: IosOp[],
  lines: TrialLine[],
  result?: SimResult,
): { cells: TrialCell[]; bad: number } {
  let bad = 0;
  const cells: TrialCell[] = [];
  const failed = (result?.steps ?? []).find((s) => s.status === 'fail' || s.status === 'error');
  steps.forEach((s, i) => {
    const via = viaOf(s);
    if (!via) return;
    const mine = lines.filter((l) => l.i === i);
    const target = targetOf(s);
    if (
      mine.length !== 1 ||
      mine[0]?.op !== s.op ||
      mine[0]?.via !== via ||
      mine[0]?.n !== nOf(s)
    ) {
      if (mine.length) bad += mine.length;
      const un = failed?.i === i ? (result?.detail ?? result?.reason ?? 'failed') : 'not run';
      cells.push({ i, target, via, n: 0, drops: null, un, sendMs: null });
      return;
    }
    const l = mine[0];
    const cell: TrialCell = { i, target, via, n: l.n, drops: l.drops, sendMs: l.sendMs };
    if (l.un) cell.un = l.un;
    const next = steps.findIndex((x, k) => k > i && x.op !== 'wait');
    if (
      s.op === 'tap' &&
      'closes' in s &&
      l.drops === 0 &&
      failed?.i === next &&
      result?.detail === 'MISS'
    ) {
      cell.drops = null;
      cell.un = 'unconfirmed';
    }
    cells.push(cell);
  });
  for (const l of lines) if (!steps[l.i] || !viaOf(steps[l.i] as IosOp)) bad++;
  return { cells, bad };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? at(s, m) : (at(s, m - 1) + at(s, m)) / 2);
};

export function summarise(rounds: TrialRound[]): TrialRow[] {
  const keyOf = (c: TrialCell) => `${c.target}\u0000${c.via}`;
  const seen: string[] = [];
  for (const r of rounds)
    for (const c of r.cells) if (!seen.includes(keyOf(c))) seen.push(keyOf(c));
  return seen.map((k) => {
    const [target, via] = k.split('\u0000') as [string, Via];
    const cs = rounds.flatMap((r) =>
      r.cells
        .filter((c) => keyOf(c) === k)
        .map((c) => ({ ...c, retried: r.retried.includes(c.i) })),
    );
    const counted = cs.filter((c) => c.drops !== null);
    const uncounted: Record<string, number> = {};
    for (const c of cs)
      if (c.drops === null && c.un !== 'not run')
        uncounted[c.un ?? '?'] = (uncounted[c.un ?? '?'] ?? 0) + 1;
    return {
      target,
      via,
      taps: counted.reduce((a, c) => a + c.n, 0),
      drops: counted.reduce((a, c) => a + (c.drops ?? 0), 0),
      uncounted,
      notRun: cs.filter((c) => c.un === 'not run').length,
      retried: cs.filter((c) => c.retried).length,
      msPerTap: median(
        cs.filter((c) => c.sendMs !== null).map((c) => (c.sendMs ?? 0) / (c.n || 1)),
      ),
    };
  });
}

const unText = (u: Record<string, number>) =>
  Object.entries(u)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ') || '-';

export function trialTable(tag: string, rounds: TrialRound[]): string[] {
  const rows = summarise(rounds);
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const pct = (d: number, t: number) => (t ? ((100 * d) / t).toFixed(1) : '-');
  const out = [
    `sim-trial ${tag}: ${rounds.length} round(s)`,
    `${pad('target', 13)}${pad('via', 9)}${pad('taps', 6)}${pad('drops', 7)}${pad('drop %', 8)}${pad('retried', 9)}${pad('ms/tap', 8)}uncounted / not run`,
    ...rows.map(
      (r) =>
        `${pad(r.target, 13)}${pad(r.via, 9)}${pad(r.taps, 6)}${pad(r.drops, 7)}${pad(pct(r.drops, r.taps), 8)}${pad(r.retried, 9)}${pad(r.msPerTap ?? '-', 8)}${unText(r.uncounted)}${r.notRun ? ` / ${r.notRun} not run` : ''}`,
    ),
    '(ms/tap is wall time: for keys the key reads too, for batch the 1 s lead)',
  ];
  // element taps and keys apart: a keys line is 6 taps, and would swamp the element taps' rate
  const typing = (r: TrialRow) => r.target === 'keys' || r.target === 'erase';
  for (const [what, inGroup] of [
    ['element taps', (r: TrialRow) => !typing(r)],
    ['keys + deletes', typing],
  ] as const)
    for (const v of [...new Set(rows.filter(inGroup).map((r) => r.via))]) {
      const rs = rows.filter((r) => r.via === v && inGroup(r));
      const t = rs.reduce((a, r) => a + r.taps, 0);
      const d = rs.reduce((a, r) => a + r.drops, 0);
      out.push(`  all ${v} ${what}: ${d} of ${t} dropped (${pct(d, t)} %)`);
    }
  for (const r of rounds)
    out.push(
      `  round ${r.round} ${r.id}: load ${r.load ? `${r.load.start} → ${r.load.end}` : 'unrecorded'}${r.bad ? `; ${r.bad} bad line(s)` : ''}${r.failure ? `; FAILED: ${r.failure}` : ''}`,
    );
  return out;
}

const retriedSteps = (r: SimResult | undefined) =>
  (r?.steps ?? [])
    .filter((s) => /retyped|deleted .*more|tapped again|icon tapped \d+ times/.test(s.note ?? ''))
    .map((s) => s.i);

// Exit 0: every round ran clean and every via step was counted; 1: a round failed, or a step was uncounted, not run or
// unreadable (its counts still show, and the table says which); 2: a bad --tag or --round; 3: the sim couldn't go on in
// a round (the rest still run) or the Mac never answered (the trial stops there; what ran is still printed). `only`
// reruns one round (its targets and order), for a round a load spike spoiled.
export async function simTrial(
  d: SimDeps,
  tag: string,
  run: (d: SimDeps, job: SimJob) => Promise<SimResult> = runSimJob,
  only?: number,
  kind: TrialKind = 'taps',
): Promise<number> {
  const total = ROUNDS[kind];
  if (!TAG_RE.test(tag)) {
    d.log('sim-trial needs --tag <a-z 0-9 ->, e.g. idle or loaded');
    return 2;
  }
  if (only !== undefined && !(Number.isInteger(only) && only >= 0 && only < total)) {
    d.log(`--round wants 0–${total - 1}`);
    return 2;
  }
  const rounds: TrialRound[] = [];
  let code = 0;
  let stop = false;
  for (let round = only ?? 0; round < (only ?? total - 1) + 1; round++) {
    const params = PLANS[kind](round, only !== undefined || round === total - 1);
    const bad = validateSimParams(params);
    if (bad) throw new Error(`the trial plan is invalid: ${bad}`);
    const job = makeSimJob(`trial-${tag}-${round}`, params, d.clock.now());
    d.log(`round ${round + 1}/${total}: ${job.id}`);
    let result: SimResult | undefined;
    let failure: string | undefined;
    try {
      result = await run(d, job);
    } catch (err) {
      if (err instanceof IosAssert) {
        result = err.result;
        failure = err.message;
        code = Math.max(code, 1);
      } else if (err instanceof IosUnavailable) {
        // the Mac ran the round and the sim couldn't go on (a hung read): the next round starts afresh. No result
        // at all (asleep, stalled) stops the trial.
        result = err.result;
        failure = `unavailable: ${err.message}`;
        code = 3;
        if (!result) stop = true;
      } else throw err;
    }
    const t = parseTrial(d.fs.read(join(d.dir, 'results', job.id, 'trial.jsonl')));
    const joined = joinTrial(params.steps, t.lines, result);
    const r: TrialRound = {
      round,
      id: job.id,
      load: t.load,
      cells: joined.cells,
      retried: retriedSteps(result),
      bad: t.bad + joined.bad,
      failure,
    };
    if (!failure && (r.bad || !t.lines.length)) {
      r.failure = r.bad ? `${r.bad} unreadable trial.jsonl line(s)` : 'no trial.jsonl lines';
      code = Math.max(code, 1);
    }
    rounds.push(r);
    if (stop) break;
  }
  for (const l of trialTable(tag, rounds)) d.log(l);
  const open = rounds.flatMap((r) => r.cells.filter((c) => c.drops === null));
  if (open.length) {
    d.log(
      `${open.length} step(s) not counted: ${unText(open.reduce<Record<string, number>>((a, c) => ({ ...a, [c.un ?? '?']: (a[c.un ?? '?'] ?? 0) + 1 }), {}))}`,
    );
    code = Math.max(code, 1);
  }
  // only a clean last round shuts the sim down
  if (code) d.log('the sim may still be booted: pnpm mailroom sim-shutdown');
  return code;
}
