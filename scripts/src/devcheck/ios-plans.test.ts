import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateSimParams } from '../mailroom/sim';
import { recordIosPlans } from './ios-plans';
import type { Scenario } from './scenario';
import { SCENARIOS } from './scenarios';

const DIR = new URL('./scenarios/', import.meta.url);
// Every scenario file that sends a sim job, by the id its `Scenario` literal declares.
function iosScenarioIds(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(new URL(f, DIR), 'utf8'))
    .filter((src) => src.includes('ctx.ios.run('))
    .map((src) => /:\s*Scenario\s*=\s*\{\s*id:\s*'([^']+)'/.exec(src)?.[1] ?? '?')
    .sort();
}

describe('recordIosPlans', () => {
  it('records a job from every scenario that sends one, and only those', async () => {
    const withJobs: string[] = [];
    for (const s of SCENARIOS)
      if ((await recordIosPlans(s, { nonce: 'plans' })).length) withJobs.push(s.id);
    expect(withJobs.sort()).toEqual(iosScenarioIds());
    expect(withJobs).toEqual(expect.arrayContaining(['ios-standalone', 'category-suggest-ios']));
  });

  it('records plans the runner would accept, named after their steps', async () => {
    for (const s of SCENARIOS)
      for (const j of await recordIosPlans(s, { nonce: 'plans' })) {
        expect(s.steps.find((st) => st.id === j.step)?.entry, `${s.id}/${j.name}`).toBe('ios');
        const params = { sha: 'a'.repeat(40), timeoutSec: 300, shutdown: false, steps: j.steps };
        expect(validateSimParams(params), `${s.id}/${j.name}`).toBeNull();
      }
  });

  it('every keys op names the field it types into, found earlier in its plan: the runner checks and retypes only then', async () => {
    for (const s of SCENARIOS)
      for (const j of await recordIosPlans(s, { nonce: 'plans' })) {
        const found = new Set<string>();
        for (const op of j.steps as { op: string; as?: string; in?: string }[]) {
          if (op.op === 'keys')
            expect(op.in && found.has(op.in), `${s.id}/${j.name}: keys without a found field`).toBe(
              true,
            );
          if (op.as) found.add(op.as);
        }
      }
  });

  it('counts the setup writes a step makes before its job', async () => {
    const s: Scenario = {
      id: 'fake',
      title: 'fake',
      tiers: ['full'],
      rows: [],
      steps: [
        {
          id: 'one',
          entry: 'ios',
          title: 'one',
          async run(ctx) {
            await ctx.api.writes.createTask({ title: 'x' } as never);
            await ctx.ios.run('first', [{ op: 'launch' }]);
          },
        },
      ],
    };
    const [job] = await recordIosPlans(s, { nonce: 'n' });
    expect(job).toMatchObject({
      scenario: 'fake',
      step: 'one',
      name: 'first',
      setupWrites: ['createTask'],
    });
  });

  it('fails an ios step that sends no job', async () => {
    const s = {
      id: 'fake',
      steps: [{ id: 'mute', entry: 'ios', title: 'mute', run: async () => {} }],
    } as unknown as Scenario;
    await expect(recordIosPlans(s, { nonce: 'n' })).rejects.toThrow(/mute sent 0 sim jobs/);
  });
});
