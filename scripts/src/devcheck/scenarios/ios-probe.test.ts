import { describe, expect, it } from 'vitest';
import { IosAssert, validateSimParams, type IosOp } from '../../mailroom/sim';
import { recordIosPlans } from '../ios-plans';
import { NOT_PROBED } from '../probe-only';
import { NeedsYou, type Ctx } from '../scenario';
import { SCENARIOS } from './index';
import { cutPlans, iosProbe, PROBE_STEPS, SIGNED_OUT, SOURCES } from './ios-probe';

const NONCE = '2026-11-12t20-00-00-full';
const SHA = 'a'.repeat(40);
const step = (id: string) => iosProbe.steps.find((s) => s.id === id)!;
const ops = (steps: IosOp[]) => steps.map((s) => s.op);

describe('the probe job’s plans', () => {
  it('every cut job is a valid plan with no drafts, kills, relaunch or sign-in', async () => {
    const jobs = await cutPlans(NONCE);
    // The one typed line: done-form's search, read back where it was found, so the Done tap is the task's.
    expect(jobs.flatMap((j) => j.steps.filter((s) => s.op === 'keys'))).toEqual([
      { op: 'keys', text: expect.stringMatching(/^[a-z]{6}$/), in: 'search' },
    ]);
    for (const j of jobs) {
      expect(
        validateSimParams({ sha: SHA, timeoutSec: 240, shutdown: false, steps: j.steps }),
      ).toBeNull();
      expect(ops(j.steps)).not.toContain('erase');
      expect(ops(j.steps)).not.toContain('kill');
      expect(ops(j.steps)).not.toContain('signIn');
    }
  });

  it('launches and reads the build in the first job only, and shuts the sim down after the last', async () => {
    const jobs = await cutPlans(NONCE);
    expect(jobs[0]!.steps[0]).toEqual({ op: 'launch' });
    expect(ops(jobs[0]!.steps)).toContain('expectBuild');
    for (const j of jobs.slice(1)) {
      expect(ops(j.steps)).not.toContain('launch');
      expect(ops(j.steps)).not.toContain('readBuild');
      expect(ops(j.steps)).not.toContain('expectBuild');
    }
    expect(jobs.flatMap((j) => ops(j.steps)).filter((o) => o === 'shutdown')).toHaveLength(1);
    expect(jobs.at(-1)!.steps.at(-1)).toEqual({ op: 'shutdown' });
  });

  it('the Done form is cancelled, and the cancel must close it', async () => {
    const done = (await cutPlans(NONCE)).find((j) => j.name === 'done-form')!.steps;
    const tap = done.findIndex((s) => s.op === 'tap' && s.label === 'Done');
    expect(tap).toBeGreaterThanOrEqual(0);
    expect(done.slice(tap + 1)).toContainEqual(
      expect.objectContaining({ op: 'tap', label: 'Cancel', closes: true }),
    );
  });

  it('a step per cut job: the cut jobs and NOT_PROBED are every recorded job, in order', async () => {
    const recorded = [];
    for (const s of SOURCES) recorded.push(...(await recordIosPlans(s, { nonce: NONCE })));
    const names = recorded.map((j) => j.name);
    expect((await cutPlans(NONCE)).map((j) => j.name)).toEqual(PROBE_STEPS);
    expect(names.filter((n) => !NOT_PROBED.includes(n))).toEqual(PROBE_STEPS);
  });

  it('SOURCES are every scenario that sends a sim job', async () => {
    const senders = [];
    for (const s of SCENARIOS.filter((x) => x.id !== iosProbe.id))
      if ((await recordIosPlans(s, { nonce: NONCE })).length) senders.push(s.id);
    expect(SOURCES.map((s) => s.id)).toEqual(senders);
  });
});

describe('the probe job’s failures', () => {
  // A step's ctx whose sim answers the way ios.ts throws: an IosAssert wrapped as the step's error.
  const failing = (detail: string, o: { signedIn?: string; note?: string } = {}) => {
    const result = {
      status: 'fail',
      reason: 'ASSERT',
      detail,
      signedIn: o.signedIn ?? 'already',
      steps: [{ i: 3, op: 'find', status: 'fail', ms: 1, note: o.note }],
    };
    const err = new Error('iOS: failed', { cause: new IosAssert('failed', result as never) });
    const ctx = {
      nonce: NONCE,
      ios: {
        run: async () => {
          throw err;
        },
      },
    } as unknown as Ctx;
    return { err, ctx };
  };

  it('a miss stays a failure', async () => {
    const { err, ctx } = failing('MISS', { note: 'Capture log' });
    await expect(step('capture').run(ctx)).rejects.toBe(err);
  });

  it('a signed-out sim is needs-you for the rest of the scenario', async () => {
    const { ctx } = failing('LANDMARK', { signedIn: 'false' });
    await expect(step('launch').run(ctx)).rejects.toSatisfy(
      (e) => e instanceof NeedsYou && e.reason === SIGNED_OUT && !e.stepOnly,
    );
  });

  it('a LANDMARK without the sign-in card, and a low dock, stay failures', async () => {
    const lost = failing('LANDMARK', { signedIn: '' });
    await expect(step('launch').run(lost.ctx)).rejects.toBe(lost.err);
    const low = failing('BELOW_KEYBOARD', { note: 'long-bar bottom 600 vs keyboard top 590' });
    await expect(step('capture-long').run(low.ctx)).rejects.toBe(low.err);
  });
});

describe('the probe job’s task', () => {
  it('setup titles the in-progress task with done-form’s search text, so the Done tap is its', async () => {
    const writes: [string, unknown[]][] = [];
    const rec =
      (name: string) =>
      async (...a: unknown[]) => (writes.push([name, a]), { id: 't1' });
    const ctx = {
      nonce: NONCE,
      mcp: { writes: { createTask: rec('createTask'), updateTask: rec('updateTask') } },
    } as unknown as Ctx;
    await step('setup').run(ctx);
    const search = (await cutPlans(NONCE))
      .find((j) => j.name === 'done-form')!
      .steps.find((s) => s.op === 'keys');
    expect(search).toBeDefined();
    expect(writes).toEqual([
      [
        'createTask',
        [{ title: `devcheck-ios-probe ${(search as { text: string }).text}`, estimateMin: 15 }],
      ],
      ['updateTask', ['t1', { status: 'in_progress' }]],
    ]);
  });

  it('verify says needs you, not pass, until the Done form job has completed', async () => {
    const ctx = {
      nonce: NONCE,
      mcp: { writes: { createTask: async () => ({ id: 't1' }), updateTask: async () => ({}) } },
      api: { reads: { getTask: async () => ({ status: 'in_progress' }) } },
      ios: { run: async () => ({}) },
    } as unknown as Ctx;
    await step('setup').run(ctx);
    await expect(step('verify').run(ctx)).rejects.toBeInstanceOf(NeedsYou);
    await step('done-form').run(ctx);
    await expect(step('verify').run(ctx)).resolves.toBeUndefined();
  });
});
