import { describe, expect, it } from 'vitest';
import { FIXTURE_ITEM_ID } from '@aperture/shared';
import { InMemoryDoc } from './ddb/DocClient';
import { sk } from './ddb/keys';
import { entityItem } from './ddb/mapping';
import { InMemoryPlaid } from './plaid/gateway';
import { handleFinanceSync, parseSyncEvent } from './financeSync';

describe('finance sync Lambda edge', () => {
  it('refuses a malformed event before touching anything', () => {
    expect(() => parseSyncEvent(null)).toThrow(/userId/);
    expect(() => parseSyncEvent({ userId: ' ', mode: 'scheduled' })).toThrow(/userId/);
    expect(() => parseSyncEvent({ userId: 'u', mode: 'hourly' })).toThrow(/mode/);
    expect(() => parseSyncEvent({ userId: 'u', mode: 'manual', refresh: 'yes' })).toThrow(
      /refresh/,
    );
    expect(parseSyncEvent({ userId: 'u', mode: 'scheduled', junk: 1 })).toEqual({
      userId: 'u',
      mode: 'scheduled',
    });
  });

  it('runs a scheduled sync for the user in the event', async () => {
    const doc = new InMemoryDoc();
    const plaid = new InMemoryPlaid({ today: () => '2026-09-26' });
    await plaid.exchangePublicToken('p');
    await doc.put(
      entityItem('u1', sk.finItem(FIXTURE_ITEM_ID), {
        id: FIXTURE_ITEM_ID,
        userId: 'u1',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        institutionId: 'ins',
        institutionName: 'Bank',
        status: 'ok',
        errorCode: null,
        consentExpiresAt: null,
        lastSuccessfulUpdateAt: null,
        lastFailedUpdateAt: null,
        consentedProducts: ['transactions'],
      }),
    );
    const report = await handleFinanceSync(doc, plaid, { userId: 'u1', mode: 'scheduled' });
    expect(report).toEqual([expect.objectContaining({ itemId: FIXTURE_ITEM_ID, outcome: 'ok' })]);
    expect(doc.size).toBeGreaterThan(50);
  });

  it('testMode: no Plaid, no writes', async () => {
    const doc = new InMemoryDoc();
    const plaid = new InMemoryPlaid({ today: () => '2026-09-26' });
    await handleFinanceSync(doc, plaid, {
      userId: 'smoke-test',
      mode: 'scheduled',
      testMode: true,
    });
    expect(plaid.calls).toEqual([]);
    expect(doc.size).toBe(0);
  });
});
