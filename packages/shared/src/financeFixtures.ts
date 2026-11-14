// Sandbox-shaped Plaid fixtures, anchored to a day so the stub always looks current. One First Platypus Bank login
// with checking + savings + card, ~60 days of history, two card payments with matching checking
// outflows, a checking→savings transfer, payroll, card + debit refunds, and a pending card charge
// that posts in the follow-up page. Shared by the app stub (inline sync) and the lambdas' InMemoryPlaid, so both
// ApiClient impls replay identical data under the contract tests.

import { addDays } from './dates';
import type { LinkAccountMeta } from './finance';
import type { PlaidAccount, PlaidSyncResponse, PlaidTransaction } from './plaidTypes';

export const FIXTURE_INSTITUTION = { id: 'ins_109508', name: 'First Platypus Bank' };
export const FIXTURE_ITEM_ID = 'item-fixture-platypus';
export const FIXTURE_ACCOUNT_IDS = {
  checking: 'acct-fixture-checking',
  savings: 'acct-fixture-savings',
  card: 'acct-fixture-card',
} as const;

export const FIXTURE_ACCOUNTS: PlaidAccount[] = [
  {
    account_id: FIXTURE_ACCOUNT_IDS.checking,
    name: 'Plaid Checking',
    official_name: 'Plaid Gold Standard 0% Interest Checking',
    mask: '0000',
    type: 'depository',
    subtype: 'checking',
    balances: { current: 110, available: 100, iso_currency_code: 'USD' },
  },
  {
    account_id: FIXTURE_ACCOUNT_IDS.savings,
    name: 'Plaid Saving',
    official_name: 'Plaid Silver Standard 0.1% Interest Saving',
    mask: '1111',
    type: 'depository',
    subtype: 'savings',
    balances: { current: 210, available: 200, iso_currency_code: 'USD' },
  },
  {
    account_id: FIXTURE_ACCOUNT_IDS.card,
    name: 'Plaid Credit Card',
    official_name: 'Plaid Diamond 12.5% APR Interest Credit Card',
    mask: '3333',
    type: 'credit',
    subtype: 'credit card',
    balances: { current: 410, available: 1590, iso_currency_code: 'USD' },
  },
];

export const FIXTURE_LINK_ACCOUNTS: LinkAccountMeta[] = FIXTURE_ACCOUNTS.map((a) => ({
  id: a.account_id,
  name: a.name,
  mask: a.mask,
  type: a.type,
  subtype: a.subtype,
}));

// [merchant_name, raw name, dollars, PFC primary]
const CARD_MERCHANTS: [string, string, number, string][] = [
  ["Trader Joe's", 'TRADER JOE S #0000', 40, 'FOOD_AND_DRINK'],
  ['Chipotle', 'CHIPOTLE 0000', 10, 'FOOD_AND_DRINK'],
  ['Uber', 'UBER *TRIP HELP.UBER.COM', 20, 'TRANSPORTATION'],
  ['Spotify', 'SPOTIFY USA', 15, 'ENTERTAINMENT'],
  ['Amazon', 'AMAZON MKTPL*000000', 30, 'GENERAL_MERCHANDISE'],
  ['Blue Bottle Coffee', 'SQ *BLUE BOTTLE #0000', 5, 'FOOD_AND_DRINK'],
  ['Shell', 'SHELL OIL 00000', 50, 'TRANSPORTATION'],
  ['Target', 'TARGET 00000000', 25, 'GENERAL_MERCHANDISE'],
  ['DoorDash', 'DD *DOORDASH CHIPOTLE', 35, 'FOOD_AND_DRINK'],
  ['Netflix', 'NETFLIX.COM', 45, 'ENTERTAINMENT'],
];

function txn(
  id: string,
  accountId: string,
  date: string,
  amount: number,
  name: string,
  merchant: string | null,
  pfc: [string, string] | null,
  extra: Partial<PlaidTransaction> = {},
): PlaidTransaction {
  return {
    transaction_id: id,
    account_id: accountId,
    amount,
    iso_currency_code: 'USD',
    date,
    authorized_date: date,
    name,
    merchant_name: merchant,
    pending: false,
    pending_transaction_id: null,
    payment_channel: 'in store',
    personal_finance_category: pfc ? { primary: pfc[0], detailed: pfc[1] } : null,
    ...extra,
  };
}

// Every transaction in the initial pull, oldest first. Positive = money out (Plaid's convention).
export function fixtureHistory(today: string): PlaidTransaction[] {
  const { checking, savings, card } = FIXTURE_ACCOUNT_IDS;
  const out: PlaidTransaction[] = [];
  for (let ago = 58; ago >= 1; ago--) {
    const date = addDays(today, -ago);
    if (ago % 2 === 0) {
      const [m, raw, dollars, pfc] = CARD_MERCHANTS[(ago / 2) % CARD_MERCHANTS.length]!;
      out.push(txn(`fx-card-${ago}`, card, date, dollars, raw, m, [pfc, `${pfc}_OTHER`]));
    }
    if (ago % 5 === 0) {
      const [m, raw, dollars, pfc] = CARD_MERCHANTS[(ago * 3) % CARD_MERCHANTS.length]!;
      out.push(txn(`fx-card-b-${ago}`, card, date, dollars + 1, raw, m, [pfc, `${pfc}_OTHER`]));
    }
    if (ago % 14 === 3)
      out.push(
        txn(`fx-pay-${ago}`, checking, date, -2000, 'ACME CORP PAYROLL', 'Acme Corp', [
          'INCOME',
          'INCOME_WAGES',
        ]),
      );
  }
  // Card payments: checking pays the card; the card side posts a day later.
  for (const [ago, dollars] of [
    [40, 700],
    [10, 650],
  ] as const) {
    out.push(
      txn(
        `fx-ccpay-chk-${ago}`,
        checking,
        addDays(today, -ago),
        dollars,
        'FIRST PLATYPUS BANK CREDIT CARD Bill Payment',
        null,
        ['LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'],
      ),
      txn(
        `fx-ccpay-card-${ago}`,
        card,
        addDays(today, -ago + 1),
        -dollars,
        'PAYMENT - THANK YOU',
        null,
        ['LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'],
      ),
    );
  }
  out.push(
    txn(
      'fx-xfer-chk',
      checking,
      addDays(today, -20),
      100,
      'Online Banking transfer to SAV 1111',
      null,
      ['TRANSFER_OUT', 'TRANSFER_OUT_SAVINGS'],
    ),
    txn(
      'fx-xfer-sav',
      savings,
      addDays(today, -20),
      -100,
      'Online Banking transfer from CHK 0000',
      null,
      ['TRANSFER_IN', 'TRANSFER_IN_SAVINGS'],
    ),
    txn('fx-venmo', checking, addDays(today, -12), 60, 'VENMO PAYMENT', 'Venmo', [
      'TRANSFER_OUT',
      'TRANSFER_OUT_ACCOUNT_TRANSFER',
    ]),
    // Money out that isn't spending: a brokerage deposit from savings, no matching inflow — the
    // row "Not spending" exists for.
    txn('fx-brokerage', savings, addDays(today, -6), 400, 'BROKERAGE FUNDS', 'Brokerage', [
      'TRANSFER_OUT',
      'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
    ]),
    // Rent by peer-to-peer from checking, then a rounded-up reimbursement into the same account from an
    // account that isn't linked: Plaid tags it a transfer, so it's money in until linked as the refund.
    txn(
      'fx-rent',
      checking,
      addDays(today, -5),
      800,
      'ZELLE PAYMENT TO EXAMPLE LANDLORD',
      'Example Landlord',
      ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT'],
    ),
    txn(
      'fx-reimburse',
      checking,
      addDays(today, -3),
      -800.5,
      'ZELLE PAYMENT FROM EXAMPLE PAYER',
      'Example Payer',
      ['TRANSFER_IN', 'TRANSFER_IN_ACCOUNT_TRANSFER'],
    ),
    // Card credits: the Amazon order from 8 days ago returned in full, and a partial Target refund
    // of a charge from the previous period. Both land unsorted until linked to their charges.
    txn('fx-refund-1', card, addDays(today, -3), -30, 'AMAZON MKTPL*000000', 'Amazon', [
      'GENERAL_MERCHANDISE',
      'GENERAL_MERCHANDISE_OTHER',
    ]),
    txn('fx-refund-2', card, today, -15, 'TARGET 00000000', 'Target', [
      'GENERAL_MERCHANDISE',
      'GENERAL_MERCHANDISE_OTHER',
    ]),
    txn('fx-safeway', checking, addDays(today, -7), 55, 'SAFEWAY #0000 DEBIT', 'Safeway', [
      'FOOD_AND_DRINK',
      'FOOD_AND_DRINK_GROCERIES',
    ]),
    // The Safeway debit returned in full to checking — income until linked to its charge.
    txn('fx-refund-3', checking, addDays(today, -2), -55, 'SAFEWAY #0000 DEBIT', 'Safeway', [
      'FOOD_AND_DRINK',
      'FOOD_AND_DRINK_GROCERIES',
    ]),
    txn(
      'fx-pending-1',
      card,
      addDays(today, -1),
      22,
      'SWEETGREEN',
      'Sweetgreen',
      ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT'],
      {
        pending: true,
      },
    ),
  );
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || a.transaction_id.localeCompare(b.transaction_id),
  );
}

// The initial pull, split across two pages like a real /transactions/sync.
export function fixtureInitialPages(today: string): PlaidSyncResponse[] {
  const all = fixtureHistory(today);
  const mid = Math.ceil(all.length / 2);
  return [
    {
      added: all.slice(0, mid),
      modified: [],
      removed: [],
      next_cursor: 'fx-cursor-1',
      has_more: true,
    },
    {
      added: all.slice(mid),
      modified: [],
      removed: [],
      next_cursor: 'fx-cursor-2',
      has_more: false,
    },
  ];
}

// The next sync: the pending Sweetgreen charge posts (new id, pending_transaction_id → the old one,
// with a tip added), a merchant name gets enriched, and the pending row is removed.
export function fixtureUpdatePage(today: string): PlaidSyncResponse {
  const { card } = FIXTURE_ACCOUNT_IDS;
  const posted = txn(
    'fx-posted-1',
    card,
    addDays(today, -1),
    26,
    'SWEETGREEN',
    'Sweetgreen',
    ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT'],
    {
      pending_transaction_id: 'fx-pending-1',
    },
  );
  const renamed = fixtureHistory(today).find((t) => t.transaction_id === 'fx-card-2')!;
  return {
    added: [posted],
    modified: [{ ...renamed, merchant_name: `${renamed.merchant_name} Mexican Grill` }],
    removed: [{ transaction_id: 'fx-pending-1' }],
    next_cursor: 'fx-cursor-3',
    has_more: false,
  };
}

// Cursor → the page that follows it. null = the first pull; anything past the update page is empty.
export function fixturePageAfter(cursor: string | null, today: string): PlaidSyncResponse {
  const [p1, p2] = fixtureInitialPages(today) as [PlaidSyncResponse, PlaidSyncResponse];
  if (cursor === null) return p1;
  if (cursor === 'fx-cursor-1') return p2;
  if (cursor === 'fx-cursor-2') return fixtureUpdatePage(today);
  return { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false };
}
