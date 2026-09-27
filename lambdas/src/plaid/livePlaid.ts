import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { CreateLinkTokenInput, PlaidAccount, PlaidSyncResponse } from '@aperture/shared';
import { PlaidApiError } from './gateway';
import type { PlaidGateway, PlaidItemHealth } from './gateway';

// The live Plaid gateway: raw fetch against the REST API (no SDK — `plaid` is 18 MB + axios for a
// handful of POSTs) plus SSM for the client credentials and each item's access token. Wired ONLY in
// the Lambda entrypoints; testMode never reaches it.
//
// Secrets: the client id/secret and access tokens live in SSM SecureString and are held in memory for
// the warm container only. Nothing here logs a request or response body — one JSON line per call with
// the path, item id, Plaid request_id and error code, never a token.

const PLAID_VERSION = '2020-09-14';
const TIMEOUT_MS = 10_000; // under the BFF's 15 s so a hung call fails as a Plaid error, not a timeout
const RETRY_CODES = new Set([
  'RATE_LIMIT_EXCEEDED',
  'INTERNAL_SERVER_ERROR',
  'PLANNED_MAINTENANCE',
  'INSTITUTION_NOT_RESPONDING',
  'INSTITUTION_DOWN',
]);
const ATTEMPTS = 3;

type SsmLike = Pick<SSMClient, 'send'>;

export interface LivePlaidConfig {
  stage: string;
  env: 'sandbox' | 'production';
  fetch?: typeof fetch;
  ssm?: SsmLike;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

// /item/get — only the fields read here (not in plaidTypes: nothing else sees the raw shape).
interface ItemGetResponse {
  item: {
    error: { error_code: string } | null;
    consent_expiration_time: string | null;
    consented_products?: string[];
    products?: string[];
  };
  status?: {
    transactions?: {
      last_successful_update: string | null;
      last_failed_update: string | null;
    } | null;
  } | null;
}

const isoMs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
};

export function createLivePlaid(cfg: LivePlaidConfig): PlaidGateway {
  const doFetch = cfg.fetch ?? fetch;
  const ssm: SsmLike = cfg.ssm ?? new SSMClient({});
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = cfg.log ?? ((line: string) => console.log(line));
  const host = `https://${cfg.env}.plaid.com`;
  const param = (suffix: string) => `/aperture/${cfg.stage}/plaid/${suffix}`;
  const tokenParam = (itemId: string) => param(`items/${itemId}/access_token`);

  let creds: { clientId: string; secret: string } | null = null;
  const tokens = new Map<string, string>();

  async function getParam(name: string): Promise<string | null> {
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return res.Parameter?.Value ?? null;
    } catch (err) {
      if (err instanceof Error && err.name === 'ParameterNotFound') return null;
      throw err;
    }
  }
  async function getCreds(): Promise<{ clientId: string; secret: string }> {
    if (creds) return creds;
    const [clientId, secret] = await Promise.all([
      getParam(param('client_id')),
      getParam(param('secret')),
    ]);
    if (!clientId || !secret) throw new Error('Plaid credentials not configured');
    creds = { clientId, secret };
    return creds;
  }
  async function accessToken(itemId: string): Promise<string> {
    const cached = tokens.get(itemId);
    if (cached) return cached;
    const t = await getParam(tokenParam(itemId));
    if (!t) throw new PlaidApiError('ITEM_NOT_FOUND', null, `No access token for item ${itemId}`);
    tokens.set(itemId, t);
    return t;
  }

  // One Plaid POST, retried (backed off) on the codes Plaid says are transient — and, for READ calls
  // only (`network`), on a timeout or dropped connection. A write-ish call (exchange, remove, link
  // token) isn't re-sent blind after a network error; refresh (`retry: false`) is never re-sent at all:
  // it's rate-limited to 2/min per item, and the sync polls for its result anyway.
  async function post<T>(
    path: string,
    body: Record<string, unknown>,
    itemId?: string,
    opts: { retry?: boolean; network?: boolean } = {},
  ): Promise<T> {
    const retry = opts.retry ?? true;
    const { clientId, secret } = await getCreds();
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${host}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'PLAID-CLIENT-ID': clientId,
            'PLAID-SECRET': secret,
            'Plaid-Version': PLAID_VERSION,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        const code =
          err instanceof Error && err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
        log(
          JSON.stringify({
            event: 'plaid_call',
            path,
            itemId,
            ok: false,
            error_code: code,
            attempt,
          }),
        );
        if (!retry || !opts.network || attempt >= ATTEMPTS)
          throw new PlaidApiError(code, null, `Plaid ${path} failed: ${code}`);
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const requestId = typeof json.request_id === 'string' ? json.request_id : null;
      if (res.ok) {
        log(JSON.stringify({ event: 'plaid_call', path, itemId, ok: true, request_id: requestId }));
        return json as T;
      }
      const code = typeof json.error_code === 'string' ? json.error_code : `HTTP_${res.status}`;
      log(
        JSON.stringify({
          event: 'plaid_call',
          path,
          itemId,
          ok: false,
          request_id: requestId,
          error_code: code,
          attempt,
        }),
      );
      if (!retry || !RETRY_CODES.has(code) || attempt >= ATTEMPTS)
        throw new PlaidApiError(code, requestId);
      await sleep(500 * 2 ** (attempt - 1));
    }
  }

  return {
    environment: cfg.env,

    async createLinkToken(input: { userId: string } & CreateLinkTokenInput) {
      const base = {
        client_name: 'Aperture',
        language: 'en',
        country_codes: ['US'],
        user: { client_user_id: input.userId },
      };
      const body =
        input.mode === 'update'
          ? {
              ...base,
              access_token: await accessToken(input.itemId),
              update: { account_selection_enabled: true },
            }
          : { ...base, products: ['transactions'], transactions: { days_requested: 730 } };
      const res = await post<{ link_token: string }>('/link/token/create', body);
      return res.link_token;
    },

    async exchangePublicToken(publicToken: string) {
      const res = await post<{ access_token: string; item_id: string }>(
        '/item/public_token/exchange',
        { public_token: publicToken },
      );
      await ssm.send(
        new PutParameterCommand({
          Name: tokenParam(res.item_id),
          Value: res.access_token,
          Type: 'SecureString',
          Overwrite: true,
        }),
      );
      tokens.set(res.item_id, res.access_token);
      return { itemId: res.item_id };
    },

    async transactionsSync(itemId: string, cursor: string | null, count: number) {
      const res = await post<PlaidSyncResponse>(
        '/transactions/sync',
        {
          access_token: await accessToken(itemId),
          count,
          ...(cursor ? { cursor } : {}), // omit on the first call
        },
        itemId,
        { network: true },
      );
      return {
        added: res.added ?? [],
        modified: res.modified ?? [],
        removed: res.removed ?? [],
        next_cursor: res.next_cursor ?? '',
        has_more: res.has_more === true,
        ...(res.transactions_update_status
          ? { transactions_update_status: res.transactions_update_status }
          : {}),
      };
    },

    async transactionsRefresh(itemId: string) {
      await post('/transactions/refresh', { access_token: await accessToken(itemId) }, itemId, {
        retry: false,
      });
    },

    async accountsGet(itemId: string): Promise<PlaidAccount[]> {
      const res = await post<{ accounts: PlaidAccount[] }>(
        '/accounts/get',
        { access_token: await accessToken(itemId) },
        itemId,
        { network: true },
      );
      return res.accounts ?? [];
    },

    async itemGet(itemId: string): Promise<PlaidItemHealth> {
      const res = await post<ItemGetResponse>(
        '/item/get',
        { access_token: await accessToken(itemId) },
        itemId,
        { network: true },
      );
      const tx = res.status?.transactions;
      return {
        errorCode: res.item.error?.error_code ?? null,
        consentExpiresAt: isoMs(res.item.consent_expiration_time),
        consentedProducts: res.item.consented_products ?? res.item.products ?? [],
        lastSuccessfulUpdateAt: isoMs(tx?.last_successful_update),
        lastFailedUpdateAt: isoMs(tx?.last_failed_update),
      };
    },

    // Revoke at Plaid, then forget the token. Either half already done is fine.
    async itemRemove(itemId: string) {
      let token: string | null = null;
      try {
        token = await accessToken(itemId);
      } catch (err) {
        if (!(err instanceof PlaidApiError && err.code === 'ITEM_NOT_FOUND')) throw err;
      }
      if (token) {
        try {
          await post('/item/remove', { access_token: token }, itemId);
        } catch (err) {
          if (!(err instanceof PlaidApiError && err.code === 'ITEM_NOT_FOUND')) throw err;
        }
      }
      try {
        await ssm.send(new DeleteParameterCommand({ Name: tokenParam(itemId) }));
      } catch (err) {
        if (!(err instanceof Error && err.name === 'ParameterNotFound')) throw err;
      }
      tokens.delete(itemId);
    },
  };
}
