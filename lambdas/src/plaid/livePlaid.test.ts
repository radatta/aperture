import { describe, expect, it } from 'vitest';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { PlaidApiError } from './gateway';
import { createLivePlaid } from './livePlaid';

// No network: fetch and SSM are injected fakes. Asserts the wire shape, where secrets go, retries,
// and that no token or body ever reaches a log line.

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeSsm(initial: Record<string, string> = {}) {
  const params = new Map(Object.entries(initial));
  const gets: string[] = [];
  const ssm = {
    params,
    gets,
    send: async (cmd: unknown) => {
      if (cmd instanceof GetParameterCommand) {
        const name = cmd.input.Name!;
        gets.push(name);
        if (!params.has(name)) throw Object.assign(new Error('nope'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: params.get(name) } };
      }
      if (cmd instanceof PutParameterCommand) {
        params.set(cmd.input.Name!, cmd.input.Value!);
        return {};
      }
      if (cmd instanceof DeleteParameterCommand) {
        if (!params.has(cmd.input.Name!))
          throw Object.assign(new Error('nope'), { name: 'ParameterNotFound' });
        params.delete(cmd.input.Name!);
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return ssm;
}

const CREDS = {
  '/aperture/dev/plaid/client_id': 'cid',
  '/aperture/dev/plaid/secret': 'sec',
};

function setup(
  responses: ((c: Call) => { status: number; json: unknown })[],
  ssmInit: Record<string, string> = CREDS,
) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const fetchFake = (async (url: string, init: RequestInit) => {
    const c: Call = {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    };
    calls.push(c);
    const next = responses.shift();
    if (!next) throw new Error(`no response queued for ${url}`);
    const r = next(c);
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  const ssm = fakeSsm(ssmInit);
  const plaid = createLivePlaid({
    stage: 'dev',
    env: 'sandbox',
    fetch: fetchFake,
    ssm,
    sleep: async (ms) => void sleeps.push(ms),
    log: (l) => void logs.push(l),
  });
  return { plaid, calls, logs, sleeps, ssm };
}

const ok = (json: unknown) => () => ({ status: 200, json });
const err = (code: string, status = 400) => () => ({
  status,
  json: { error_code: code, error_message: 'x', request_id: 'req-1' },
});

describe('livePlaid', () => {
  it('sends the version and credentials headers to the environment host, creds read once', async () => {
    const { plaid, calls, ssm } = setup([ok({ link_token: 'lt-1' }), ok({ link_token: 'lt-2' })]);
    expect(await plaid.createLinkToken({ userId: 'u1', mode: 'connect' })).toBe('lt-1');
    await plaid.createLinkToken({ userId: 'u1', mode: 'connect' });
    expect(calls[0]!.url).toBe('https://sandbox.plaid.com/link/token/create');
    expect(calls[0]!.headers).toMatchObject({
      'PLAID-CLIENT-ID': 'cid',
      'PLAID-SECRET': 'sec',
      'Plaid-Version': '2020-09-14',
    });
    expect(ssm.gets.filter((n) => n.endsWith('client_id'))).toHaveLength(1);
  });

  it('connect asks for transactions with two years of history and no optional products', async () => {
    const { plaid, calls } = setup([ok({ link_token: 'lt' })]);
    await plaid.createLinkToken({ userId: 'u1', mode: 'connect' });
    expect(calls[0]!.body).toEqual({
      client_name: 'Aperture',
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: 'u1' },
      products: ['transactions'],
      transactions: { days_requested: 730 },
    });
  });

  it('update mode sends the stored access token, no products, account selection on', async () => {
    const { plaid, calls } = setup([ok({ link_token: 'lt' })], {
      ...CREDS,
      '/aperture/dev/plaid/items/item-1/access_token': 'access-1',
    });
    await plaid.createLinkToken({ userId: 'u1', mode: 'update', itemId: 'item-1' });
    expect(calls[0]!.body).toMatchObject({
      access_token: 'access-1',
      update: { account_selection_enabled: true },
    });
    expect(calls[0]!.body.products).toBeUndefined();
  });

  it('exchange stores the access token in SSM and never returns or logs it', async () => {
    const { plaid, ssm, logs, calls } = setup([
      ok({ access_token: 'access-secret-xyz', item_id: 'item-9', request_id: 'r' }),
      ok({ accounts: [] }),
    ]);
    const res = await plaid.exchangePublicToken('public-1');
    expect(res).toEqual({ itemId: 'item-9' });
    expect(ssm.params.get('/aperture/dev/plaid/items/item-9/access_token')).toBe('access-secret-xyz');
    await plaid.accountsGet('item-9'); // uses the cached token
    expect(calls[1]!.body.access_token).toBe('access-secret-xyz');
    expect(logs.join('\n')).not.toContain('access-secret-xyz');
    expect(logs.join('\n')).not.toContain('sec');
    expect(logs.join('\n')).not.toContain('public-1');
  });

  it('sync omits the cursor on the first call and passes it after', async () => {
    const page = { added: [], modified: [], removed: [], next_cursor: 'c1', has_more: false };
    const { plaid, calls } = setup([ok(page), ok(page)], {
      ...CREDS,
      '/aperture/dev/plaid/items/i/access_token': 'a',
    });
    await plaid.transactionsSync('i', null, 500);
    await plaid.transactionsSync('i', 'c0', 500);
    expect(calls[0]!.body).toEqual({ access_token: 'a', count: 500 });
    expect(calls[1]!.body).toEqual({ access_token: 'a', count: 500, cursor: 'c0' });
  });

  it('retries a transient code with backoff, then succeeds', async () => {
    const { plaid, sleeps } = setup(
      [err('INSTITUTION_NOT_RESPONDING'), err('RATE_LIMIT_EXCEEDED', 429), ok({ accounts: [] })],
      { ...CREDS, '/aperture/dev/plaid/items/i/access_token': 'a' },
    );
    expect(await plaid.accountsGet('i')).toEqual([]);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('gives up after three transient failures, and never retries a login error', async () => {
    const t = setup(
      [err('INSTITUTION_DOWN'), err('INSTITUTION_DOWN'), err('INSTITUTION_DOWN')],
      { ...CREDS, '/aperture/dev/plaid/items/i/access_token': 'a' },
    );
    await expect(t.plaid.accountsGet('i')).rejects.toMatchObject({ code: 'INSTITUTION_DOWN' });
    const l = setup([err('ITEM_LOGIN_REQUIRED')], {
      ...CREDS,
      '/aperture/dev/plaid/items/i/access_token': 'a',
    });
    const e = await l.plaid.transactionsRefresh('i').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PlaidApiError);
    expect((e as PlaidApiError).code).toBe('ITEM_LOGIN_REQUIRED');
    expect(l.calls).toHaveLength(1);
    expect(l.logs[0]).toContain('"error_code":"ITEM_LOGIN_REQUIRED"');
  });

  it('a missing token is ITEM_NOT_FOUND; missing credentials say so', async () => {
    const { plaid } = setup([]);
    await expect(plaid.accountsGet('ghost')).rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
    const bare = setup([], {});
    await expect(bare.plaid.createLinkToken({ userId: 'u', mode: 'connect' })).rejects.toThrow(
      'Plaid credentials not configured',
    );
  });

  it('item/get normalises health', async () => {
    const { plaid } = setup(
      [
        ok({
          item: {
            error: { error_code: 'ITEM_LOGIN_REQUIRED' },
            consent_expiration_time: '2027-01-01T00:00:00Z',
            consented_products: ['transactions'],
          },
          status: { transactions: { last_successful_update: '2026-09-26T10:00:00Z', last_failed_update: null } },
        }),
      ],
      { ...CREDS, '/aperture/dev/plaid/items/i/access_token': 'a' },
    );
    expect(await plaid.itemGet('i')).toEqual({
      errorCode: 'ITEM_LOGIN_REQUIRED',
      consentExpiresAt: Date.parse('2027-01-01T00:00:00Z'),
      consentedProducts: ['transactions'],
      lastSuccessfulUpdateAt: Date.parse('2026-09-26T10:00:00Z'),
      lastFailedUpdateAt: null,
    });
  });

  it('remove revokes and deletes the token; removing again is a no-op', async () => {
    const { plaid, ssm, calls } = setup([ok({ request_id: 'r' })], {
      ...CREDS,
      '/aperture/dev/plaid/items/i/access_token': 'a',
    });
    await plaid.itemRemove('i');
    expect(calls[0]!.url).toBe('https://sandbox.plaid.com/item/remove');
    expect(ssm.params.has('/aperture/dev/plaid/items/i/access_token')).toBe(false);
    await plaid.itemRemove('i'); // no token → no Plaid call, no throw
    expect(calls).toHaveLength(1);
  });

  it('a network failure surfaces as a PlaidApiError without a retry', async () => {
    const plaid = createLivePlaid({
      stage: 'dev',
      env: 'production',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      ssm: fakeSsm({ ...CREDS, '/aperture/dev/plaid/items/i/access_token': 'a' }),
      log: () => {},
    });
    expect(plaid.environment).toBe('production');
    await expect(plaid.accountsGet('i')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
