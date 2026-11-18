import { describe, expect, it } from 'vitest';
import { fingerprint, fingerprintScenario } from './list';
import type { Scenario } from './scenario';
import { SCENARIOS } from './scenarios';

describe('list', () => {
  it('fingerprints every scenario in run order, with the counts', () => {
    const f = fingerprint();
    expect(f.order).toEqual(SCENARIOS.map((s) => s.id));
    expect(f.counts.rows).toBe(SCENARIOS.reduce((n, s) => n + s.rows.length, 0));
    expect(Object.keys(f.clients.api.writes)).toContain('lcSittingStart');
  });

  it('a step’s hash ignores whitespace but not a changed token', () => {
    const sc = (run: Scenario['steps'][number]['run']): Scenario => ({
      id: 'x',
      title: 'x',
      tiers: ['full'],
      rows: [],
      steps: [{ id: 's', title: 's', entry: 'api', run }],
    });
    const a = fingerprintScenario(sc(new Function('return async () => { await 1; }')() as never));
    const b = fingerprintScenario(
      sc(new Function('return async () => {\n      await 1;\n}')() as never),
    );
    const c = fingerprintScenario(sc(new Function('return async () => { await 2; }')() as never));
    expect(a.steps[0]!.run).toBe(b.steps[0]!.run);
    expect(a.steps[0]!.run).not.toBe(c.steps[0]!.run);
  });
});
