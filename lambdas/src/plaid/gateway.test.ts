import { describe, expect, it } from 'vitest';
import { FIXTURE_ITEM_ID, fixturePageAfter } from '@aperture/shared';
import { InMemoryPlaid, noopPlaid, PlaidApiError } from './gateway';

describe('noopPlaid', () => {
  it('reads are empty and anything that would change something at Plaid throws', async () => {
    const p = noopPlaid();
    expect(await p.transactionsSync('i', 'c', 500)).toMatchObject({ added: [], has_more: false });
    expect(await p.accountsGet('i')).toEqual([]);
    await p.itemRemove('i');
    await expect(p.createLinkToken({ userId: 'u', mode: 'connect' })).rejects.toThrow(/testMode/);
    await expect(p.exchangePublicToken('x')).rejects.toThrow(/testMode/);
    await expect(p.transactionsRefresh('i')).rejects.toThrow(/testMode/);
  });
});

describe('InMemoryPlaid', () => {
  const today = '2026-09-26';
  it('replays the shared fixture pages by cursor after an exchange', async () => {
    const p = new InMemoryPlaid({ today: () => today });
    await expect(p.transactionsSync(FIXTURE_ITEM_ID, null, 500)).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND',
    });
    const { itemId } = await p.exchangePublicToken('pub');
    expect(itemId).toBe(FIXTURE_ITEM_ID);
    expect(await p.transactionsSync(itemId, null, 500)).toEqual(fixturePageAfter(null, today));
    expect(await p.transactionsSync(itemId, 'fx-cursor-1', 500)).toEqual(
      fixturePageAfter('fx-cursor-1', today),
    );
    expect(p.calls.at(-1)!.detail).toEqual({ cursor: 'fx-cursor-1', count: 500 });
    expect(p.calls.map((c) => c.method)).toEqual([
      'transactionsSync',
      'exchangePublicToken',
      'transactionsSync',
      'transactionsSync',
    ]);
  });

  it('failNext throws once for that method only', async () => {
    const p = new InMemoryPlaid({ today: () => today });
    await p.exchangePublicToken('pub');
    p.failNext('transactionsSync', 'INSTITUTION_DOWN');
    expect(await p.accountsGet(FIXTURE_ITEM_ID)).toHaveLength(3);
    const e = await p.transactionsSync(FIXTURE_ITEM_ID, null, 500).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PlaidApiError);
    expect((e as PlaidApiError).code).toBe('INSTITUTION_DOWN');
    await p.transactionsSync(FIXTURE_ITEM_ID, null, 500);
  });

  it('remove forgets the token', async () => {
    const p = new InMemoryPlaid({ today: () => today });
    await p.exchangePublicToken('pub');
    await p.itemRemove(FIXTURE_ITEM_ID);
    expect(p.tokens.size).toBe(0);
  });
});
