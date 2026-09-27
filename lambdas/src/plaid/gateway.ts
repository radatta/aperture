import { FIXTURE_ACCOUNTS, FIXTURE_ITEM_ID, fixturePageAfter } from '@aperture/shared';
import type { CreateLinkTokenInput, PlaidAccount, PlaidSyncResponse } from '@aperture/shared';

// The gated external seam for Plaid — the parallel of `Writes` and the Google gateway. Every Plaid
// endpoint is a POST (reads included), so ALL of them sit behind this: a testMode/smoke request gets
// `noopPlaid` (no SSM read, no fetch), tests get `InMemoryPlaid` (replays the shared fixtures, so the
// Lambda and the stub compare end to end), and `createLivePlaid` (livePlaid.ts) is wired only in the
// Lambda entrypoints. Access tokens never leave the gateway: exchange stores one, the rest load it.

export interface PlaidItemHealth {
  errorCode: string | null; // /item/get `item.error.error_code`
  consentExpiresAt: number | null;
  consentedProducts: string[];
  lastSuccessfulUpdateAt: number | null;
  lastFailedUpdateAt: number | null;
}

export interface PlaidGateway {
  readonly environment: 'sandbox' | 'production';
  createLinkToken(input: { userId: string } & CreateLinkTokenInput): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ itemId: string }>;
  transactionsSync(
    itemId: string,
    cursor: string | null,
    count: number,
  ): Promise<PlaidSyncResponse>;
  transactionsRefresh(itemId: string): Promise<void>;
  accountsGet(itemId: string): Promise<PlaidAccount[]>;
  itemGet(itemId: string): Promise<PlaidItemHealth>;
  itemRemove(itemId: string): Promise<void>; // idempotent: an already-removed item is fine
}

// A Plaid error response, by its `error_code` (branch on that, never the message).
export class PlaidApiError extends Error {
  constructor(
    readonly code: string,
    readonly requestId: string | null = null,
    message?: string,
  ) {
    super(message ?? `Plaid error: ${code}`);
    this.name = 'PlaidApiError';
  }
}

export const HEALTHY: PlaidItemHealth = {
  errorCode: null,
  consentExpiresAt: null,
  consentedProducts: ['transactions'],
  lastSuccessfulUpdateAt: null,
  lastFailedUpdateAt: null,
};

// testMode/smoke: nothing leaves the process. Reads are empty; the calls that would create or change
// something at Plaid throw, so a write-free context never believes one happened.
export function noopPlaid(): PlaidGateway {
  const off = (): never => {
    throw new Error('Plaid side-effects are disabled in testMode');
  };
  return {
    environment: 'sandbox',
    createLinkToken: async () => off(),
    exchangePublicToken: async () => off(),
    transactionsSync: async (_itemId, cursor) => ({
      added: [],
      modified: [],
      removed: [],
      next_cursor: cursor ?? '',
      has_more: false,
    }),
    transactionsRefresh: async () => off(),
    accountsGet: async () => [],
    itemGet: async () => HEALTHY,
    itemRemove: async () => {},
  };
}

type Method = Exclude<keyof PlaidGateway, 'environment'>;

// Stateful fake: one fixture login (FIXTURE_ITEM_ID) whose transactions replay `fixturePageAfter` by
// cursor — the same pages the stub serves. `calls` records every call; `failNext` queues a
// PlaidApiError for a method; `accounts` / `health` are mutable to drive update mode and item status.
// It doesn't filter by the accounts ticked in Link: the contract ticks all three, and real Plaid only
// returns consented accounts.
export class InMemoryPlaid implements PlaidGateway {
  readonly environment = 'sandbox' as const;
  readonly tokens = new Map<string, string>(); // itemId → access token (SSM, in the live gateway)
  readonly calls: { method: Method; itemId?: string; detail?: unknown }[] = [];
  accounts: PlaidAccount[] = structuredClone(FIXTURE_ACCOUNTS);
  health: PlaidItemHealth = { ...HEALTHY };
  private readonly failures: { method: Method; code: string }[] = [];
  private seq = 0;

  constructor(private readonly opts: { today: () => string }) {}

  failNext(method: Method, code: string): void {
    this.failures.push({ method, code });
  }

  private enter(method: Method, itemId?: string, detail?: unknown): void {
    this.calls.push({ method, itemId, ...(detail === undefined ? {} : { detail }) });
    const i = this.failures.findIndex((f) => f.method === method);
    if (i >= 0) {
      const [f] = this.failures.splice(i, 1);
      throw new PlaidApiError(f!.code, `req-${++this.seq}`);
    }
    if (itemId !== undefined && !this.tokens.has(itemId))
      throw new PlaidApiError('ITEM_NOT_FOUND', `req-${++this.seq}`);
  }

  async createLinkToken(input: { userId: string } & CreateLinkTokenInput): Promise<string> {
    this.enter('createLinkToken', undefined, input);
    return `link-sandbox-${++this.seq}`;
  }
  async exchangePublicToken(publicToken: string): Promise<{ itemId: string }> {
    this.enter('exchangePublicToken', undefined, { publicToken });
    this.tokens.set(FIXTURE_ITEM_ID, `access-sandbox-${++this.seq}`);
    return { itemId: FIXTURE_ITEM_ID };
  }
  async transactionsSync(
    itemId: string,
    cursor: string | null,
    count: number,
  ): Promise<PlaidSyncResponse> {
    this.enter('transactionsSync', itemId, { cursor, count });
    return fixturePageAfter(cursor, this.opts.today());
  }
  async transactionsRefresh(itemId: string): Promise<void> {
    this.enter('transactionsRefresh', itemId);
  }
  async accountsGet(itemId: string): Promise<PlaidAccount[]> {
    this.enter('accountsGet', itemId);
    return structuredClone(this.accounts);
  }
  async itemGet(itemId: string): Promise<PlaidItemHealth> {
    this.enter('itemGet', itemId);
    return { ...this.health };
  }
  async itemRemove(itemId: string): Promise<void> {
    this.calls.push({ method: 'itemRemove', itemId });
    this.tokens.delete(itemId);
  }
}
