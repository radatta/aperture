import { beforeEach, describe, expect, it } from 'vitest';
import { todayKey } from '@aperture/shared';
import { createStubClient } from './stubClient';

beforeEach(() => globalThis.localStorage?.clear());

// Stub-only behaviour the shared contract can't see: the dev seed and persisted-store upgrades.
describe('stub finances', () => {
  it('seeds a linked bank with rules, some history sorted, and recent charges left to sort', async () => {
    const api = createStubClient({ storageKey: `fin-seed-${Math.random()}` });
    const o = await api.getFinanceOverview({ today: todayKey(4) });
    expect(o.items.map((i) => i.institutionName)).toEqual(['Bank of America']);
    expect(o.accounts).toHaveLength(3);
    expect(o.sync.environment).toBe('stub');
    expect(o.unsortedCount).toBeGreaterThan(0);
    expect(o.spentCents).toBeGreaterThan(0);
    expect((await api.listFinanceRules()).map((r) => r.pattern)).toEqual([
      'netflix',
      'spotify',
      "trader joe's",
    ]);
  });

  it('a store persisted before finances existed gains the collections and settings defaults', async () => {
    const key = `fin-legacy-${Math.random()}`;
    const legacy = createStubClient({ seed: false, storageKey: key });
    const s = await legacy.getSettings();
    const raw = JSON.parse(localStorage.getItem(key)!);
    for (const k of Object.keys(raw)) if (k.startsWith('finance')) delete raw[k];
    const oldSettings: Partial<typeof s> = { ...s };
    delete oldSettings.financeBudgetCents;
    delete oldSettings.financeCycleDay;
    localStorage.setItem(key, JSON.stringify({ ...raw, settings: oldSettings }));

    const upgraded = createStubClient({ seed: false, storageKey: key });
    expect((await upgraded.getSettings()).financeBudgetCents).toBe(60000);
    expect((await upgraded.getFinanceOverview({ today: todayKey(4) })).items).toEqual([]);
  });
});
