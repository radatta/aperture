// Transient-failure policy: what's worth trying again, and how long to wait between tries.

// A failed /api call, carrying the HTTP status so the policy below can tell a throttle from a refusal.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Two retries after the first try, so three in all, jittered ±20% so a burst doesn't retry in lockstep.
const BACKOFF_MS = [600, 1800];
export const retryDelayMs = (attempt: number, rand: () => number = Math.random) =>
  (BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!) * (0.8 + 0.4 * rand());
export const MAX_RETRIES = BACKOFF_MS.length;

// A 429 means Lambda refused to start the function (the account's concurrency limit), so the call never
// ran: retrying is safe for every method, writes included. The BFF never answers 429 itself, and nothing in
// front of it rate-limits. The http client retries these (httpClient.ts).
export const isThrottle = (e: unknown) => e instanceof ApiError && e.status === 429;
// The backend's `Not found: <id>` (mustTask/mustSession), a 400 whose text the http client keeps, as the
// stub's throw is: the row the call named isn't there any more.
export const isNotFound = (e: unknown) => e instanceof Error && /^Not found\b/.test(e.message);

// A 5xx or a dropped connection may have run the call, so only reads retry them (the query layer below);
// a write that might have landed must show its error, not run twice. 4xx refusals never retry.
export const isTransientRead = (e: unknown) =>
  e instanceof ApiError ? e.status >= 500 : e instanceof TypeError; // fetch rejects with TypeError offline

// React Query's `retry`: a throttle has already been retried below, so it isn't retried again here. A
// read that alternates 5xx and 429 can still reach 9 sends (3 query tries × 3 http tries) — bounded, rare.
// A TypeError thrown by a bug inside a query function also retries; it fails the same way after 3 tries.
export const retryQuery = (failureCount: number, e: unknown) =>
  failureCount < MAX_RETRIES && isTransientRead(e);
export const retryQueryDelay = (attempt: number) => retryDelayMs(attempt);
