import { API_METHODS, AUTH_HEADER } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { getAuthToken, notifyUnauthorized } from '../auth/tokenStore';
import { ApiError, MAX_RETRIES, retryDelayMs } from './retry';

// The minimal fetch surface we use — narrow enough that the global `fetch` satisfies it and a test can
// inject an in-process handler in its place.
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

// The HTTP implementation of ApiClient: each method is one RPC — POST /api/<method> with the positional
// args as the JSON body, the JSON response as the return value. Built from the shared API_METHODS list
// (the same list the handler validates against), so client and server can never drift.
export function createHttpClient(
  base: string,
  fetchImpl?: FetchLike,
  getToken: () => string | null = getAuthToken,
  onUnauthorized: () => void = notifyUnauthorized,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): ApiClient {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));

  async function rpc(method: string, args: unknown[]): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = getToken(); // read per request — it refreshes under us
    if (token) headers[AUTH_HEADER] = `Bearer ${token}`; // custom header — survives CloudFront OAC signing
    const send = () =>
      doFetch(`${base}/api/${method}`, { method: 'POST', headers, body: JSON.stringify({ args }) });
    let res = await send();
    // A 429 never ran (retry.ts → isThrottle), so every method retries it, writes included.
    for (let i = 0; res.status === 429 && i < MAX_RETRIES; i++) {
      await sleep(retryDelayMs(i));
      res = await send();
    }
    if (res.status === 401) onUnauthorized(); // session is gone server-side — re-auth, don't just fail
    if (!res.ok)
      throw new ApiError((await refusal(res)) ?? `${method} failed (${res.status})`, res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  // A 400 is the backend refusing (index.ts: `{ error }` — "Part 2 isn’t finished…"), worded for the
  // user, so it's what the UI shows, as the stub's throw is. Anything else keeps the generic line.
  async function refusal(res: { status: number; text: () => Promise<string> }) {
    if (res.status !== 400) return null;
    try {
      const { error } = JSON.parse(await res.text()) as { error?: unknown };
      return typeof error === 'string' && error ? error : null;
    } catch {
      return null;
    }
  }

  const client: Record<string, unknown> = {};
  for (const method of API_METHODS) client[method] = (...args: unknown[]) => rpc(method, args);
  return client as unknown as ApiClient;
}
