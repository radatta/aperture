import { beforeEach, describe, expect, it } from 'vitest';
import { todayKey } from '@aperture/shared';
import { createStubClient, STUB_FAIL_NEXT_SYNC_KEY } from './stubClient';

beforeEach(() => globalThis.localStorage?.clear());

// Stub-only behaviour the shared contract can't see: the dev seed and persisted-store upgrades.
describe('stub finances', () => {
  it('seeds a linked bank with rules, some history sorted, and recent charges left to sort', async () => {
    const api = createStubClient({ storageKey: `fin-seed-${Math.random()}` });
    const o = await api.getFinanceOverview({ today: todayKey(4) });
    expect(o.items.map((i) => i.institutionName)).toEqual(['First Platypus Bank']);
    expect(o.accounts).toHaveLength(3);
    expect(o.sync.environment).toBe('stub');
    expect(o.period.source).toBe('marked');
    expect(o.unsortedCount).toBeGreaterThan(0);
    expect(o.spentCents).toBeGreaterThan(0);
    expect((await api.listFinanceRules()).map((r) => r.pattern)).toEqual([
      'netflix',
      'shell',
      'spotify',
    ]);
  });

  it('the fail-next-sync hook fails one run without touching data, then clears', async () => {
    const api = createStubClient({ storageKey: `fin-fail-${Math.random()}` });
    const today = todayKey(4);
    const before = await api.getFinanceOverview({ today });
    const count = (await api.exportData()).financeTransactions.length;
    localStorage.setItem(STUB_FAIL_NEXT_SYNC_KEY, 'INSTITUTION_DOWN');
    await api.requestFinanceSync({ refresh: false });
    const failed = await api.getFinanceOverview({ today });
    expect([failed.sync.lastError, failed.sync.syncing]).toEqual(['INSTITUTION_DOWN', false]);
    expect(failed.sync.lastSyncedAt).toBe(before.sync.lastSyncedAt);
    expect((await api.exportData()).financeTransactions.length).toBe(count);
    expect(localStorage.getItem(STUB_FAIL_NEXT_SYNC_KEY)).toBeNull(); // once
    await api.requestFinanceSync({ refresh: false });
    const ok = await api.getFinanceOverview({ today });
    expect([ok.sync.lastError, ok.sync.lastErrorAt]).toEqual([null, null]);
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
