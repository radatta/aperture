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

// At most this many /api calls on the wire at once, FIFO. Set when dev's Lambda quota was 10 and Home's ~10 RPCs
// on a cold BFF got 429s; dev's BFF now reserves 18 (docs/ops/CI-BOT.md → Compute), and 8 still leaves room for
// the dev check's own calls. Prod has headroom and pays ~100 ms for Home's second wave.
// Mirrored by scripts/src/devcheck/scenarios/inflight-cap.ts → CAP, which counts it on dev.
export const MAX_IN_FLIGHT = 8;
// A slot is held at most this long. The BFF's Lambda times out at 15 s (CI-BOT.md → Compute; a cold start's init
// runs before that clock, inside the two spare slots), so a call still on the wire past that is a stalled
// connection, not a running function — on a phone whose signal dropped mid-load, the queue would otherwise wait
// behind it until Safari gives up, a minute or more.
export const SLOT_MS = 15_000;

// A FIFO slot limiter: acquire() resolves with the slot's release once one is free. A release hands the slot
// straight to the next waiter, so the count never dips for a queued call to miss its turn. Each grant's release
// runs once — from the holder or from the lease timer, whichever is first; the other is a no-op.
export function createLimiter(max: number, slotMs = SLOT_MS) {
  let inFlight = 0;
  const waiting: ((release: () => void) => void)[] = [];
  const grant = (): (() => void) => {
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(lease);
      const next = waiting.shift();
      if (next) next(grant());
      else inFlight--;
    };
    const lease = setTimeout(release, slotMs);
    return release;
  };
  return {
    acquire: (): Promise<() => void> => {
      if (inFlight >= max) return new Promise((r) => waiting.push(r));
      inFlight++;
      return Promise.resolve(grant());
    },
    get inFlight() {
      return inFlight;
    },
  };
}

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
  const slots = createLimiter(MAX_IN_FLIGHT);

  async function rpc(method: string, args: unknown[]): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = getToken(); // read per request — it refreshes under us
    if (token) headers[AUTH_HEADER] = `Bearer ${token}`; // custom header — survives CloudFront OAC signing
    // Each send holds a slot from request to response headers (a throw frees it too); a retry below waits out
    // its backoff with no slot and then queues again, behind whoever is waiting.
    const send = async () => {
      const release = await slots.acquire();
      try {
        return await doFetch(`${base}/api/${method}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ args }),
        });
      } finally {
        release();
      }
    };
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

  // A trailing undefined is an omitted optional param, as it is in-process: JSON would turn it into null in
  // the args array, and null means something else (setTaskActual's reflection: undefined keeps, null clears).
  const omitTrailing = (args: unknown[]) => {
    let n = args.length;
    while (n > 0 && args[n - 1] === undefined) n--;
    return args.slice(0, n);
  };
  const client: Record<string, unknown> = {};
  for (const method of API_METHODS)
    client[method] = (...args: unknown[]) => rpc(method, omitTrailing(args));
  return client as unknown as ApiClient;
}
