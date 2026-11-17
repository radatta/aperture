import { describe, expect, it } from 'vitest';
import { fakeClock } from '../bot/fakes.ts';
import { DOCK, MODE_ROW } from '../devcheck/ios.ts';
import { memFs } from './fakes.ts';
import {
  KEY_ROUNDS,
  MODE_SCAN,
  TAP_ROUNDS,
  TRIAL_WORDS,
  joinTrial,
  keysPlan,
  parseTrial,
  simTrial,
  summarise,
  tapPlan,
  targetOf,
} from './sim-trial.ts';
import { IosAssert, IosUnavailable, TAP_VIAS, VIAS, validateSimParams } from './sim.ts';
import type { IosOp, SimJob, SimParams, SimResult } from './sim.ts';

const HJ = '/repo/.hostjobs';
const viaSteps = (p: SimParams) =>
  p.steps.map((s, i) => ({ s, i })).filter(({ s }) => 'via' in s && s.via !== undefined);
const viaOf = (s: IosOp) => ('via' in s ? s.via : undefined);

describe('tapPlan', () => {
  it('is a valid plan of every target once per variant, each tap after a wait of 3 s or more', () => {
    for (let r = 0; r < TAP_ROUNDS; r++) {
      const p = tapPlan(r, r === TAP_ROUNDS - 1);
      expect(validateSimParams(p)).toBeNull();
      expect(p.steps.length).toBeLessThanOrEqual(80);
      expect(p.shutdown).toBe(r === TAP_ROUNDS - 1);
      expect(p.steps[0]).toMatchObject({ op: 'launch' });
      const vs = viaSteps(p);
      for (const v of TAP_VIAS)
        expect(vs.filter(({ s }) => viaOf(s) === v).map(({ s }) => targetOf(s))).toEqual([
          'icon',
          'Bulk add',
          'keys',
          'erase',
          'Cancel',
          'Capture',
          'Task',
          'Log',
        ]);
      for (const { s, i } of vs) {
        if (s.op !== 'tap') continue;
        const w = p.steps[i - 1];
        expect(w?.op === 'wait' && w.s >= 3).toBe(true);
      }
    }
  });
  it("types the round's word into Bulk add's field, found after it settled, and erases exactly its letters", () => {
    for (let r = 0; r < TAP_ROUNDS; r++) {
      const p = tapPlan(r, false);
      const keys = p.steps.flatMap((s, i) => (s.op === 'keys' ? [{ s, i }] : []));
      expect(keys).toHaveLength(TAP_VIAS.length);
      for (const { s, i } of keys) {
        expect(s.text).toBe(TRIAL_WORDS[r % TRIAL_WORDS.length]);
        expect(p.steps[i - 1]).toMatchObject({
          op: 'find',
          label: 'Tasks, one per line',
          as: s.in,
        });
        expect(p.steps[i - 2]).toMatchObject({ op: 'wait' });
        expect(p.steps[i + 1]).toMatchObject({
          op: 'erase',
          n: s.text.length,
          in: s.in,
          via: s.via,
        });
        expect(p.steps[i + 2]).toEqual({ op: 'blur' }); // Cancel is tapped with the keyboard down
      }
    }
  });
  it('every counted tap has its read-back: closes, selects or a field', () => {
    for (const { s } of viaSteps(tapPlan(0, false)))
      if (s.op === 'tap')
        expect(s.closes === true || s.selects === true || s.role === 'AXTextArea').toBe(true);
  });
  it('rotates the variants, so each takes every slot twice', () => {
    const order = (r: number) =>
      viaSteps(tapPlan(r, false))
        .filter(({ s }) => s.op === 'launch')
        .map(({ s }) => viaOf(s));
    expect(order(0)).toEqual([...TAP_VIAS]);
    expect(order(1)).toEqual([...TAP_VIAS.slice(1), TAP_VIAS[0]]);
    for (let slot = 0; slot < TAP_VIAS.length; slot++)
      for (const v of TAP_VIAS)
        expect(
          Array.from({ length: TAP_ROUNDS }, (_, r) => order(r)[slot]).filter((x) => x === v),
        ).toHaveLength(2);
  });
  it("the mode row's scans are the devcheck's DOCK(x, MODE_ROW)", () => {
    expect(MODE_SCAN(110)).toEqual(DOCK(110, MODE_ROW));
    expect(MODE_SCAN(49)).toEqual(DOCK(49, MODE_ROW));
  });
});

describe('keysPlan (--keys)', () => {
  it('is the keys trial: every variant types the word and erases exactly its letters into the bar', () => {
    for (let r = 0; r < KEY_ROUNDS; r++) {
      const p = keysPlan(r, r === KEY_ROUNDS - 1);
      expect(validateSimParams(p)).toBeNull();
      expect(p.steps[0]).toEqual({ op: 'launch' });
      const keys = p.steps.filter((s) => s.op === 'keys');
      expect(keys).toHaveLength(VIAS.length);
      for (const k of keys) expect(k).toMatchObject({ text: TRIAL_WORDS[r], in: 'bar' });
      for (const e of p.steps.filter((s) => s.op === 'erase'))
        expect(e).toMatchObject({ n: 6, in: 'bar' });
    }
    expect(
      keysPlan(1, false)
        .steps.filter((s) => s.op === 'keys')
        .map(viaOf),
    ).toEqual([...VIAS.slice(1), VIAS[0]]);
  });
  it('words are six distinct letters, no key twice in a row', () => {
    for (const w of TRIAL_WORDS) {
      expect(w).toMatch(/^[a-z]{6}$/);
      expect(new Set(w).size).toBe(6);
    }
  });
});

// The runner's lines for a plan: one per via step, its drops from `drops(target, via)`.
const linesFor = (
  p: SimParams,
  drops: (target: string, via: string) => number | null | 'skip' = () => 0,
) =>
  viaSteps(p)
    .map(({ s, i }) => {
      const d = drops(targetOf(s), viaOf(s) as string);
      if (d === 'skip') return '';
      const n = s.op === 'keys' ? s.text.length : s.op === 'erase' ? s.n : 1;
      return JSON.stringify({
        i,
        op: s.op,
        via: viaOf(s),
        n,
        drops: d,
        sendMs: 300 * n,
        ...(d === null ? { un: 'moving' } : {}),
      });
    })
    .filter(Boolean)
    .join('\n');

describe('parseTrial', () => {
  it('keeps the load and well-formed lines; anything else is bad, never a zero', () => {
    const t = parseTrial(
      [
        JSON.stringify({ load: { start: '{ 1.0 }', end: '{ 2.0 }' } }),
        JSON.stringify({ i: 4, op: 'tap', via: 'hid', n: 1, drops: 1, sendMs: 900 }),
        JSON.stringify({
          i: 5,
          op: 'tap',
          via: 'hid',
          n: 1,
          drops: null,
          sendMs: 900,
          un: 'moved',
        }),
        JSON.stringify({ i: 6, op: 'tap', via: 'hid', n: 1, drops: null, sendMs: 900 }), // null with no reason
        JSON.stringify({ i: 7, op: 'tap', via: 'hid', n: 1, sendMs: 900 }), // no drops at all
        JSON.stringify({ i: 8, op: 'keys', via: 'tap', n: 6, drops: 7, sendMs: 900 }), // more than it sent
        '{}',
        'not json',
        '',
      ].join('\n'),
    );
    expect(t.load).toEqual({ start: '{ 1.0 }', end: '{ 2.0 }' });
    expect(t.lines.map((l) => l.i)).toEqual([4, 5]);
    expect(t.bad).toBe(5);
  });
});

describe('joinTrial', () => {
  const p = tapPlan(0, false);
  const vs = viaSteps(p);
  it('gives every via step its one line; a missing one is not run, a second one bad', () => {
    const all = parseTrial(linesFor(p)).lines;
    expect(joinTrial(p.steps, all)).toMatchObject({ bad: 0 });
    expect(joinTrial(p.steps, all).cells).toHaveLength(vs.length);
    const first = vs[0]?.i ?? -1;
    const missing = joinTrial(
      p.steps,
      all.filter((l) => l.i !== first),
    );
    expect(missing.cells.find((c) => c.i === first)).toMatchObject({ drops: null, un: 'not run' });
    const twice = joinTrial(p.steps, [...all, ...all.filter((l) => l.i === first)]);
    expect(twice.bad).toBe(2);
    expect(twice.cells.find((c) => c.i === first)).toMatchObject({ un: 'not run' });
    // a line for a step with no via, or for another variant, is bad
    expect(joinTrial(p.steps, [...all, { ...all[0]!, i: 1 }]).bad).toBe(1);
    expect(
      joinTrial(p.steps, [{ ...all[0]!, via: 'batch15' }, ...all.slice(1)]).cells[0],
    ).toMatchObject({ un: 'not run' });
  });
  it("a closes zero is unconfirmed when the next step can't find what it looks for", () => {
    const all = parseTrial(linesFor(p)).lines;
    const bulk = vs.find(({ s }) => targetOf(s) === 'Bulk add')?.i ?? -1;
    const next = p.steps.findIndex((s, k) => k > bulk && s.op !== 'wait');
    const res = {
      detail: 'MISS',
      steps: [{ i: next, op: 'tap', status: 'fail', ms: 1 }],
    } as unknown as SimResult;
    expect(joinTrial(p.steps, all, res).cells.find((c) => c.i === bulk)).toMatchObject({
      drops: null,
      un: 'unconfirmed',
    });
    // any other failure leaves it counted
    expect(
      joinTrial(p.steps, all, { ...res, detail: 'TAP_DROPPED' }).cells.find((c) => c.i === bulk),
    ).toMatchObject({ drops: 0 });
  });
});

describe('summarise', () => {
  it('sums per target and variant, keeps uncounted and not-run apart, medians ms per tap', () => {
    const p = tapPlan(0, false);
    const t = parseTrial(
      linesFor(p, (target, via) =>
        target === 'icon' && via === 'tap'
          ? 1
          : target === 'Task' && via === 'hid'
            ? null
            : target === 'Log' && via === 'batch'
              ? 'skip'
              : 0,
      ),
    );
    const { cells } = joinTrial(p.steps, t.lines);
    const iconTap = viaSteps(p).find(({ s }) => s.op === 'launch' && viaOf(s) === 'tap')?.i ?? -1;
    const rows = summarise([{ round: 0, id: 'x', load: null, cells, retried: [iconTap], bad: 0 }]);
    expect(rows.find((r) => r.target === 'icon' && r.via === 'tap')).toEqual({
      target: 'icon',
      via: 'tap',
      taps: 1,
      drops: 1,
      uncounted: {},
      notRun: 0,
      retried: 1,
      msPerTap: 300,
    });
    expect(rows.find((r) => r.target === 'Task' && r.via === 'hid')).toMatchObject({
      taps: 0,
      uncounted: { moving: 1 },
    });
    expect(rows.find((r) => r.target === 'Log' && r.via === 'batch')).toMatchObject({
      taps: 0,
      notRun: 1,
      msPerTap: null,
    });
    expect(rows).toHaveLength(8 * TAP_VIAS.length);
  });
});

const result = (job: SimJob, r: Partial<SimResult> = {}): SimResult => ({
  v: 1,
  id: job.id,
  job: 'sim',
  status: 'pass',
  reason: null,
  startedAt: '',
  finishedAt: '',
  durationMs: 1,
  runnerVersion: 'v',
  ...r,
});

function harness(
  run: (job: SimJob, n: number) => SimResult | Error,
  drops: Parameters<typeof linesFor>[1] = (t, v) => (t === 'icon' && v === 'tap' ? 1 : 0),
) {
  const fs = memFs([`${HJ}/inbox`]);
  const logs: string[] = [];
  const jobs: SimJob[] = [];
  const d = { fs, clock: fakeClock(), dir: HJ, log: (s: string) => logs.push(s) };
  const runner = async (_: unknown, job: SimJob) => {
    jobs.push(job);
    fs.mkdirp(`${HJ}/results/${job.id}`);
    fs.writeNew(`${HJ}/results/${job.id}/trial.jsonl`, `${linesFor(job.params, drops)}\n`);
    const r = run(job, jobs.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { d, logs, jobs, runner };
}

describe('simTrial', () => {
  it('runs every round of the tap plan and prints each target and variant', async () => {
    const h = harness((job) => result(job));
    expect(await simTrial(h.d, 'idle', h.runner)).toBe(0);
    expect(h.jobs).toHaveLength(TAP_ROUNDS);
    expect(h.jobs[0]?.params).toEqual(tapPlan(0, false));
    const out = h.logs.join('\n');
    expect(out).toMatch(/^icon +tap +6 +6 +100\.0/m);
    expect(out).toMatch(/^Log +batch +6 +0 +0\.0/m);
    expect(out).toContain('all tap element taps: 6 of 36 dropped');
    expect(out).toContain('all tap keys + deletes: 0 of 72 dropped');
  });
  it('--keys runs the keys plan', async () => {
    const h = harness(
      (job) => result(job),
      () => 0,
    );
    expect(await simTrial(h.d, 'k', h.runner, undefined, 'keys')).toBe(0);
    expect(h.jobs).toHaveLength(KEY_ROUNDS);
    expect(h.jobs[2]?.params).toEqual(keysPlan(2, false));
    expect(h.logs.join('\n')).toMatch(/^keys +post +30 +0 /m);
  });
  it('an uncounted or not-run step is exit 1, named, never folded into the counts', async () => {
    const h = harness(
      (job) => result(job),
      (t, v) => (t === 'Task' && v === 'hid' ? null : t === 'Log' && v === 'tap' ? 'skip' : 0),
    );
    expect(await simTrial(h.d, 'idle', h.runner)).toBe(1);
    const out = h.logs.join('\n');
    expect(out).toMatch(/^Task +hid +0 +0 +- .*6 moving/m);
    expect(out).toMatch(/^Log +tap +0 .*6 not run/m);
    expect(out).toContain('12 step(s) not counted: 6 not run, 6 moving');
  });
  it('a failed round is exit 1 and named in the table; later rounds still run', async () => {
    const h = harness((job, n) =>
      n === 2
        ? new IosAssert('ASSERT/TAP_DROPPED at op 7 tap', result(job, { status: 'fail' }))
        : result(job),
    );
    expect(await simTrial(h.d, 'loaded', h.runner)).toBe(1);
    expect(h.jobs).toHaveLength(TAP_ROUNDS);
    expect(h.logs.join('\n')).toContain('FAILED: ASSERT/TAP_DROPPED at op 7 tap');
  });
  it("a round the sim couldn't finish (a hung read) is exit 3, and the later rounds still run", async () => {
    const h = harness((job, n) =>
      n === 2
        ? new IosUnavailable(
            'SIM_UNAVAILABLE/AX_TIMEOUT',
            'hung',
            'v',
            result(job, { status: 'error' }),
          )
        : result(job),
    );
    expect(await simTrial(h.d, 'idle', h.runner)).toBe(3);
    expect(h.jobs).toHaveLength(TAP_ROUNDS);
    expect(h.logs.join('\n')).toContain('FAILED: unavailable: SIM_UNAVAILABLE/AX_TIMEOUT');
  });
  it('an unavailable Mac stops the trial at exit 3, printing what ran', async () => {
    const h = harness((job, n) =>
      n === 2 ? new IosUnavailable('MAC_UNREACHABLE', 'no pickup') : result(job),
    );
    expect(await simTrial(h.d, 'idle', h.runner)).toBe(3);
    expect(h.jobs).toHaveLength(2);
    expect(h.logs.join('\n')).toMatch(/^icon +tap +2 +2 /m);
  });
  it('a round with no readable count is exit 1, never a zero', async () => {
    const h = harness((job) => result(job));
    const runner = async (_: unknown, job: SimJob) => {
      const r = await h.runner(_, job);
      if (h.jobs.length === 3) h.d.fs.rename(`${HJ}/results/${job.id}/trial.jsonl`, `${HJ}/gone`);
      return r;
    };
    expect(await simTrial(h.d, 'idle', runner)).toBe(1);
    expect(h.logs.join('\n')).toContain('FAILED: no trial.jsonl lines');
    expect(h.logs.join('\n')).toContain('sim-shutdown');
  });
  it('--round reruns just that round, its targets and order, then shuts down', async () => {
    const h = harness((job) => result(job));
    expect(await simTrial(h.d, 'idle2b', h.runner, 2)).toBe(0);
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]?.params).toEqual(tapPlan(2, true));
    expect(await simTrial(h.d, 'x', h.runner, TAP_ROUNDS)).toBe(2);
    expect(await simTrial(h.d, 'x', h.runner, KEY_ROUNDS, 'keys')).toBe(2);
  });
  it('refuses a bad tag', async () => {
    const h = harness((job) => result(job));
    expect(await simTrial(h.d, 'Idle Mac', h.runner)).toBe(2);
    expect(h.jobs).toHaveLength(0);
  });
});
