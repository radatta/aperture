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
    expect(o.period.source).toBe('marked');
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
    delete oldSettings.financePaymentDay;
    localStorage.setItem(
      key,
      JSON.stringify({
        ...raw,
        settings: { ...oldSettings, financeCycleDay: 23 },
        financeTransactions: [{ id: 'old-row', deletedAt: null, date: '2026-01-01' }],
      }),
    );

    const upgraded = createStubClient({ seed: false, storageKey: key });
    const settings = await upgraded.getSettings();
    expect(settings.financeBudgetCents).toBe(60000);
    expect(settings.financePaymentDay).toBe(20);
    expect('financeCycleDay' in settings).toBe(false);
    expect((await upgraded.getFinanceOverview({ today: todayKey(4) })).items).toEqual([]);
    const [old] = await upgraded.listFinanceTransactions({ from: '2026-01-01', to: '2026-01-01' });
    expect(old!.refundOfId).toBeNull(); // pre-refund-linking rows read as unlinked
    expect(old!.startsPeriod).toBe(false);
  });
});
