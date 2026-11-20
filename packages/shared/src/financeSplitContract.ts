import { expect, it } from 'vitest';
import type { ApiClient } from './api';
import type { FinanceOverview, FinanceSplitPartInput } from './finance';

// Splits, refunds across charges and split rules — part of the ApiClient contract (contractTests.ts calls
// this inside its suite), so the stub, the Lambda and handleRpc must agree on every case, refusal text
// included. Runs over the shared fixture bank (financeFixtures.ts): its card charges are `fx-card-<daysAgo>`
// ($30.00 at 8, $15.00 at 6, $20.00 at 4, $10.00 at 2), `fx-reimburse` is an $800.50 deposit, and
// `fx-pending-1` ($22.00) posts at $26.00 on the next sync.
export interface FinanceSplitHarness {
  api: () => ApiClient;
  finToday: () => string;
  connect: () => Promise<unknown>;
  advance: (ms: number) => void;
  finRange: () => Promise<{ from: string; to: string }>;
}

const p = (
  bucket: FinanceSplitPartInput['bucket'],
  cents: number,
  period: FinanceSplitPartInput['period'] = null,
): FinanceSplitPartInput => ({ bucket, cents, period });

export function financeSplitContract(h: FinanceSplitHarness) {
  const overview = () => h.api().getFinanceOverview({ today: h.finToday() });
  const delta = (a: FinanceOverview, b: FinanceOverview) => ({
    budget: b.buckets.budget.totalCents - a.buckets.budget.totalCents,
    parents_pay: b.buckets.parents_pay.totalCents - a.buckets.parents_pay.totalCents,
    i_pay: b.buckets.i_pay.totalCents - a.buckets.i_pay.totalCents,
    unsorted: b.unsortedCount - a.unsortedCount,
  });

  it('finance splits: a charge split across buckets counts each part in its own, and is sorted', async () => {
    await h.connect();
    const api = h.api();
    const before = await overview();
    const split = await api.setFinanceSplit('fx-card-8', [
      p('budget', 1800),
      p('parents_pay', 1200),
    ]);
    expect(split.splits).toEqual([p('budget', 1800), p('parents_pay', 1200)]);
    expect([split.bucket, split.bucketSetBy]).toEqual([null, 'user']);
    const after = await overview();
    expect(delta(before, after)).toEqual({
      budget: 1800,
      parents_pay: 1200,
      i_pay: 0,
      unsorted: -1,
    });
    // Saving the same split again is idempotent.
    await api.setFinanceSplit('fx-card-8', [p('budget', 1800), p('parents_pay', 1200)]);
    expect(delta(before, await overview())).toEqual(delta(before, after));
    // A split row refuses a plain sort; removing the split returns it to Unsorted.
    await expect(api.setFinanceBucket({ ids: ['fx-card-8'], bucket: 'budget' })).rejects.toThrow(
      'Amazon is split — change it from its detail',
    );
    const removed = await api.setFinanceSplit('fx-card-8', null);
    expect([removed.splits, removed.bucket, removed.bucketSetBy]).toEqual([null, null, null]);
    expect(delta(before, await overview())).toEqual({
      budget: 0,
      parents_pay: 0,
      i_pay: 0,
      unsorted: 0,
    });
  });

  it('finance splits: a next-period part waits in upcoming, out of every bucket total', async () => {
    await h.connect();
    const before = await overview();
    await h.api().setFinanceSplit('fx-card-8', [p('budget', 1000), p('budget', 2000, 'next')]);
    const after = await overview();
    expect(delta(before, after).budget).toBe(1000);
    expect(after.upcoming).toEqual({ totalCents: 2000, count: 1 });
  });

  it('finance splits: refusals name why and write nothing', async () => {
    await h.connect();
    const api = h.api();
    const refuse = (id: string, parts: FinanceSplitPartInput[]) =>
      expect(api.setFinanceSplit(id, parts)).rejects.toThrow();
    await expect(
      api.setFinanceSplit('fx-card-8', [p('budget', 1000), p('i_pay', 1000)]),
    ).rejects.toThrow('$10.00 is left to assign — the parts must add up to $30.00');
    await expect(api.setFinanceSplit('fx-card-8', [p('budget', 3000)])).rejects.toThrow(
      'A split needs at least two parts',
    );
    await expect(
      api.setFinanceSplit('fx-reimburse', [p('budget', 40000), p('i_pay', 40050)]),
    ).rejects.toThrow('Only a charge can be split — not a refund, payment or transfer');
    await expect(
      api.setFinanceSplit('fx-card-8', [p('budget', 1500), p('bogus' as never, 1500)]),
    ).rejects.toThrow('Unknown bucket');
    await refuse('no-such-row', [p('budget', 1500), p('i_pay', 1500)]);
    const row = (await api.listFinanceTransactions(await h.finRange())).find(
      (t) => t.id === 'fx-card-8',
    )!;
    expect(row.splits).toBeNull();
  });

  it('finance splits: a split posted at a new amount asks again; a rule split recomputes', async () => {
    await h.connect();
    const api = h.api();
    await api.setFinanceSplit('fx-pending-1', [p('budget', 1100), p('i_pay', 1100)]);
    h.advance(1000);
    await api.requestFinanceSync({ refresh: false });
    const rows = await api.listFinanceTransactions(await h.finRange());
    const posted = rows.find((t) => t.id === 'fx-posted-1')!;
    expect(posted.splits).toEqual([p('budget', 1100), p('i_pay', 1100)]); // kept, to prefill the editor
    expect(posted.rawAmountCents).toBe(2600);
    // Broken: it counts as unsorted meanwhile, and it can be sorted again (which replaces it).
    const broken = await overview();
    const sorted = await api.setFinanceBucket({ ids: ['fx-posted-1'], bucket: 'budget' });
    expect([sorted[0]!.bucket, sorted[0]!.splits]).toEqual(['budget', null]);
    const fixed = await overview();
    expect(broken.unsortedCount - fixed.unsortedCount).toBe(1);
    expect(broken.unsortedCents - fixed.unsortedCents).toBe(2600);
  });

  it('finance split rules: a new matching charge arrives split by percent', async () => {
    await h.connect();
    const api = h.api();
    const rule = await api.upsertFinanceRule({
      pattern: 'Sweetgreen',
      bucket: 'i_pay',
      split: [
        { bucket: 'i_pay', percent: 40 },
        { bucket: 'budget', percent: 60 },
      ],
    });
    expect(rule.bucket).toBe('budget'); // the largest part
    expect(rule.split).toEqual([
      { bucket: 'i_pay', percent: 40 },
      { bucket: 'budget', percent: 60 },
    ]);
    expect((await api.listFinanceRules()).find((r) => r.id === rule.id)!.split).toEqual(rule.split);
    h.advance(1000);
    await api.requestFinanceSync({ refresh: false });
    const posted = (await api.listFinanceTransactions(await h.finRange())).find(
      (t) => t.id === 'fx-posted-1',
    )!;
    expect([posted.bucket, posted.bucketSetBy]).toEqual([null, 'rule']);
    expect(posted.splits).toEqual([
      { bucket: 'i_pay', cents: 1040, period: null, percent: 40 },
      { bucket: 'budget', cents: 1560, period: null, percent: 60 },
    ]);
    // A Pause (same bucket, no split sent — an older client too) keeps the split.
    const paused = await api.upsertFinanceRule({
      id: rule.id,
      pattern: 'sweetgreen',
      bucket: 'budget',
      active: false,
    });
    expect([paused.active, paused.split]).toEqual([false, rule.split]);
    // Back to one bucket: the split goes.
    const plain = await api.upsertFinanceRule({
      id: rule.id,
      pattern: 'sweetgreen',
      bucket: 'i_pay',
    });
    expect([plain.bucket, plain.split]).toEqual(['i_pay', null]);
    await expect(
      api.upsertFinanceRule({
        pattern: 'x',
        bucket: 'budget',
        split: [
          { bucket: 'budget', percent: 50 },
          { bucket: 'i_pay', percent: 40 },
        ],
      }),
    ).rejects.toThrow('The parts add up to 90%, not 100%');
  });

  it('finance refunds across charges: one deposit nets two charges in their own buckets', async () => {
    await h.connect();
    const api = h.api();
    await api.setFinanceBucket({ ids: ['fx-card-8'], bucket: 'budget' });
    await api.setFinanceBucket({ ids: ['fx-card-6'], bucket: 'i_pay' });
    const before = await overview();
    const linked = await api.setFinanceRefundParts('fx-reimburse', [
      { chargeId: 'fx-card-6', cents: 1500 },
      { chargeId: 'fx-card-8', cents: 3000 },
    ]);
    // Stored largest first (the primary link); the single link and own bucket cleared.
    expect(linked.refundParts).toEqual([
      { chargeId: 'fx-card-8', cents: 3000 },
      { chargeId: 'fx-card-6', cents: 1500 },
    ]);
    expect([linked.refundOfId, linked.bucket]).toEqual([null, null]);
    const after = await overview();
    expect(delta(before, after)).toEqual({
      budget: -3000,
      parents_pay: 0,
      i_pay: -1500,
      unsorted: 0,
    });
    // The rest of the deposit stays money in, outside every total: the over-allocation is refused.
    await expect(
      api.setFinanceRefundParts('fx-reimburse', [{ chargeId: 'fx-card-8', cents: 3100 }]),
    ).rejects.toThrow('Only $30.00 is left to refund on Amazon');
    // Unlink all.
    const unlinked = await api.linkFinanceRefund('fx-reimburse', null);
    expect([unlinked.refundParts, unlinked.refundOfId]).toEqual([null, null]);
    expect(delta(before, await overview()).budget).toBe(0);
  });

  it('finance refunds across charges: caps across refunds, sums within the refund', async () => {
    await h.connect();
    const api = h.api();
    // Another refund already took all of the $30.00 charge: nothing is left for this one.
    await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
    await expect(
      api.setFinanceRefundParts('fx-reimburse', [{ chargeId: 'fx-card-8', cents: 100 }]),
    ).rejects.toThrow('Only $0.00 is left to refund on Amazon');
    // $30.00 of card credit can't go out as $35.00.
    await api.linkFinanceRefund('fx-refund-1', null);
    await expect(
      api.setFinanceRefundParts('fx-refund-1', [
        { chargeId: 'fx-card-8', cents: 2000 },
        { chargeId: 'fx-card-6', cents: 1500 },
      ]),
    ).rejects.toThrow('The charges take $35.00, $5.00 more than the $30.00 refund');
    await expect(
      api.setFinanceRefundParts('fx-refund-1', [
        { chargeId: 'fx-card-8', cents: 1000 },
        { chargeId: 'fx-card-8', cents: 1000 },
      ]),
    ).rejects.toThrow('That charge is already in the list');
    await expect(api.setFinanceRefundParts('fx-refund-1', [])).rejects.toThrow(
      'Pick at least one charge',
    );
    await expect(
      api.setFinanceRefundParts('fx-refund-1', [{ chargeId: 'fx-ccpay-card-10', cents: 100 }]),
    ).rejects.toThrow();
    // A single link replaces an allocation.
    await api.setFinanceRefundParts('fx-refund-1', [{ chargeId: 'fx-card-8', cents: 1000 }]);
    const single = await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
    expect([single.refundOfId, single.refundParts]).toEqual(['fx-card-8', null]);
  });
  it('finance refunds across charges: a part on a pending charge follows it when it posts', async () => {
    await h.connect();
    const api = h.api();
    await api.setFinanceRefundParts('fx-reimburse', [
      { chargeId: 'fx-card-8', cents: 3000 },
      { chargeId: 'fx-pending-1', cents: 2200 },
    ]);
    h.advance(1000);
    await api.requestFinanceSync({ refresh: false }); // fx-pending-1 posts as fx-posted-1
    // Re-saving the parts as stored (the pending id) still takes, and stores the posted id.
    const again = await api.setFinanceRefundParts('fx-reimburse', [
      { chargeId: 'fx-card-8', cents: 3000 },
      { chargeId: 'fx-pending-1', cents: 2200 },
    ]);
    expect(again.refundParts).toEqual([
      { chargeId: 'fx-card-8', cents: 3000 },
      { chargeId: 'fx-posted-1', cents: 2200 },
    ]);
    // Unlinking the other charge leaves the posted one.
    const one = await api.setFinanceRefundParts('fx-reimburse', [
      { chargeId: 'fx-posted-1', cents: 2200 },
    ]);
    expect(one.refundParts).toEqual([{ chargeId: 'fx-posted-1', cents: 2200 }]);
  });

  it('finance splits: a pin, a mark or Always clears or skips the new fields', async () => {
    await h.connect();
    const api = h.api();
    const parts = [
      { chargeId: 'fx-card-8', cents: 2000 },
      { chargeId: 'fx-card-4', cents: 1000 },
    ];
    await api.setFinanceRefundParts('fx-refund-1', parts);
    expect((await api.setFinancePeriodOverride('fx-refund-1', 'current')).refundParts).toBeNull();
    await api.setFinanceRefundParts('fx-refund-1', parts);
    const marked = await api.setFinancePeriodStart('fx-refund-1', true);
    expect([marked.refundParts, marked.splits]).toEqual([null, null]);
    // Always sorts every unsorted match but never a split row, and saves a one-bucket rule.
    await api.setFinanceSplit('fx-card-8', [p('budget', 1500), p('i_pay', 1500)]);
    await api.setFinancePeriodStart('fx-refund-1', false);
    const swept = await api.setFinanceBucket({
      ids: ['fx-refund-1'],
      bucket: 'parents_pay',
      rule: { pattern: 'Amazon' },
    });
    expect(swept.map((t) => t.id)).not.toContain('fx-card-8');
    const rows = await api.listFinanceTransactions(await h.finRange());
    expect(rows.find((t) => t.id === 'fx-card-8')!.splits).toEqual([
      p('budget', 1500),
      p('i_pay', 1500),
    ]);
    const rule = (await api.listFinanceRules()).find((r) => r.pattern === 'amazon')!;
    expect(rule.split).toBeNull();
  });

  it('finance splits: Remove split on a row no longer split changes nothing', async () => {
    await h.connect();
    const api = h.api();
    await api.setFinanceBucket({ ids: ['fx-card-6'], bucket: 'budget' });
    const after = await api.setFinanceSplit('fx-card-6', null); // a stale device's Remove
    expect([after.bucket, after.splits]).toEqual(['budget', null]);
  });
}
