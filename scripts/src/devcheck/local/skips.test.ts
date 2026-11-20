import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scenarios/index';
import { IOS_LOCAL, LOCAL_SKIPS, localSkip } from './skips';

describe('LOCAL_SKIPS', () => {
  it('names only scenarios and steps that exist', () => {
    for (const [id, s] of Object.entries(LOCAL_SKIPS)) {
      const sc = SCENARIOS.find((x) => x.id === id);
      expect(sc, `scenario ${id}`).toBeDefined();
      for (const step of s.steps ?? [])
        expect(
          sc!.steps.map((x) => x.id),
          `${id}/${step}`,
        ).toContain(step);
      expect(s.reason).toMatch(/^local: .* runs on dev$/);
    }
  });
  it('defers every ios step and nothing else by default', () => {
    expect(localSkip('smoke', { id: 'x', entry: 'ios' })).toBe(IOS_LOCAL);
    expect(localSkip('smoke', { id: 'x', entry: 'ui' })).toBeNull();
    expect(localSkip('finance', { id: 'any', entry: 'api' })).toBe(LOCAL_SKIPS.finance!.reason);
    expect(localSkip('finance-splits', { id: 'any', entry: 'ui' })).toBe(
      LOCAL_SKIPS['finance-splits']!.reason,
    );
  });
  it('smoke always runs locally', () => {
    const smoke = SCENARIOS.find((x) => x.id === 'smoke')!;
    expect(
      smoke.steps.filter((s) => s.entry !== 'ios').every((s) => localSkip('smoke', s) === null),
    ).toBe(true);
  });
});
