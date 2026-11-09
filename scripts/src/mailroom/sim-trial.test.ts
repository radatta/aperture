import { describe, expect, it } from 'vitest';
import { fakeClock } from '../bot/fakes.ts';
import { memFs } from './fakes.ts';
import {
  TRIAL_ROUNDS,
  TRIAL_WORDS,
  parseTrial,
  simTrial,
  summarise,
  trialPlan,
} from './sim-trial.ts';
import { IosAssert, IosUnavailable, VIAS, validateSimParams } from './sim.ts';
import type { SimJob, SimResult } from './sim.ts';

const HJ = '/repo/.hostjobs';
const viaOrder = (round: number) =>
  trialPlan(round, false)
    .steps.filter((s) => s.op === 'keys')
    .map((s) => ('via' in s ? s.via : null));

describe('trialPlan', () => {
  it('is a valid plan: every variant types the word and erases exactly its letters into the bar', () => {
    for (let r = 0; r < TRIAL_ROUNDS; r++) {
      const p = trialPlan(r, r === TRIAL_ROUNDS - 1);
      expect(validateSimParams(p)).toBeNull();
      expect(p.shutdown).toBe(r === TRIAL_ROUNDS - 1);
      const keys = p.steps.filter((s) => s.op === 'keys');
      const erases = p.steps.filter((s) => s.op === 'erase');
      expect(keys).toHaveLength(VIAS.length);
      for (const k of keys) expect(k).toMatchObject({ text: TRIAL_WORDS[r], in: 'bar' });
      for (const e of erases) expect(e).toMatchObject({ n: 6, in: 'bar' });
    }
  });
  it('rotates the order each round, so each variant takes every slot once', () => {
    expect(viaOrder(0)).toEqual([...VIAS]);
    expect(viaOrder(1)).toEqual([...VIAS.slice(1), VIAS[0]]);
    for (let slot = 0; slot < VIAS.length; slot++)
      expect(new Set(Array.from({ length: TRIAL_ROUNDS }, (_, r) => viaOrder(r)[slot]))).toEqual(
        new Set(VIAS),
      );
  });
  it('words are six distinct letters, no key twice in a row', () => {
    for (const w of TRIAL_WORDS) {
      expect(w).toMatch(/^[a-z]{6}$/);
      expect(new Set(w).size).toBe(6);
    }
  });
});

const line = (i: number, op: string, via: string, drops: number, sendMs = 1200) =>
  JSON.stringify({ i, op, via, n: 6, drops, sendMs });

describe('summarise', () => {
  it('sums taps and drops per variant, counts retried ops, medians ms per tap', () => {
    const t = parseTrial(
      [
        JSON.stringify({ load: { start: '{ 1.0 }', end: '{ 2.0 }' } }),
        line(7, 'keys', 'tap', 1, 1200),
        line(8, 'erase', 'tap', 0, 2400),
        line(9, 'keys', 'batch', 0, 600),
        '',
      ].join('\n'),
    );
    expect(t.load).toEqual({ start: '{ 1.0 }', end: '{ 2.0 }' });
    const rows = summarise([{ round: 0, id: 'x', ...t, retried: [7] }]);
    expect(rows.find((r) => r.via === 'tap')).toEqual({
      via: 'tap',
      taps: 12,
      drops: 1,
      retried: 1,
      msPerTap: 300,
    });
    expect(rows.find((r) => r.via === 'batch')).toMatchObject({ taps: 6, drops: 0, msPerTap: 100 });
    expect(rows.find((r) => r.via === 'hid')).toMatchObject({ taps: 0, msPerTap: null });
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

function harness(run: (job: SimJob, n: number) => SimResult | Error) {
  const fs = memFs([`${HJ}/inbox`]);
  const logs: string[] = [];
  const jobs: SimJob[] = [];
  const d = { fs, clock: fakeClock(), dir: HJ, log: (s: string) => logs.push(s) };
  const runner = async (_: unknown, job: SimJob) => {
    jobs.push(job);
    fs.mkdirp(`${HJ}/results/${job.id}`);
    fs.writeNew(`${HJ}/results/${job.id}/trial.jsonl`, `${line(7, 'keys', 'tap', 1)}\n`);
    const r = run(job, jobs.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { d, logs, jobs, runner };
}

describe('simTrial', () => {
  it('runs every round and prints each variant’s drops', async () => {
    const h = harness((job) => result(job));
    expect(await simTrial(h.d, 'idle', h.runner)).toBe(0);
    expect(h.jobs).toHaveLength(TRIAL_ROUNDS);
    expect(h.logs.join('\n')).toMatch(/^tap +30 +5 +16\.7/m);
  });
  it('a failed round is exit 1 and named in the table; later rounds still run', async () => {
    const h = harness((job, n) =>
      n === 2
        ? new IosAssert('ASSERT/TYPED at op 7 keys', result(job, { status: 'fail' }))
        : result(job),
    );
    expect(await simTrial(h.d, 'loaded', h.runner)).toBe(1);
    expect(h.jobs).toHaveLength(TRIAL_ROUNDS);
    expect(h.logs.join('\n')).toContain('FAILED: ASSERT/TYPED at op 7 keys');
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
    expect(h.jobs).toHaveLength(TRIAL_ROUNDS);
    expect(h.logs.join('\n')).toContain('FAILED: unavailable: SIM_UNAVAILABLE/AX_TIMEOUT');
  });
  it('an unavailable Mac stops the trial at exit 3, printing what ran', async () => {
    const h = harness((job, n) =>
      n === 2 ? new IosUnavailable('MAC_UNREACHABLE', 'no pickup') : result(job),
    );
    expect(await simTrial(h.d, 'idle', h.runner)).toBe(3);
    expect(h.jobs).toHaveLength(2);
    expect(h.logs.join('\n')).toMatch(/^tap +12 +2 /m);
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
  it('an unreadable line is counted, not skipped', () => {
    expect(parseTrial('{"load":{"start":"-","end":"-"}}\nnot json\n')).toMatchObject({
      bad: 1,
      lines: [],
    });
  });
  it('refuses a bad tag', async () => {
    const h = harness((job) => result(job));
    expect(await simTrial(h.d, 'Idle Mac', h.runner)).toBe(2);
    expect(h.jobs).toHaveLength(0);
  });
});
