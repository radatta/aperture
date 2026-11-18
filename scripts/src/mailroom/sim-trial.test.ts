import { describe, expect, it } from 'vitest';
import { fakeClock } from '../bot/fakes.ts';
import { DOCK, MODE_ROW } from '../devcheck/ios.ts';
import { memFs } from './fakes.ts';
import {
  ICON_LAUNCHES,
  ICON_ROUNDS,
  iconPlan,
  tapSummary,
  tapTable,
  KEY_ROUNDS,
  MODE_SCAN,
  TAP_ROUNDS,
  TRIAL_WORDS,
  joinTrial,
  keysPlan,
  parseTrial,
  simTrial,
  summarise,
  SWITCHER_KILLS,
  SWITCHER_ROUNDS,
  parseKillNote,
  switcherPlan,
  switcherTrial,
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
        expect(p.steps[i + 1]).toEqual({ op: 'erase', n: s.text.length, in: s.in, via: s.via }); // counted: a field holding text is recognised
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
    // a keys line claiming another tap count is bad, not summed
    const keysAt = vs.find(({ s }) => s.op === 'keys')?.i ?? -1;
    const wrongN = all.map((l) => (l.i === keysAt ? { ...l, n: 60 } : l));
    expect(joinTrial(p.steps, wrongN)).toMatchObject({ bad: 1 });
    expect(joinTrial(p.steps, wrongN).cells.find((c) => c.i === keysAt)).toMatchObject({
      drops: null,
      n: 0,
    });
  });
  it('a step with no line where the round failed carries that failure, not "not run"', () => {
    const all = parseTrial(linesFor(p)).lines;
    const keysAt = vs.find(({ s }) => s.op === 'keys')?.i ?? -1;
    const res = {
      detail: 'KEYBOARD_SETUP',
      steps: [{ i: keysAt, op: 'keys', status: 'error', ms: 1 }],
    } as unknown as SimResult;
    const cells = joinTrial(
      p.steps,
      all.filter((l) => l.i < keysAt),
      res,
    ).cells;
    expect(cells.find((c) => c.i === keysAt)).toMatchObject({ drops: null, un: 'KEYBOARD_SETUP' });
    expect(cells.filter((c) => c.i > keysAt).every((c) => c.un === 'not run')).toBe(true);
  });
  it('a line with no time (no tap went out) parses, and stays out of ms per tap', () => {
    const t = parseTrial(
      JSON.stringify({ i: 5, op: 'tap', via: 'tap', n: 1, drops: null, sendMs: null, un: 'MISS' }),
    );
    expect(t).toMatchObject({ bad: 0 });
    const rows = summarise([
      {
        round: 0,
        id: 'x',
        load: null,
        cells: joinTrial(p.steps, t.lines).cells,
        retried: [],
        bad: 0,
      },
    ]);
    expect(rows.find((r) => r.target === 'Bulk add' && r.via === 'tap')).toMatchObject({
      uncounted: { MISS: 1 },
      msPerTap: null,
    });
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

describe('iconPlan (--icon)', () => {
  it('is ten trial launches a job, settle alternating 1 and 3, the first arm flipped each round', () => {
    for (let r = 0; r < ICON_ROUNDS; r++) {
      const p = iconPlan(r, r === ICON_ROUNDS - 1);
      expect(validateSimParams(p)).toBeNull();
      expect(p.shutdown).toBe(r === ICON_ROUNDS - 1);
      const ls = p.steps.filter((s) => s.op === 'launch');
      expect(ls).toHaveLength(ICON_LAUNCHES);
      expect(p.steps.filter((s) => s.op === 'signIn')).toHaveLength(0);
      const settles = ls.map((s) => (s.op === 'launch' ? s.settle : 0));
      expect(settles[0]).toBe(r % 2 ? 3 : 1);
      for (let k = 1; k < settles.length; k++) expect(settles[k]).not.toBe(settles[k - 1]);
      for (const s of ls) expect(s).toMatchObject({ via: 'tap' });
      p.steps.forEach((s, i) => {
        if (s.op === 'launch' && i) expect(p.steps[i - 1]).toEqual({ op: 'wait', s: 3 });
      });
    }
    // across the trial, each arm gets the same count
    const all = Array.from({ length: ICON_ROUNDS }, (_, r) => iconPlan(r, false).steps).flat();
    expect(all.filter((s) => s.op === 'launch' && s.settle === 1)).toHaveLength(30);
    expect(all.filter((s) => s.op === 'launch' && s.settle === 3)).toHaveLength(30);
  });
});

describe('the icon attribution', () => {
  const p = iconPlan(0, false);
  const launches = p.steps.flatMap((s, i) => (s.op === 'launch' ? [{ s, i }] : []));
  // one line per launch: the first tap dropped where `drop(k)`, the retap landed; hid per tap from `hid(k, tap)`
  const raw = (
    hdr: object | null,
    drop: (k: number) => boolean,
    hid: (k: number, t: number) => number | null,
  ) =>
    [
      JSON.stringify({ load: { start: '-', end: '-' }, ...(hdr ? { hid: hdr } : {}) }),
      ...launches.map(({ s, i }, k) =>
        JSON.stringify({
          i,
          op: 'launch',
          via: 'tap',
          n: 1,
          drops: drop(k) ? 1 : 0,
          sendMs: 20,
          settle: s.op === 'launch' ? s.settle : 1,
          taps: drop(k)
            ? [
                { d: 1, hid: hid(k, 0) },
                { d: 0, hid: hid(k, 1), frontMs: 1500 },
              ]
            : [{ d: 0, hid: hid(k, 0), frontMs: 1200 }],
          hidOther: 0,
        }),
      ),
    ].join('\n');
  const round = (text: string) => {
    const t = parseTrial(text);
    return {
      round: 0,
      id: 'x',
      load: t.load,
      hid: t.hid,
      cells: joinTrial(p.steps, t.lines).cells,
      retried: [],
      bad: t.bad,
    };
  };
  it('attributes each dropped tap: no service, no such line, unread', () => {
    const r = round(
      raw(
        { ok: true, lines: 40, noSvc: 1 },
        (k) => k < 3,
        (k, t) => (k === 0 && t === 0 ? 1 : 0),
      ),
    );
    expect(r.bad).toBe(0);
    const s = tapSummary([r]);
    const s1 = s.find((x) => x.target === 'icon s1');
    const s3 = s.find((x) => x.target === 'icon s3');
    // launches 0 and 2 are s1, 1 is s3: drops at k 0, 1, 2
    expect(s1).toMatchObject({
      sent: 7,
      landed: 5,
      dropped: 2,
      noService: 1,
      noSuchLine: 1,
      unproven: 0,
      unread: 0,
      frontMs: 1200,
    });
    expect(s3).toMatchObject({ sent: 6, dropped: 1, noService: 0, noSuchLine: 1 });
    const out = tapTable([r]).join('\n');
    expect(out).toMatch(/^icon s1 +7 +5 +0 +2 +0 +1200 +1 \/ 1 \/ 0 \/ 0/m); // (no-svc) 0: the control
    expect(out).toContain('round 0 capture: ok, 40 dtuhidd line(s), 1 no-service');
  });
  it('a zero from a capture that never heard dtuhidd is unproven, never "no such line"', () => {
    const s = tapSummary([
      round(
        raw(
          { ok: true, lines: 0, noSvc: 0 },
          (k) => k === 0,
          () => 0,
        ),
      ),
    ]);
    expect(s.find((x) => x.target === 'icon s1')).toMatchObject({
      dropped: 1,
      noSuchLine: 0,
      unproven: 1,
    });
  });
  it('a capture that died leaves the drops unread', () => {
    const r = round(
      raw(
        { ok: false, why: 'died', lines: 0, noSvc: 0 },
        (k) => k === 0,
        () => null,
      ),
    );
    expect(tapSummary([r]).find((x) => x.target === 'icon s1')).toMatchObject({ unread: 1 });
    expect(tapTable([r]).join('\n')).toContain('capture: not trusted (died)');
  });
  it('strict lines: a malformed tap record, a bad settle or a header without why is bad', () => {
    const base = { i: 0, op: 'launch', via: 'tap', n: 1, drops: 0, sendMs: 1, settle: 1 };
    const bad = (o: object) => parseTrial(JSON.stringify(o)).bad;
    expect(bad({ ...base, taps: [{ d: 0, hid: 0 }] })).toBe(0);
    expect(bad({ ...base, taps: [{ d: 2, hid: 0 }] })).toBe(1);
    expect(bad({ ...base, taps: [{ d: 0, hid: -1 }] })).toBe(1);
    expect(bad({ ...base, taps: [{ d: 0, hid: 0, note: 'x' }] })).toBe(1);
    expect(bad({ ...base, taps: [] })).toBe(1);
    expect(bad({ ...base, settle: 9 })).toBe(1);
    expect(bad({ ...base, hidOther: -2 })).toBe(1);
    expect(bad({ load: { start: '-', end: '-' }, hid: { ok: false, lines: 0, noSvc: 0 } })).toBe(1);
    // a line whose settle isn't its step's is not that step's line
    const shifted = parseTrial(
      raw(
        null,
        () => false,
        () => 0,
      ).replace('"settle":1', '"settle":3'),
    ).lines;
    expect(joinTrial(p.steps, shifted).bad).toBe(1);
  });
});

describe('simTrial --icon', () => {
  it('runs the icon plan and exits 1 when a drop has no trustworthy cause', async () => {
    const fs = memFs([`${HJ}/inbox`]);
    const logs: string[] = [];
    const jobs: SimJob[] = [];
    const d = { fs, clock: fakeClock(), dir: HJ, log: (s: string) => logs.push(s) };
    const write = (job: SimJob, hdr: object) => {
      fs.mkdirp(`${HJ}/results/${job.id}`);
      const lines = job.params.steps.flatMap((s, i) =>
        s.op === 'launch'
          ? [
              JSON.stringify({
                i,
                op: 'launch',
                via: 'tap',
                n: 1,
                drops: i === 0 ? 1 : 0,
                sendMs: 9,
                settle: s.settle,
                taps:
                  i === 0
                    ? [
                        { d: 1, hid: 0 },
                        { d: 0, hid: 0, frontMs: 900 },
                      ]
                    : [{ d: 0, hid: 0, frontMs: 800 }],
                hidOther: 0,
              }),
            ]
          : [],
      );
      fs.writeNew(
        `${HJ}/results/${job.id}/trial.jsonl`,
        [JSON.stringify({ load: { start: '-', end: '-' }, hid: hdr }), ...lines].join('\n'),
      );
    };
    const runner = (hdr: object) => async (_: unknown, job: SimJob) => {
      jobs.push(job);
      write(job, hdr);
      return result(job);
    };
    // a capture that heard dtuhidd: every drop attributed, exit 0
    expect(
      await simTrial(d, 'icon', runner({ ok: true, lines: 12, noSvc: 0 }), undefined, 'icon'),
    ).toBe(0);
    expect(jobs[0]?.params).toEqual(iconPlan(0, false));
    expect(logs.join('\n')).toContain('every icon tap');
    // one that never did: the drops are unproven, exit 1
    logs.length = 0;
    expect(
      await simTrial(d, 'icon2', runner({ ok: true, lines: 0, noSvc: 0 }), undefined, 'icon'),
    ).toBe(1);
    expect(logs.join('\n')).toContain('without a trustworthy cause');
  });
});

describe('switcherPlan (--switcher)', () => {
  it('is a valid plan: signed in, then each kill followed by a launch and the signed-in check', () => {
    const p = switcherPlan(true);
    expect(validateSimParams(p)).toBeNull();
    expect(p.shutdown).toBe(true);
    expect(switcherPlan(false).shutdown).toBe(false);
    expect(p.steps.slice(0, 2)).toEqual([{ op: 'launch' }, { op: 'signIn' }]);
    const kills = p.steps.flatMap((s, i) => (s.op === 'kill' ? [i] : []));
    expect(kills).toHaveLength(SWITCHER_KILLS);
    for (const i of kills) {
      expect(p.steps[i]).toEqual({ op: 'kill', method: 'switcher' });
      expect(p.steps.slice(i + 1, i + 3)).toEqual([
        { op: 'launch' },
        { op: 'expect', signedIn: true },
      ]);
    }
  });
});

describe('parseKillNote', () => {
  it('reads every swipe of a kill note, in order', () => {
    expect(
      parseKillNote(
        'killed by switcher; web: gone; card 239,136 306x664 r2; s1 flick 339,600 alive>sw; s2 lead 339,600 gone@0.5',
      ),
    ).toEqual([
      { rung: 1, name: 'flick', killed: false },
      { rung: 2, name: 'lead', killed: true },
    ]);
  });
  it('reads a fallback aim, a swipe that left the switcher, and a late kill', () => {
    expect(
      parseKillNote('; s1 flick 340,560 frame? alive>app; s2 lead 339,600 alive>sw; late'),
    ).toEqual([
      { rung: 1, name: 'flick', killed: false },
      { rung: 2, name: 'lead', killed: true },
    ]);
  });
  it('is empty for a kill that never swiped', () => {
    expect(
      parseKillNote("the app switcher didn't kill the app; the switcher didn't open (Web)"),
    ).toEqual([]);
    expect(parseKillNote('killed by terminate; web: gone')).toEqual([]);
  });
});

describe('switcherTrial', () => {
  const kill = (i: number, status: 'pass' | 'fail' | 'error' | 'skipped', note?: string) => ({
    i,
    op: 'kill',
    status,
    ms: 1,
    ...(note ? { note } : {}),
  });
  const setup = () => {
    const fs = memFs([`${HJ}/inbox`]);
    const logs: string[] = [];
    const jobs: SimJob[] = [];
    const d = { fs, clock: fakeClock(), dir: HJ, log: (s: string) => logs.push(s) };
    return { d, logs, jobs };
  };
  it('tallies each rung across rounds; a clean trial exits 0', async () => {
    const { d, logs, jobs } = setup();
    const runner = async (_: unknown, job: SimJob) => {
      jobs.push(job);
      return result(job, {
        steps: [
          kill(
            2,
            'pass',
            'killed by switcher; web: gone; card 239,136 306x664 r2; s1 flick 339,600 gone@0',
          ),
          kill(
            5,
            'pass',
            'killed by switcher; web: gone; s1 flick 339,600 alive>sw; s2 lead 339,600 gone@0',
          ),
        ],
      });
    };
    expect(await switcherTrial(d, 'quiet', runner)).toBe(0);
    expect(jobs).toHaveLength(SWITCHER_ROUNDS);
    expect(jobs.map((j) => j.params.shutdown)).toEqual([false, false, false, true]);
    const out = logs.join('\n');
    expect(out).toContain('8 of 8 kills passed (100%); 0 failed before any swipe; 0 errored');
    expect(out).toMatch(/1 flick\s+8\s+4\s+50%/);
    expect(out).toMatch(/2 lead\s+4\s+4\s+100%/);
    expect(out).not.toContain('predates');
  });
  it('counts a failed kill and its swipes, and exits 1; a kill that never swiped is counted apart', async () => {
    const { d, logs } = setup();
    const failed = result({ id: 'x' } as SimJob, {
      status: 'error',
      reason: 'SIM_UNAVAILABLE',
      steps: [
        kill(
          2,
          'error',
          "the switcher swipe didn't kill the app; s1 flick 339,600 alive>sw; s2 lead 339,600 alive>sw; s3 drag 339,720 alive>sw",
        ),
        kill(5, 'skipped'),
      ],
    });
    const hung = result({ id: 'w' } as SimJob, {
      status: 'error',
      steps: [kill(2, 'error', 'a point read timed out reading the switcher card')],
    });
    const dropped = result({ id: 'y' } as SimJob, {
      status: 'fail',
      steps: [
        kill(2, 'fail', "the app switcher didn't kill the app; the switcher didn't open (Web)"),
      ],
    });
    let n = 0;
    const runner = async () => {
      n++;
      if (n === 1) throw new IosUnavailable('SIM_UNAVAILABLE', 'SWITCHER_FAILED', 'v', failed);
      if (n === 2) throw new IosAssert('SWITCHER_FAILED', dropped);
      if (n === 3) throw new IosUnavailable('SIM_UNAVAILABLE', 'AX_TIMEOUT', 'v', hung);
      return result({ id: 'z' } as SimJob, { steps: [] });
    };
    expect(await switcherTrial(d, 'loaded', runner)).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('0 of 3 kills passed (0%); 1 failed before any swipe; 1 errored');
    expect(out).toMatch(/3 drag\s+1\s+0\s+0%/);
    expect(out).toContain('pnpm mailroom sim-shutdown');
  });
  it('stops at a Mac that never answered (exit 3), and refuses a bad tag or round (exit 2)', async () => {
    const { d, logs } = setup();
    let n = 0;
    const runner = async () => {
      n++;
      throw new IosUnavailable('MAC_UNREACHABLE', 'no pickup');
    };
    expect(await switcherTrial(d, 'asleep', runner)).toBe(3);
    expect(n).toBe(1);
    expect(logs.join('\n')).toContain('0 of 0 kills passed');
    expect(await switcherTrial(d, 'Bad Tag', runner)).toBe(2);
    expect(await switcherTrial(d, 'x', runner, SWITCHER_ROUNDS)).toBe(2);
    expect(n).toBe(1);
  });
  it('a passed kill with no swipe in its note is a runner that predates the ladder: exit 1', async () => {
    const { d, logs } = setup();
    const runner = async (_: unknown, job: SimJob) =>
      result(job, { steps: [kill(2, 'pass', 'killed by switcher; web: gone')] });
    expect(await switcherTrial(d, 'stale', runner)).toBe(1);
    expect(logs.join('\n')).toContain("the Mac's runner predates the ladder");
  });
  it('--round reruns one round, shutting the sim down after it', async () => {
    const { d, jobs } = setup();
    const runner = async (_: unknown, job: SimJob) => {
      jobs.push(job);
      return result(job, { steps: [] });
    };
    expect(await switcherTrial(d, 'one', runner, 1)).toBe(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toContain('trial-one-1');
    expect(jobs[0]?.params.shutdown).toBe(true);
  });
});
